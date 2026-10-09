"""Candles for the token chart.

Two real sources, merged:
  * GeckoTerminal OHLCV for the coin's best pool (always asking for *this* token's side of the pool, in USD);
  * Radar's own pump.fun trade stream (PumpPortal), valued at the SOL/USD price at the moment of each trade.
    It covers bonding-curve coins GeckoTerminal hasn't indexed yet, and it is seconds fresher than GeckoTerminal,
    so it supplies the live tail of every chart.

Responses are cached and served stale-while-revalidate: a chart never waits on GeckoTerminal twice.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .adapters.geckoterminal import TIMEFRAMES
from .adapters.http import UpstreamError

log = logging.getLogger("radar.charts")

TF_SECONDS = {tf: {"minute": 60, "hour": 3600, "day": 86400}[u] * agg for tf, (u, agg) in TIMEFRAMES.items()}
PUMP_SUPPLY = 1e9
FRESH_S = 12          # serve from cache without revalidating
MAX_AGE_S = 600       # beyond this, wait for a fresh fetch instead of showing an old chart


def bucket_trades(trades: list[dict[str, Any]], tf_s: int, fallback_sol_usd: float | None) -> list[dict[str, float]]:
    """pump.fun trades (ascending) -> USD OHLCV candles. price = market cap (SOL) / 1B supply × SOL/USD at the trade."""
    out: dict[int, dict[str, float]] = {}
    for t in trades:
        mc, px_sol = t.get("mcap_sol"), t.get("sol_usd") or fallback_sol_usd
        if not mc or not px_sol:
            continue
        p = mc / PUMP_SUPPLY * px_sol
        b = int(t["ts"] // tf_s * tf_s)
        vol = (t.get("sol") or 0) * px_sol
        c = out.get(b)
        if c is None:
            out[b] = {"time": b, "open": p, "high": p, "low": p, "close": p, "volume": vol}
        else:
            c["high"], c["low"], c["close"] = max(c["high"], p), min(c["low"], p), p
            c["volume"] += vol
    rows = [out[b] for b in sorted(out)]
    # each candle opens where the previous one closed, so gaps between buckets don't draw phantom wicks
    for prev, cur in zip(rows, rows[1:]):
        cur["open"] = prev["close"]
        cur["high"], cur["low"] = max(cur["high"], cur["open"]), min(cur["low"], cur["open"])
    return rows


def merge(gecko: list[dict[str, float]], live: list[dict[str, float]]) -> list[dict[str, float]]:
    """GeckoTerminal history + Radar's live tail. Where both have a bucket, extend GeckoTerminal's bar with the
    trades it hasn't indexed yet; buckets after GeckoTerminal's last bar come from the live stream alone."""
    if not gecko:
        return live
    if not live:
        return gecko
    by = {c["time"]: dict(c) for c in gecko}
    last = gecko[-1]["time"]
    for c in live:
        g = by.get(c["time"])
        if g is not None:
            if c["time"] == last:   # GeckoTerminal's newest bar is still forming; fold in our newer trades
                g["high"], g["low"], g["close"] = max(g["high"], c["high"]), min(g["low"], c["low"]), c["close"]
                g["volume"] = max(g["volume"], c["volume"])
        elif c["time"] > last:
            by[c["time"]] = dict(c)
    rows = [by[t] for t in sorted(by)]
    for prev, cur in zip(rows, rows[1:]):
        if cur["time"] > last and prev["time"] >= last:
            cur["open"] = prev["close"]
            cur["high"], cur["low"] = max(cur["high"], cur["open"]), min(cur["low"], cur["open"])
    return rows


class Charts:
    def __init__(self, db: Any, tracker: Any) -> None:
        self.db, self.tracker = db, tracker
        self.cache: dict[tuple[str, str], tuple[float, list[dict[str, float]]]] = {}
        self.inflight: dict[tuple[str, str], asyncio.Task] = {}

    async def _gecko(self, pool: str, tf: str, chain: str, token: str) -> list[dict[str, float]]:
        key = (pool, tf)
        task = self.inflight.get(key)
        if task is None:
            async def run() -> list[dict[str, float]]:
                try:
                    candles = await self.tracker.gecko.ohlcv(pool, tf, network=chain, token=token)
                    self.cache[key] = (time.time(), candles)
                    if len(self.cache) > 500:
                        for k in sorted(self.cache, key=lambda k: self.cache[k][0])[:100]:
                            self.cache.pop(k, None)
                    return candles
                finally:
                    self.inflight.pop(key, None)
            task = self.inflight[key] = asyncio.create_task(run())
        return await task

    async def gecko_cached(self, pool: str, tf: str, chain: str, token: str) -> tuple[list[dict[str, float]], float | None, bool]:
        """(candles, as_of, stale). Fresh cache: instant. Older cache: instant, refreshed in the background."""
        hit = self.cache.get((pool, tf))
        age = time.time() - hit[0] if hit else None
        if hit and age < FRESH_S:
            return hit[1], hit[0], False
        if hit and age < MAX_AGE_S:
            if (pool, tf) not in self.inflight:
                t = asyncio.create_task(self._gecko(pool, tf, chain, token))
                t.add_done_callback(lambda f: f.exception())   # failures are recorded by adapter health
            return hit[1], hit[0], False
        try:
            c = await self._gecko(pool, tf, chain, token)
            return c, time.time(), False
        except UpstreamError:
            if hit:
                return hit[1], hit[0], True
            raise

    async def live_candles(self, mint: str, tf: str, since: float) -> list[dict[str, float]]:
        rows = await self.db.all("SELECT ts, sol, mcap_sol, sol_usd FROM pump_trades WHERE mint=? AND ts >= ? ORDER BY ts",
                                 (mint, since))
        return bucket_trades(rows, TF_SECONDS.get(tf, 300), self.tracker.sol_usd)

    async def ohlcv(self, address: str, tf: str = "5m") -> dict[str, Any]:
        tf = tf if tf in TF_SECONDS else "5m"
        tf_s = TF_SECONDS[tf]
        tok = await self.db.one("SELECT t.best_pair, t.chain, t.source, p.price_usd, p.market_cap, p.fdv FROM tokens t "
                                "LEFT JOIN pairs p ON p.pair_address=t.best_pair WHERE t.address=?", (address,))
        if not tok:
            return {"candles": [], "pool": None, "as_of": None, "source": None, "tf_s": tf_s}
        gecko, as_of, stale, err = [], None, False, None
        if tok["best_pair"]:
            try:
                gecko, as_of, stale = await self.gecko_cached(tok["best_pair"], tf, tok["chain"] or "solana", address)
            except UpstreamError as e:
                err = str(e)
        since = (gecko[-1]["time"] if gecko else time.time() - 300 * tf_s)
        live = await self.live_candles(address, tf, since)
        candles = merge(gecko, live)
        src = "+".join(s for s, c in (("geckoterminal", gecko), ("pumpportal", live)) if c) or None
        if not candles and err:
            raise UpstreamError(err)
        # circulating supply for the market-cap view: DEX market cap / price, or pump.fun's fixed 1B
        supply = None
        if tok["price_usd"] and (tok["market_cap"] or tok["fdv"]):
            supply = (tok["market_cap"] or tok["fdv"]) / tok["price_usd"]
        elif tok["source"] == "pumpportal":
            supply = PUMP_SUPPLY
        return {"candles": candles, "pool": tok["best_pair"], "as_of": as_of or (time.time() if live else None),
                "source": src, "stale": stale, "tf_s": tf_s, "supply": supply, "live_from": live[0]["time"] if live else None}
