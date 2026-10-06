"""The live data spine: streams in, prioritized polling, storage, push to UI."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

import yaml

from .adapters import dexscreener as dsx
from .adapters import feeds
from .adapters.coinbase import Coinbase
from .adapters.dexscreener import DexScreener
from .adapters.geckoterminal import GeckoTerminal
from .adapters.market import Market
from .adapters.pumpportal import PumpPortal
from .adapters.rugcheck import RugCheck
from .config import settings
from .db import DB
from .detect import detect
from .hub import hub

log = logging.getLogger("radar.tracker")

TOKEN_SUMMARY_SQL = """
SELECT t.address, t.chain, t.name, t.symbol, t.image, t.source, t.launched_at, t.first_seen, t.graduated_at,
       t.boost_amount, t.has_profile, t.pump_mcap_sol, t.pump_mcap_as_of, t.deployer,
       p.pair_address, p.dex, p.url, p.price_usd, p.liquidity_usd, p.fdv, p.market_cap,
       p.vol_m5, p.vol_h1, p.vol_h6, p.vol_h24, p.buys_m5, p.sells_m5, p.buys_h1, p.sells_h1,
       p.buys_h24, p.sells_h24, p.chg_m5, p.chg_h1, p.chg_h6, p.chg_h24, p.pair_created_at, p.as_of,
       s.score_normalised AS rug_score, s.mint_authority, s.freeze_authority, s.lp_locked_pct, s.top10_pct,
       s.holders, s.rugged, s.as_of AS safety_as_of
