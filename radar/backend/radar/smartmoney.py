"""Smart-money & KOL wallets: discover consistently-early profitable wallets from observed pump.fun trades,
follow them live (PumpPortal subscribeAccountTrade; Helius history when connected), flag shill-and-dump."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import httpx

from .health import Health, register
from .hub import hub

log = logging.getLogger("radar.smart")
helius_h = register(Health("helius", "rest", "Helius: tracked-wallet swap history (fills gaps beyond pump.fun)"))
helius_h.stale_after = 900


class SmartMoney:
    def __init__(self, db: Any, cfg: Any, tracker: Any, alerts: Any, connectors: Any) -> None:
        self.db, self.cfg, self.tracker, self.alerts, self.connectors = db, cfg, tracker, alerts, connectors
        self.tracked: dict[str, dict[str, Any]] = {}
        self.traders: Any = None

    async def load(self) -> None:
        for w in self.cfg.watch.get("kol_wallets") or []:
            await self.db.exec("INSERT INTO wallets (address, label, kind, handle, tracked, updated) VALUES (?,?,?,?,1,?) "
                               "ON CONFLICT(address) DO UPDATE SET kind='kol', handle=excluded.handle, tracked=1",
                               (w["address"], w.get("label") or w.get("handle"), "kol", w.get("handle"), time.time()))
        for w in self.cfg.watch.get("smart_wallets") or []:
            addr = w["address"] if isinstance(w, dict) else w
            await self.db.exec("INSERT INTO wallets (address, label, kind, tracked, updated) VALUES (?,?,?,1,?) "
                               "ON CONFLICT(address) DO UPDATE SET tracked=1", (addr, (w.get("label") if isinstance(w, dict) else None),
                                                                                "smart", time.time()))
        await self.refresh_tracked()

    async def refresh_tracked(self) -> None:
        rows = await self.db.all("SELECT * FROM wallets WHERE tracked=1 ORDER BY kind='kol' DESC, score DESC LIMIT 200")
        self.tracked = {r["address"]: r for r in rows}
        if self.traders is not None:   # Top Traders owns the single account-trade subscription set
            self.traders.extra_live = set(self.tracked)
            await self.traders.refresh_live()
        else:
            await self.tracker.pump.set_account_trades(set(self.tracked))

    async def on_trade(self, t: dict[str, Any]) -> None:
        w = self.tracked.get(t.get("trader") or "")
        if not w:
            return
        await self.db.exec("INSERT OR IGNORE INTO wallet_trades (wallet, mint, ts, side, sol, tokens, mcap_sol, signature) "
                           "VALUES (?,?,?,?,?,?,?,?)", (w["address"], t["mint"], t["ts"], t["side"], t["sol"], t["tokens"],
                                                        t["mcap_sol"], t["signature"]))
        await self.tracker._ensure_token(t["mint"], "solana", None, None, None, "smart_money")
        await hub.publish("wallet_trade", {**t, "wallet": w["address"], "label": w.get("label"), "kind": w["kind"],
                                           "score": w.get("score")})
        if w["kind"] == "kol" and t["side"] == "sell":
            await self.check_shill(w, t["mint"])
        elif w["kind"] == "smart" and t["side"] == "buy" and (w.get("score") or 0) >= self.cfg.scoring["smart_money"]["wallet_min_score"]:
            n = await self.smart_buyers(t["mint"])
            if n >= 2:
                await self.alerts.send("info", f"🧠 {n} smart wallets buying", f"Tracked profitable wallets are buying {t['mint'][:6]}…",
                                       token=t["mint"], dedupe=f"smart:{t['mint']}:{n}", ttl=3600)

    async def check_shill(self, w: dict[str, Any], mint: str) -> bool:
        if not w.get("handle"):
            return False
        since = time.time() - 1800
        posts = await self.db.all("SELECT id, text, url FROM social_events WHERE author_id LIKE ? AND ts > ? AND "
                                  "(cas_json LIKE ? OR text LIKE ?)", (f"%:{w['handle']}", since, f"%{mint}%", f"%{mint[:8]}%"))
        sells = await self.db.one("SELECT COUNT(*) n FROM wallet_trades WHERE wallet=? AND mint=? AND side='sell' AND ts > ?",
                                  (w["address"], mint, since))
        if posts and sells["n"]:
            await self.alerts.send("rug", f"🚩 Shill-and-dump: {w['handle']} is selling a token they're posting",
                                   f"{sells['n']} sells in 30m while posting: {posts[0]['url'] or ''}", token=mint,
                                   dedupe=f"shill:{w['address']}:{mint}", ttl=3600)
            await self.db.exec("INSERT OR REPLACE INTO kv (key, value, updated) VALUES (?,?,?)",
                               (f"shill:{mint}", json.dumps({"wallet": w["address"], "handle": w["handle"]}), time.time()))
            return True
        return False

    async def smart_buyers(self, mint: str, hours: float = 1) -> int:
        r = await self.db.one("SELECT COUNT(DISTINCT wt.wallet) n FROM wallet_trades wt JOIN wallets w ON w.address=wt.wallet "
                              "WHERE wt.mint=? AND wt.side='buy' AND wt.ts > ? AND w.kind='smart' AND COALESCE(w.score,0) >= ?",
                              (mint, time.time() - hours * 3600, self.cfg.scoring["smart_money"]["wallet_min_score"]))
        return r["n"] or 0

    async def input_for(self, mint: str) -> dict[str, Any]:
        shill = await self.db.one("SELECT 1 FROM kv WHERE key=? AND updated > ?", (f"shill:{mint}", time.time() - 6 * 3600))
        ranked = await self.traders.smart_input(mint) if self.traders is not None else {"tracking": False, "smart_buyers": 0}
        return {"tracking": bool(self.tracked) or ranked["tracking"],
                "smart_buyers": await self.smart_buyers(mint) + ranked["smart_buyers"], "kol_selling": bool(shill)}

    async def discover(self) -> int:
        """Score wallets that bought early (first 15 min of trading we observed) into tokens that later ran."""
        now = time.time()
        since = now - 3 * 86400
        firsts = {r["mint"]: r for r in await self.db.all(
            "SELECT mint, MIN(ts) t0, MAX(mcap_sol) peak FROM pump_trades WHERE ts > ? GROUP BY mint HAVING COUNT(*) >= 20", (since,))}
        stats: dict[str, dict[str, Any]] = {}
        for mint, f in firsts.items():
            if now - f["t0"] < 3600:
                continue  # need at least an hour to judge the outcome
            buys = await self.db.all("SELECT trader, MIN(ts) ts, MIN(mcap_sol) mc FROM pump_trades WHERE mint=? AND side='buy' "
                                     "AND ts <= ? GROUP BY trader", (mint, f["t0"] + 900))
            for b in buys:
                if not b["trader"] or not b["mc"]:
                    continue
                peak_after = await self.db.one("SELECT MAX(mcap_sol) m FROM pump_trades WHERE mint=? AND ts > ?", (mint, b["ts"]))
                mult = (peak_after["m"] or b["mc"]) / b["mc"]
                sell = await self.db.one("SELECT MIN(ts) t FROM pump_trades WHERE mint=? AND trader=? AND side='sell'", (mint, b["trader"]))
                s = stats.setdefault(b["trader"], {"wins": 0, "losses": 0, "mults": [], "holds": [], "tokens": 0})
                s["tokens"] += 1
                s["mults"].append(min(mult, 50))
                s["wins" if mult >= 3 else "losses"] += 1
                if sell["t"]:
                    s["holds"].append(sell["t"] - b["ts"])
        n = 0
        for addr, s in stats.items():
            if s["tokens"] < 3:
                continue
            wr = s["wins"] / s["tokens"]
            avg = sum(s["mults"]) / len(s["mults"])
            score = round(wr * 60 + min(avg, 10) * 4, 1)
            tracked = 1 if score >= self.cfg.scoring["smart_money"]["wallet_min_score"] and s["wins"] >= 2 else 0
            await self.db.exec(
                "INSERT INTO wallets (address, kind, score, wins, losses, avg_multiple, avg_hold_s, tokens, tracked, updated) "
                "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET score=excluded.score, wins=excluded.wins, "
                "losses=excluded.losses, avg_multiple=excluded.avg_multiple, avg_hold_s=excluded.avg_hold_s, tokens=excluded.tokens, "
                "tracked=MAX(tracked, excluded.tracked), updated=excluded.updated",
                (addr, "smart", score, s["wins"], s["losses"], round(avg, 2),
                 sum(s["holds"]) / len(s["holds"]) if s["holds"] else None, s["tokens"], tracked, now))
            n += tracked
        await self.refresh_tracked()
        return n

    async def helius_loop(self) -> None:
        """With a Helius key, pull parsed SWAP history for tracked wallets (catches Raydium/Jupiter trades too)."""
        i = 0
        async with httpx.AsyncClient(timeout=20) as client:
            while True:
                try:
                    key = (await self.connectors.values("helius")).get("api_key")
                    wallets = list(self.tracked)
                    if key and wallets:
                        addr = wallets[i % len(wallets)]
                        i += 1
                        t0 = time.perf_counter()
                        r = await client.get(f"https://api.helius.xyz/v0/addresses/{addr}/transactions",
                                             params={"api-key": key, "type": "SWAP", "limit": 20})
                        if r.status_code == 429:
                            helius_h.fail("429", rate_limited=True)
                            await asyncio.sleep(30)
                            continue
                        r.raise_for_status()
                        helius_h.ok((time.perf_counter() - t0) * 1000)
                        for tx in r.json():
                            for tt in tx.get("tokenTransfers") or []:
                                mint = tt.get("mint")
                                if not mint or mint.startswith("So1111"):
                                    continue
                                side = "buy" if tt.get("toUserAccount") == addr else "sell" if tt.get("fromUserAccount") == addr else None
                                if side:
                                    await self.on_trade({"mint": mint, "ts": float(tx.get("timestamp") or time.time()), "side": side,
                                                         "sol": None, "tokens": tt.get("tokenAmount"), "trader": addr,
                                                         "mcap_sol": None, "signature": f"{tx.get('signature')}:{mint}"})
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    helius_h.fail(f"{type(e).__name__}: {e}")
                await asyncio.sleep(3)
