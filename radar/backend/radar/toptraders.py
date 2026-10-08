"""Top traders from outside Radar's own pump.fun stream, feeding the Top wallets leaderboard.

- GeckoTerminal (no key): the last 300 trades of each of the hottest SOL-quoted pools (PumpSwap, Raydium, Meteora, pump.fun).
  These go into the same P&L ledger as PumpPortal trades, so graduated coins count too. Signatures dedupe across sources.
- Birdeye (key on the Connectors page): its own Solana trader leaderboards (today, yesterday, 1 week by P&L) and the top
  traders of the hottest tokens. Stored per source in wallet_external and followed live alongside Radar's own ranking.

No usable API (deep links only): pump.fun (no public leaderboard endpoint), Axiom, GMGN, Photon, BullX, and DexScreener's
"Top traders" tab (website only; the public DexScreener API has no trader data).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import httpx

from .health import Health, register

log = logging.getLogger("radar.toptraders")
birdeye_h = register(Health("birdeye", "rest", "Birdeye: Solana trader leaderboards and per-token top traders (key)"))
birdeye_h.stale_after = 7200
gtrades_h = register(Health("gecko_trades", "rest", "GeckoTerminal pool trades: wallets trading graduated coins (no key)"))
gtrades_h.stale_after = 900

BIRDEYE_URL = "https://public-api.birdeye.so"
BIRDEYE_PERIODS = {"today": "today", "yesterday": "yesterday", "1W": "7d"}

DEFAULTS: dict[str, Any] = {
    "gecko_pools": 40,          # hottest SOL pools whose trades are pulled
    "gecko_every_s": 20,        # one pool per tick (~3 calls/min, inside GeckoTerminal's shared 30/min)
    "birdeye_pages": 30,        # 10 traders per page per leaderboard (Birdeye's max) -> 300 per period
    "birdeye_every_s": 3600,
    "birdeye_token_traders": 20,  # hot tokens whose top traders are pulled each round
    "follow_external": 300,     # of the followed wallets, this many come from the external leaderboards
}


def cfg_of(cfg: Any) -> dict[str, Any]:
    return {**DEFAULTS, **(((getattr(cfg, "scoring", None) or {}).get("leaderboard") or {}).get("sources") or {})}


def parse_gainers(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Birdeye /trader/gainers-losers -> [{wallet, pnl_usd, volume_usd, trades}]."""
    items = ((payload or {}).get("data") or {}).get("items") or []
    return [{"wallet": i.get("address"), "pnl_usd": i.get("pnl"), "volume_usd": i.get("volume"), "trades": i.get("trade_count")}
            for i in items if i.get("address")]