FROM tokens t
LEFT JOIN pairs p ON p.pair_address = t.best_pair
LEFT JOIN safety_reports s ON s.token_address = t.address
"""


def _sources_cfg() -> dict[str, Any]:
    for p in (Path("../config/sources.yaml"), Path("config/sources.yaml"), Path("/app/config/sources.yaml")):
        if p.exists():
            return yaml.safe_load(p.read_text()) or {}
    return {}


class Tracker:
    def __init__(self, db: DB) -> None:
        self.db = db
        self.dex = DexScreener()
        self.gecko = GeckoTerminal()
        self.rug = RugCheck()
        self.market = Market()
        self.pump = PumpPortal(self.on_create, self.on_trade, self.on_migrate)
        self.coinbase = Coinbase(self.on_tick)
        self.sol_usd: float | None = None
        self.trending_set: set[str] = set()
        self.boosted_set: set[str] = set()
        self.rug_queue: asyncio.Queue[str] = asyncio.Queue()
        self.rug_pending: set[str] = set()
        self.tasks: list[asyncio.Task] = []
        for c in (self.dex.http, self.gecko.http, self.rug.http):
            c.on_request = self._usage

    # ---------- lifecycle ----------
    def start(self) -> None:
        jobs = [self.pump.run(), self.coinbase.run(), self.scheduler(), self.rug_worker(), self.trade_subs_loop(),
                self.every(settings.gecko_trending_every, self.poll_gecko_trending),
                self.every(settings.gecko_new_every, self.poll_gecko_new, delay=7),
                self.every(settings.dex_profiles_every, self.poll_dex_profiles, delay=3),
                self.every(600, self.poll_fear_greed), self.every(600, self.poll_llama, delay=5),
                self.every(180, self.poll_cg_trending, delay=11), self.every(600, self.poll_cg_meme, delay=40),
                self.every(60, self.poll_polymarket, delay=2), self.every(120, self.poll_kalshi, delay=9),
                self.every(3600, self.prune, delay=60)]
        cfg = _sources_cfg().get("rss") or {}
        for i, f in enumerate(cfg.get("feeds") or []):
            jobs.append(self.every(float(f.get("every_s") or cfg.get("every_s") or 60),
                                   lambda f=f: self.poll_feed(f), delay=i * 2))
        self.tasks = [asyncio.create_task(j) for j in jobs]

    async def stop(self) -> None:
        self.pump.stop()
        self.coinbase.stop()
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    async def every(self, seconds: float, fn, delay: float = 0) -> None:
        await asyncio.sleep(delay)
        while True:
            try:
                await fn()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - adapters record their own health; keep looping
                log.debug("job %s failed: %s", getattr(fn, "__name__", fn), e)
            await asyncio.sleep(seconds)

    def _usage(self, adapter: str, path: str, status: int, ms: float) -> None:
        asyncio.get_running_loop().create_task(
            self.db.exec("INSERT INTO api_usage (ts, adapter, path, status, latency_ms) VALUES (?,?,?,?,?)",
                         (time.time(), adapter, path.split("?")[0][:120], status, ms)))

    # ---------- streams ----------
    async def on_tick(self, tick: dict[str, Any]) -> None:
        if tick["symbol"] == "SOL":
            self.sol_usd = tick["price"]
        await self.db.upsert("market", {"key": f"px_{tick['symbol']}", "value": tick["price"], "source": "coinbase",
                                        "as_of": tick["as_of"], "data_json": json.dumps(tick)}, "key")
        await hub.publish("tick", tick)

    async def on_create(self, m: dict[str, Any]) -> None:
        now = time.time()
        mint = m.get("mint")
        if not mint:
            return
        row = {"address": mint, "chain": "solana", "name": m.get("name"), "symbol": m.get("symbol"),
               "uri": m.get("uri"), "deployer": m.get("traderPublicKey"), "source": "pumpportal",
               "launched_at": now, "first_seen": now, "pump_mcap_sol": m.get("marketCapSol"),
               "pump_mcap_as_of": now, "updated": now}
        await self.db.upsert("tokens", row, "address")
        await hub.publish("launch", {**row, "initial_buy_sol": m.get("solAmount"), "pool": m.get("pool"),
                                     "mcap_usd": self._usd(m.get("marketCapSol")), "signature": m.get("signature")})

    async def on_trade(self, m: dict[str, Any]) -> None:
        now = time.time()
        mint = m.get("mint")
        trade = {"mint": mint, "ts": now, "side": m.get("txType"), "sol": m.get("solAmount"),
                 "tokens": m.get("tokenAmount"), "trader": m.get("traderPublicKey"),
                 "mcap_sol": m.get("marketCapSol"), "signature": m.get("signature")}
        await self.db.exec("INSERT OR IGNORE INTO pump_trades (mint, ts, side, sol, tokens, trader, mcap_sol, signature) "
                           "VALUES (?,?,?,?,?,?,?,?)", list(trade.values()))
        if m.get("marketCapSol") is not None:
            await self.db.exec("UPDATE tokens SET pump_mcap_sol=?, pump_mcap_as_of=? WHERE address=?",
                               (m.get("marketCapSol"), now, mint))
        await hub.publish("trade", {**trade, "usd": self._usd(m.get("solAmount")), "mcap_usd": self._usd(m.get("marketCapSol"))})

    async def on_migrate(self, m: dict[str, Any]) -> None:
        mint = m.get("mint")
        if not mint:
            return
        now = time.time()
        await self.db.upsert("tokens", {"address": mint, "chain": "solana", "source": "pumpportal",
                                        "first_seen": now, "graduated_at": now, "graduated_pool": m.get("pool"),
                                        "updated": now}, "address")
        await self.db.exec("UPDATE tokens SET graduated_at=COALESCE(graduated_at, ?) WHERE address=?", (now, mint))
        self.queue_rug(mint)
        tok = await self.token_summary(mint)
        await hub.publish("graduated", tok or {"address": mint, "graduated_at": now})

    def _usd(self, sol: Any) -> float | None:
        try:
            return round(float(sol) * self.sol_usd, 2) if self.sol_usd and sol is not None else None
        except (TypeError, ValueError):
            return None

    # ---------- priority scheduler for DexScreener ----------
    async def universe(self) -> dict[str, tuple[int, str]]:
        """address -> (tier, chain). Lower tier = hotter = refreshed more often."""
        now = time.time()
        out: dict[str, tuple[int, str]] = {}

        def put(addr: str, tier: int, chain: str = "solana") -> None:
            if addr and (addr not in out or out[addr][0] > tier):
                out[addr] = (tier, chain)

        for r in await self.db.all("SELECT address, chain FROM tokens WHERE first_seen > ? AND source='pumpportal'",
                                   (now - settings.launch_track_minutes * 60,)):
            put(r["address"], 3, r["chain"])
        hot_since = now - settings.hot_track_hours * 3600
        for r in await self.db.all(
                "SELECT t.address, t.chain FROM tokens t LEFT JOIN pairs p ON p.pair_address=t.best_pair "
                "WHERE t.graduated_at > ? OR (t.first_seen > ? AND (t.boost_amount > 0 OR t.has_profile=1 "
                "OR t.source='geckoterminal' OR p.vol_m5 > 2000))", (hot_since, hot_since)):
            put(r["address"], 2, r["chain"])
        for a in self.trending_set | self.boosted_set:
            row = await self.db.one("SELECT chain FROM tokens WHERE address=?", (a,))
            put(a, 2, (row or {}).get("chain") or "solana")
        for r in await self.db.all("SELECT w.address, COALESCE(t.chain,'solana') chain FROM watchlist w "
                                   "LEFT JOIN tokens t ON t.address=w.address"):
            put(r["address"], 1, r["chain"])
        for a in hub.viewed_tokens():
            row = await self.db.one("SELECT chain FROM tokens WHERE address=?", (a,))
            put(a, 0, (row or {}).get("chain") or "solana")
        return out

    async def scheduler(self) -> None:
        last: dict[str, float] = {}
        while True:
            try:
                uni = await self.universe()
                now = time.time()
                due = [(tier, now - last.get(a, 0), a, chain) for a, (tier, chain) in uni.items()
                       if now - last.get(a, 0) >= settings.tier_intervals[tier]]
                if not due:
                    await asyncio.sleep(0.5)
                    continue
                due.sort(key=lambda d: (d[0], -d[1]))
                chain = due[0][3]
                batch = [a for _, _, a, c in due if c == chain][: dsx.BATCH]
                for a in batch:
                    last[a] = now
                await self.refresh(chain, batch)
                for a in list(last):
                    if a not in uni:
                        del last[a]
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.debug("scheduler: %s", e)
                await asyncio.sleep(2)

    async def refresh(self, chain: str, addrs: list[str]) -> None:
        pairs = await self.dex.tokens(chain, addrs)
        now = time.time()
        best: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
        for p in pairs:
            row = dsx.parse_pair(p, now)
            tok = row["token_address"]
            if tok not in addrs or not row["pair_address"]:
                continue
            await self.db.upsert("pairs", row, "pair_address")
            if tok not in best or (row["liquidity_usd"] or 0) > (best[tok][0]["liquidity_usd"] or 0):
                best[tok] = (row, dsx.token_meta(p))
        for tok, (row, meta) in best.items():
            await self.db.exec(
                "UPDATE tokens SET best_pair=?, last_refresh=?, updated=?, name=COALESCE(name, ?), symbol=COALESCE(symbol, ?), "
                "image=COALESCE(?, image), links_json=COALESCE(?, links_json), launched_at=COALESCE(launched_at, ?) WHERE address=?",
                (row["pair_address"], now, now, meta["name"], meta["symbol"], meta["image"],
                 json.dumps(meta["links"]) if meta["links"] else None, row["pair_created_at"], tok))
            await self.db.exec("INSERT INTO price_ticks (token_address, ts, source, price_usd, market_cap, liquidity_usd, vol_h1) "
                               "VALUES (?,?,?,?,?,?,?)", (tok, now, "dexscreener", row["price_usd"],
                                                          row["market_cap"] or row["fdv"], row["liquidity_usd"], row["vol_h1"]))
        if best:
            rows = await self.db.all(TOKEN_SUMMARY_SQL + f" WHERE t.address IN ({','.join('?' * len(best))})", list(best))
            await hub.publish("tokens", rows)

    # ---------- REST polls ----------
    async def _ensure_token(self, address: str, chain: str, name: str | None, symbol: str | None,
                            image: str | None, source: str, launched_at: float | None = None) -> None:
        now = time.time()
        await self.db.exec(
            "INSERT INTO tokens (address, chain, name, symbol, image, source, first_seen, launched_at, updated) "
            "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET "
            "name=COALESCE(tokens.name, excluded.name), symbol=COALESCE(tokens.symbol, excluded.symbol), "
            "image=COALESCE(tokens.image, excluded.image)",
            (address, chain, name, symbol, image, source, now, launched_at, now))

    async def _store_trending(self, source: str, lst: str, rows: list[dict[str, Any]], key: str = "token_address") -> None:
        now = time.time()
        await self.db.exec("DELETE FROM trending WHERE source=? AND list=?", (source, lst))
        await self.db.many("INSERT INTO trending (source, list, rank, token_address, pool_address, name, symbol, data_json, as_of) "
                           "VALUES (?,?,?,?,?,?,?,?,?)",
                           [(source, lst, i + 1, r.get(key), r.get("pool_address"), r.get("name") or r.get("question") or r.get("title"),
                             r.get("symbol"), json.dumps(r), now) for i, r in enumerate(rows)])
        await hub.publish("trending", {"source": source, "list": lst, "as_of": now, "rows": rows})

    async def poll_gecko_trending(self) -> None:
        rows = await self.gecko.trending_pools()
        self.trending_set = {r["token_address"] for r in rows if r["token_address"]}
        for r in rows:
            if r["token_address"]:
                await self._ensure_token(r["token_address"], "solana", r["name"], r["symbol"], r["image"],
                                         "geckoterminal", r["pool_created_at"])
                if r["token_address"] not in self.rug_pending:
                    self.queue_rug(r["token_address"], only_if_missing=True)
        await self._store_trending("geckoterminal", "trending", rows)

    async def poll_gecko_new(self) -> None:
        await self._store_trending("geckoterminal", "new", await self.gecko.new_pools())

    async def poll_dex_profiles(self) -> None:
        # rotate across the three 60 rpm endpoints
        self._rot = (getattr(self, "_rot", -1) + 1) % 3
        if self._rot == 0:
            rows = await self.dex.profiles_latest()
            for r in rows:
                if r.get("tokenAddress"):
                    await self._ensure_token(r["tokenAddress"], r.get("chainId") or "solana", None, None, r.get("icon"), "dexscreener")
                    await self.db.exec("UPDATE tokens SET has_profile=1, links_json=COALESCE(links_json, ?) WHERE address=?",
                                       (json.dumps({"websites": [], "socials": r.get("links") or []}), r["tokenAddress"]))
            await self._store_trending("dexscreener", "profiles", [
                {"token_address": r.get("tokenAddress"), "chain": r.get("chainId"), "url": r.get("url"),
                 "icon": r.get("icon"), "description": (r.get("description") or "")[:200]} for r in rows])
        else:
            lst = "boosts_latest" if self._rot == 1 else "boosts_top"
            rows = await (self.dex.boosts_latest() if self._rot == 1 else self.dex.boosts_top())
            for r in rows:
                if r.get("tokenAddress"):
                    await self._ensure_token(r["tokenAddress"], r.get("chainId") or "solana", None, None, r.get("icon"), "dexscreener")
                    await self.db.exec("UPDATE tokens SET boost_amount=? WHERE address=?",
                                       (r.get("totalAmount") or r.get("amount"), r["tokenAddress"]))
            self.boosted_set = {r["tokenAddress"] for r in rows if r.get("tokenAddress")} | (self.boosted_set if self._rot == 2 else set())
            await self._store_trending("dexscreener", lst, [
                {"token_address": r.get("tokenAddress"), "chain": r.get("chainId"), "url": r.get("url"),
                 "amount": r.get("amount"), "total_amount": r.get("totalAmount")} for r in rows])

    async def _market(self, key: str, value: float | None, data: dict[str, Any] | None) -> None:
        if data is None:
            return
        row = {"key": key, "value": value, "source": data.get("source"), "as_of": data.get("as_of") or time.time(),
               "data_json": json.dumps(data)}
        await self.db.upsert("market", row, "key")
        await hub.publish("market", {"key": key, **data})

    async def poll_fear_greed(self) -> None:
        d = await self.market.fear_greed()
        await self._market("fear_greed", d and d["value"], d)

    async def poll_llama(self) -> None:
        d = await self.market.solana_dex_volume()
        await self._market("sol_dex_volume", d and d["total24h"], d)

    async def poll_cg_meme(self) -> None:
        d = await self.market.coingecko_meme_category()
        await self._market("meme_category", d and d["market_cap"], d)

    async def poll_cg_trending(self) -> None:
        await self._store_trending("coingecko", "trending", await self.market.coingecko_trending(), key="id")

    async def poll_polymarket(self) -> None:
        await self._store_trending("polymarket", "top", await self.market.polymarket_top(), key="id")

    async def poll_kalshi(self) -> None:
        await self._store_trending("kalshi", "top", await self.market.kalshi_top(), key="ticker")

    async def poll_feed(self, f: dict[str, Any]) -> None:
        rows = await feeds.fetch(f["url"], f["name"])
        fresh = []
        for r in rows:
            if await self.db.one("SELECT 1 FROM news WHERE id=?", (r["id"],)):
                continue
            await self.db.exec("INSERT OR IGNORE INTO news (id, source, title, link, published, fetched) VALUES (?,?,?,?,?,?)",
                               (r["id"], r["source"], r["title"], r["link"], r["published"], r["fetched"]))
            fresh.append({**r, "group": f.get("group"), "detected": detect(r["title"])})
        if fresh:
            await hub.publish("news", fresh)

    # ---------- safety ----------
    def queue_rug(self, mint: str, only_if_missing: bool = False) -> None:
        if mint in self.rug_pending:
            return
        self.rug_pending.add(mint)
        self.rug_queue.put_nowait(f"{'?' if only_if_missing else ''}{mint}")

    async def rug_worker(self) -> None:
        while True:
            item = await self.rug_queue.get()
            mint = item.lstrip("?")
            try:
                cur = await self.db.one("SELECT as_of FROM safety_reports WHERE token_address=?", (mint,))
                fresh = cur and time.time() - cur["as_of"] < settings.rugcheck_cache_s
                if not (fresh or (item.startswith("?") and cur)):
                    rep = await self.rug.report(mint)
                    if rep:
                        await self.db.upsert("safety_reports", rep, "token_address")
                        await hub.publish("safety", {**rep, "risks": json.loads(rep["risks_json"])})
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.debug("rugcheck %s: %s", mint, e)
            finally:
                self.rug_pending.discard(mint)

    async def trade_subs_loop(self) -> None:
        while True:
            try:
                want: list[str] = list(hub.viewed_tokens())
                want += [r["address"] for r in await self.db.all("SELECT address FROM watchlist")]
                want += [r["address"] for r in await self.db.all(
                    "SELECT t.address FROM tokens t LEFT JOIN pairs p ON p.pair_address=t.best_pair "
                    "WHERE t.source='pumpportal' AND (t.graduated_at > ? OR t.first_seen > ?) "
                    "ORDER BY COALESCE(p.vol_m5,0) DESC LIMIT ?", (time.time() - 3600, time.time() - 600,
                                                                  settings.max_trade_subscriptions))]
                await self.pump.set_token_trades(set(dict.fromkeys(want).keys()))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.debug("trade subs: %s", e)
            await asyncio.sleep(10)

    async def prune(self) -> None:
        cut = time.time() - settings.retention_hours * 3600
        await self.db.exec("DELETE FROM price_ticks WHERE ts < ?", (cut,))
        await self.db.exec("DELETE FROM pump_trades WHERE ts < ?", (cut,))
        await self.db.exec("DELETE FROM api_usage WHERE ts < ?", (cut,))
        await self.db.exec("DELETE FROM news WHERE fetched < ?", (cut,))
        await self.db.exec("DELETE FROM tokens WHERE first_seen < ? AND best_pair IS NULL AND address NOT IN (SELECT address FROM watchlist)",
                           (time.time() - 24 * 3600,))

    async def token_summary(self, address: str) -> dict[str, Any] | None:
        return await self.db.one(TOKEN_SUMMARY_SQL + " WHERE t.address=?", (address,))
