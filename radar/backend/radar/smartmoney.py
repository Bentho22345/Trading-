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
helius_h = register(Health("helius", "rest", "Helius: live swaps of followed & top wallets beyond pump.fun (budgeted)"))
helius_h.stale_after = 900


class SmartMoney:
    def __init__(self, db: Any, cfg: Any, tracker: Any, alerts: Any, connectors: Any) -> None:
        self.db, self.cfg, self.tracker, self.alerts, self.connectors = db, cfg, tracker, alerts, connectors
        self.tracked: dict[str, dict[str, Any]] = {}
        self.traders: Any = None
        self.also_follow: dict[str, dict[str, Any]] = {}  # leaderboard wallets -> {rank, period, roi}
        self.top_seen: dict[str, None] = {}
        self.push_times: list[float] = []
        self.helius: Any = None

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
            self.traders.extra_live = set(self.tracked) | set(self.also_follow)
            await self.traders.refresh_live()
        else:
            await self.tracker.pump.set_account_trades(set(self.tracked) | set(self.also_follow))

    async def on_trade(self, t: dict[str, Any]) -> None:
        trader = t.get("trader") or ""
        if trader in self.also_follow:
            await self.on_top_trade(t, self.also_follow[trader])
        w = self.tracked.get(trader)
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

    async def on_top_trade(self, t: dict[str, Any], top: dict[str, Any]) -> None:
        """A top-1000 wallet traded: record it (chart markers), flash it in the UI, push big ones, FLASH on clusters."""
        sig = t.get("signature") or f"{t.get('trader')}:{t.get('mint')}:{t.get('ts')}"
        if sig in self.top_seen or t.get("side") not in ("buy", "sell") or not t.get("mint"):
            return  # one trade can arrive on both the token and the account subscription
        self.top_seen[sig] = None
        if len(self.top_seen) > 20_000:
            self.top_seen = dict.fromkeys(list(self.top_seen)[-5_000:])
        wallet, mint = t["trader"], t["mint"]
        await self.db.exec("INSERT OR IGNORE INTO wallets (address, label, kind, tracked, updated) VALUES (?,?,'top',0,?)",
                           (wallet, f"Top #{top['rank']} {top['period']}", time.time()))
        await self.db.exec("INSERT OR IGNORE INTO wallet_trades (wallet, mint, ts, side, sol, tokens, mcap_sol, signature) "
                           "VALUES (?,?,?,?,?,?,?,?)", (wallet, mint, t["ts"], t["side"], t.get("sol"), t.get("tokens"),
                                                        t.get("mcap_sol"), sig))
        await self.tracker._ensure_token(mint, "solana", None, None, None, "smart_money")
        tok = await self.db.one("SELECT symbol, name, image FROM tokens WHERE address=?", (mint,)) or {}
        msg = {**t, "signature": sig, "wallet": wallet, "rank": top["rank"], "period": top["period"], "roi": top["roi"],
               "symbol": tok.get("symbol"), "name": tok.get("name"), "image": tok.get("image"),
               "usd": self.tracker._usd(t.get("sol")), "mcap_usd": self.tracker._usd(t.get("mcap_sol"))}
        await hub.publish("top_trade", msg)
        await hub.publish("wallet_trade", {**msg, "label": f"Top #{top['rank']}", "kind": "top"})
        f = (self.cfg.scoring.get("leaderboard") or {}).get("flash") or {}
        sym = tok.get("symbol") or mint[:6] + "…"
        sol = float(t.get("sol") or 0)
        now = time.time()
        self.push_times = [x for x in self.push_times if x > now - 60]
        if f.get("push", True) and sol >= float(f.get("push_min_sol", 1.0)) and len(self.push_times) < int(f.get("push_max_per_min", 12)):
            self.push_times.append(now)
            roi = f" ({top['roi'] * 100:+.0f}% {top['period']})" if top.get("roi") is not None else ""
            await self.alerts.send("wallet", f"{'🟢' if t['side'] == 'buy' else '🔴'} Top #{top['rank']} wallet {t['side']}s {sym}",
                                   f"{sol:.2f} SOL · wallet {wallet[:4]}…{wallet[-4:]}{roi}", token=mint, dedupe=f"top:{sig}")
        if t["side"] == "buy":
            await self.top_cluster(mint, sym, int(f.get("cluster_wallets", 3)), float(f.get("cluster_minutes", 10)))

    async def top_cluster(self, mint: str, sym: str, need: int, minutes: float) -> None:
        rows = await self.db.all("SELECT DISTINCT wallet FROM wallet_trades WHERE mint=? AND side='buy' AND ts > ?",
                                 (mint, time.time() - minutes * 60))
        wallets = [r["wallet"] for r in rows if r["wallet"] in self.also_follow]
        if len(wallets) < need:
            return
        key = f"topcluster:{mint}:{len(wallets)}"
        if not await self.alerts.send("flash", f"⚡ {len(wallets)} top wallets buying {sym}",
                                      f"{len(wallets)} of the top-1000 wallets bought within {minutes:.0f} minutes", token=mint,
                                      dedupe=key, ttl=6 * 3600):
            return
        top = sorted((self.also_follow[w] | {"wallet": w} for w in wallets), key=lambda m: m["rank"])
        await hub.publish("flash", {"kind": "top_cluster", "token_address": mint, "symbol": sym, "wallets": top[:10],
                                    "minutes": minutes, "ts": time.time()})

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
        """Live swaps of followed / top wallets anywhere on Solana (Raydium, Jupiter, Meteora…), not just pump.fun.

        Cheap by design: one 1-credit `getSignaturesForAddress(until=last seen)` per wallet check, and a 1-credit
        `getTransaction` only for signatures that are actually new — instead of a 100-credit Enhanced call every few
        seconds. The check rate adapts to the Helius budget's 'smart' share."""
        from .helius import BudgetExceeded, wallet_swaps
        last: dict[str, str] = {}
        i = 0
        while True:
            hl = self.helius
            wait = 15.0
            try:
                wallets = list(self.tracked) + [w for w, _ in sorted(self.also_follow.items(), key=lambda p: p[1].get("rank") or 9999)][:60]
                wallets = list(dict.fromkeys(wallets))
                if hl is None or not hl.enabled or not wallets:
                    await asyncio.sleep(30)
                    continue
                share = hl.daily * 0.30
                wait = max(3.0, 86400 / max(1.0, share * 0.6))        # ~60% of the share on checks, the rest on parsing new txs
                addr = wallets[i % len(wallets)]
                i += 1
                opts: dict[str, Any] = {"limit": 10}
                if addr in last:
                    opts["until"] = last[addr]
                sigs = await hl.rpc("getSignaturesForAddress", [addr, opts], "smart") or []
                helius_h.ok()
                if sigs:
                    first_look = addr not in last
                    last[addr] = sigs[0]["signature"]
                    if not first_look:                                 # first look only sets the cursor: no history spend
                        for sg in reversed(sigs[:5]):
                            if sg.get("err") is not None:
                                continue
                            tx = await hl.rpc("getTransaction", [sg["signature"], {"encoding": "jsonParsed",
                                                                                   "maxSupportedTransactionVersion": 0}], "smart")
                            if not tx:
                                continue
                            legs = wallet_swaps(tx, addr)
                            for lg in legs:
                                await self.on_trade({"mint": lg["mint"], "ts": float(tx.get("blockTime") or time.time()), "side": lg["side"],
                                                     "sol": lg["sol"], "tokens": lg["tokens"], "trader": addr, "mcap_sol": None,
                                                     "signature": sg["signature"] if len(legs) == 1 else f"{sg['signature']}:{lg['mint']}"})
            except asyncio.CancelledError:
                raise
            except BudgetExceeded:
                wait = 60.0
            except Exception as e:  # noqa: BLE001
                helius_h.fail(f"{type(e).__name__}: {e}")
            await asyncio.sleep(wait)