def parse_token_traders(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Birdeye /defi/v2/tokens/top_traders -> [{wallet, volume_usd, trades, tags}]."""
    items = ((payload or {}).get("data") or {}).get("items") or []
    return [{"wallet": i.get("owner"), "volume_usd": i.get("volume"), "trades": i.get("trade"), "tags": i.get("tags") or []}
            for i in items if i.get("owner") and "bot" not in (i.get("tags") or [])]


class TopTraders:
    def __init__(self, db: Any, cfg: Any, tracker: Any, board: Any, connectors: Any) -> None:
        self.db, self.cfg, self.tracker, self.board, self.connectors = db, cfg, tracker, board, connectors
        self.pool_i = 0
        self.pool_last: dict[str, float] = {}  # pool -> newest trade ts already ingested
        self.client = httpx.AsyncClient(timeout=15, headers={"Accept": "application/json", "x-chain": "solana"})

    # ---------- GeckoTerminal ----------
    async def hot_pools(self, n: int) -> list[dict[str, Any]]:
        return await self.db.all(
            "SELECT p.pair_address pool, p.token_address token FROM pairs p WHERE p.chain='solana' AND p.quote_symbol IN "
            "('SOL','WSOL') AND p.as_of > ? ORDER BY COALESCE(p.vol_h1,0) DESC LIMIT ?", (time.time() - 3600, n))

    async def gecko_tick(self) -> int:
        pools = await self.hot_pools(int(cfg_of(self.cfg)["gecko_pools"]))
        if not pools:
            return 0
        p = pools[self.pool_i % len(pools)]
        self.pool_i += 1
        trades = await self.tracker.gecko.trades(p["pool"], p["token"])
        gtrades_h.ok(0)
        last = self.pool_last.get(p["pool"], 0)
        new = sorted((t for t in trades if t["ts"] and t["ts"] > last), key=lambda t: t["ts"])
        for t in new:
            await self.board.on_trade(t)
        if new:
            self.pool_last[p["pool"]] = new[-1]["ts"]
            await self.db.exec("INSERT OR REPLACE INTO kv (key, value, updated) VALUES ('toptraders:pool_last', ?, ?)",
                               (json.dumps(self.pool_last), time.time()))
        return len(new)

    # ---------- Birdeye ----------
    async def birdeye(self, path: str, params: dict[str, Any], key: str) -> dict[str, Any] | None:
        t0 = time.perf_counter()
        r = await self.client.get(BIRDEYE_URL + path, params=params, headers={"X-API-KEY": key})
        if r.status_code == 429:
            birdeye_h.fail("429", rate_limited=True)
            await asyncio.sleep(30)
            return None
        if r.status_code >= 400:
            birdeye_h.fail(f"HTTP {r.status_code}: {r.text[:120]}")
            return None
        birdeye_h.ok((time.perf_counter() - t0) * 1000)
        await asyncio.sleep(1.1)  # free tier is ~1 request/second
        return r.json()

    async def birdeye_round(self) -> int:
        key = (await self.connectors.values("birdeye")).get("api_key")
        if not key:
            return 0
        c = cfg_of(self.cfg)
        now, n = time.time(), 0
        for btype, period in BIRDEYE_PERIODS.items():
            rows: list[dict[str, Any]] = []
            for page in range(int(c["birdeye_pages"])):
                data = await self.birdeye("/trader/gainers-losers", {"type": btype, "sort_by": "PnL", "sort_type": "desc",
                                                                     "offset": page * 10, "limit": 10}, key)
                got = parse_gainers(data or {})
                rows += got
                if len(got) < 10:
                    break
            if rows:
                await self.store("birdeye", period, rows, now)
                n += len(rows)
        token_rows: dict[str, dict[str, Any]] = {}
        for p in await self.hot_pools(int(c["birdeye_token_traders"])):
            data = await self.birdeye("/defi/v2/tokens/top_traders", {"address": p["token"], "time_frame": "24h",
                                                                      "sort_type": "desc", "sort_by": "volume",
                                                                      "offset": 0, "limit": 10}, key)
            for r in parse_token_traders(data or {}):
                prev = token_rows.get(r["wallet"])
                if not prev or (r["volume_usd"] or 0) > (prev["volume_usd"] or 0):
                    token_rows[r["wallet"]] = {**r, "pnl_usd": None, "token": p["token"]}
        if token_rows:
            await self.store("birdeye", "hot_tokens", sorted(token_rows.values(), key=lambda r: -(r["volume_usd"] or 0)), now)
            n += len(token_rows)
        return n

    async def store(self, source: str, period: str, rows: list[dict[str, Any]], now: float) -> None:
        await self.db.exec("DELETE FROM wallet_external WHERE source=? AND period=?", (source, period))
        await self.db.many("INSERT OR REPLACE INTO wallet_external (source, period, wallet, rank, pnl_usd, volume_usd, trades, "
                           "token, as_of) VALUES (?,?,?,?,?,?,?,?,?)",
                           [(source, period, r["wallet"], i + 1, r.get("pnl_usd"), r.get("volume_usd"), r.get("trades"),
                             r.get("token"), now) for i, r in enumerate(rows)])

    async def external_follow(self) -> dict[str, dict[str, Any]]:
        """Best external rank per wallet, capped at follow_external, for the leaderboard's follow set."""
        n = int(cfg_of(self.cfg)["follow_external"])
        rows = await self.db.all("SELECT wallet, source, period, MIN(rank) rank, MAX(pnl_usd) pnl_usd FROM wallet_external "
                                 "WHERE as_of > ? GROUP BY wallet ORDER BY rank, pnl_usd DESC LIMIT ?",
                                 (time.time() - 3 * 86400, n))
        return {r["wallet"]: r for r in rows}

    # ---------- loops ----------
    async def run(self) -> None:
        row = await self.db.one("SELECT value FROM kv WHERE key='toptraders:pool_last'")
        if row:
            self.pool_last = json.loads(row["value"])
        await asyncio.gather(self._loop(self.gecko_tick, "gecko_every_s", gtrades_h),
                             self._loop(self.birdeye_round, "birdeye_every_s", birdeye_h, delay=30))

    async def _loop(self, fn: Any, every_key: str, h: Health, delay: float = 0) -> None:
        await asyncio.sleep(delay)
        while True:
            try:
                await fn()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                h.fail(f"{type(e).__name__}: {e}")
                log.debug("%s: %s", fn.__name__, e)
            await asyncio.sleep(float(cfg_of(self.cfg)[every_key]))
