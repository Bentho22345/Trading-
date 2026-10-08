"""Top-wallet leaderboard: per-wallet P&L from every pump.fun trade Radar observes, ranked by 1d / 7d / 30d returns.

Every trade on the PumpPortal stream carries the trader, SOL in/out and token amount, so Radar keeps an average-cost ledger
per (wallet, token). A sell realizes `sol_out - cost_basis_of_tokens_sold`; return = realized P&L / cost basis closed.
Sells of tokens bought before Radar was watching have no known basis and are counted as `unmatched_sol`, never as profit.
Raw trades are pruned after RETENTION_HOURS, so P&L is rolled into hourly (48h) and daily (35d) buckets that outlive them.

The top `follow` wallets are subscribed on PumpPortal (subscribeAccountTrade), so their trades on any pump.fun token are
captured from then on, which makes the leaderboard's own numbers more complete over time.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from .health import Health, register

log = logging.getLogger("radar.leaderboard")
board_h = register(Health("leaderboard", "rest", "Top-wallet leaderboard (1d / 7d / 30d returns from observed trades)"))
board_h.stale_after = 1800

HOUR, DAY = 3600, 86400
PERIODS = {"1d": (HOUR, DAY), "7d": (DAY, 7 * DAY), "30d": (DAY, 30 * DAY)}  # period -> (bucket span, window)
EPS = 1e-9

DEFAULTS: dict[str, Any] = {
    "size": 1000,              # ranked wallets kept per period
    "follow": 1000,            # top wallets subscribed live on PumpPortal
    "min_basis_sol": {"1d": 0.5, "7d": 2, "30d": 5},   # cost basis closed in the window to qualify
    "min_closes": {"1d": 2, "7d": 3, "30d": 5},        # profitable-or-not exits in the window to qualify
    "bot_trades_per_day": 400,  # above this, the wallet is flagged as a bot and left out unless asked for
    "refresh_s": 300,
}


def _cfg(cfg: Any) -> dict[str, Any]:
    out = {**DEFAULTS, **((getattr(cfg, "scoring", None) or {}).get("leaderboard") or {})}
    for k in ("min_basis_sol", "min_closes"):
        out[k] = {**DEFAULTS[k], **(out.get(k) or {})}
    return out


class Leaderboard:
    def __init__(self, db: Any, cfg: Any, smart: Any = None) -> None:
        self.db, self.cfg, self.smart = db, cfg, smart
        self.queue: list[dict[str, Any]] = []
        self.followed: set[str] = set()
        self.seen: dict[str, None] = {}  # signatures already applied (account + token subscriptions can both deliver a trade)

    # ---------- ingest ----------
    async def on_trade(self, t: dict[str, Any]) -> None:
        if t.get("trader") and t.get("mint") and t.get("side") in ("buy", "sell"):
            self.queue.append(t)

    async def flush(self) -> int:
        batch, self.queue = self.queue, []
        if not batch:
            return 0
        conn = self.db.conn
        n = 0
        for t in batch:
            sig = t.get("signature")
            if sig:
                if sig in self.seen:
                    continue
                self.seen[sig] = None
            try:
                sol, tokens = float(t.get("sol") or 0), float(t.get("tokens") or 0)
            except (TypeError, ValueError):
                continue
            if sol <= 0 or tokens <= 0:
                continue
            await self._apply(conn, t["trader"], t["mint"], t["side"], sol, tokens, float(t.get("ts") or time.time()))
            n += 1
        await conn.commit()
        if len(self.seen) > 200_000:
            self.seen = dict.fromkeys(list(self.seen)[-50_000:])
        return n

    async def _apply(self, conn: Any, wallet: str, mint: str, side: str, sol: float, tokens: float, ts: float) -> None:
        async with conn.execute("SELECT qty, cost_sol FROM wallet_positions WHERE wallet=? AND mint=?", (wallet, mint)) as cur:
            row = await cur.fetchone()
        qty, cost = (row[0], row[1]) if row else (0.0, 0.0)
        realized = basis = unmatched = 0.0
        win = loss = 0
        if side == "buy":
            qty, cost = qty + tokens, cost + sol
        else:
            matched = min(tokens, qty)
            if matched > EPS:
                basis = cost * matched / qty
                proceeds = sol * matched / tokens
                realized = proceeds - basis
                qty, cost = qty - matched, cost - basis
                win, loss = (1, 0) if realized > 0 else (0, 1)
                if qty < EPS:
                    qty, cost = 0.0, 0.0
            unmatched = sol * (tokens - matched) / tokens if tokens > matched else 0.0
        await conn.execute(
            "INSERT INTO wallet_positions (wallet, mint, qty, cost_sol, bought_sol, sold_sol, realized_sol, first_ts, last_ts) "
            "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(wallet, mint) DO UPDATE SET qty=excluded.qty, cost_sol=excluded.cost_sol, "
            "bought_sol=bought_sol+excluded.bought_sol, sold_sol=sold_sol+excluded.sold_sol, "
            "realized_sol=realized_sol+excluded.realized_sol, last_ts=excluded.last_ts",
            (wallet, mint, qty, cost, sol if side == "buy" else 0.0, sol if side == "sell" else 0.0, realized, ts, ts))
        for span in (HOUR, DAY):
            await conn.execute(
                "INSERT INTO wallet_pnl (wallet, span, bucket, realized_sol, basis_sol, bought_sol, sold_sol, unmatched_sol, "
                "trades, wins, losses) VALUES (?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(wallet, span, bucket) DO UPDATE SET "
                "realized_sol=realized_sol+excluded.realized_sol, basis_sol=basis_sol+excluded.basis_sol, "
                "bought_sol=bought_sol+excluded.bought_sol, sold_sol=sold_sol+excluded.sold_sol, "
                "unmatched_sol=unmatched_sol+excluded.unmatched_sol, trades=trades+1, wins=wins+excluded.wins, "
                "losses=losses+excluded.losses",
                (wallet, span, int(ts // span) * span, realized, basis, sol if side == "buy" else 0.0,
                 sol if side == "sell" else 0.0, unmatched, win, loss))

    async def backfill(self) -> int:
        """First start: replay the raw pump.fun trades still in the DB (up to RETENTION_HOURS) into the ledger."""
        if await self.db.one("SELECT 1 FROM wallet_pnl LIMIT 1"):
            return 0
        rows = await self.db.all("SELECT mint, ts, side, sol, tokens, trader, signature FROM pump_trades ORDER BY ts")
        self.queue = [*rows, *self.queue]
        n = await self.flush()
        if rows:
            await self._mark_since(rows[0]["ts"])
        return n

    async def _mark_since(self, ts: float) -> None:
        await self.db.exec("INSERT OR IGNORE INTO kv (key, value, updated) VALUES ('leaderboard:since', ?, ?)",
                           (json.dumps(ts), time.time()))

    # ---------- ranking ----------
    async def marks(self) -> dict[str, float]:
        """mint -> current price in SOL per token: DexScreener SOL-quoted pair first, else the pump.fun curve (1B supply)."""
        rows = await self.db.all(
            "SELECT DISTINCT p.mint, CASE WHEN pr.quote_symbol IN ('SOL','WSOL') THEN pr.price_native END pn, t.pump_mcap_sol mc "
            "FROM wallet_positions p LEFT JOIN tokens t ON t.address=p.mint LEFT JOIN pairs pr ON pr.pair_address=t.best_pair "
            "WHERE p.qty > 0")
        out: dict[str, float] = {}
        for r in rows:
            px = r["pn"] if r["pn"] else (r["mc"] / 1e9 if r["mc"] else None)
            if px:
                out[r["mint"]] = float(px)
        return out

    async def open_pnl(self) -> dict[str, dict[str, float]]:
        marks = await self.marks()
        out: dict[str, dict[str, float]] = {}
        for r in await self.db.all("SELECT wallet, mint, qty, cost_sol FROM wallet_positions WHERE qty > 0"):
            o = out.setdefault(r["wallet"], {"unrealized_sol": 0.0, "open_cost_sol": 0.0, "unpriced_cost_sol": 0.0})
            px = marks.get(r["mint"])
            if px is None:
                o["unpriced_cost_sol"] += r["cost_sol"]
            else:
                o["unrealized_sol"] += r["qty"] * px - r["cost_sol"]
                o["open_cost_sol"] += r["cost_sol"]
        return out

    async def refresh(self) -> dict[str, int]:
        await self.flush()
        c = _cfg(self.cfg)
        now = time.time()
        opens = await self.open_pnl()
        counts: dict[str, int] = {}
        ranks: dict[str, dict[str, int]] = {}
        for period, (span, window) in PERIODS.items():
            since = int(now // span) * span - (window // span - 1) * span  # e.g. 1d = this hour + the 23 before it
            rows = await self.db.all(
                "SELECT wallet, SUM(realized_sol) realized_sol, SUM(basis_sol) basis_sol, SUM(bought_sol) bought_sol, "
                "SUM(sold_sol) sold_sol, SUM(unmatched_sol) unmatched_sol, SUM(trades) trades, SUM(wins) wins, "
                "SUM(losses) losses, COUNT(*) active_buckets FROM wallet_pnl WHERE span=? AND bucket>=? GROUP BY wallet "
                "HAVING SUM(basis_sol) >= ? AND SUM(wins)+SUM(losses) >= ?",
                (span, since, c["min_basis_sol"][period], c["min_closes"][period]))
            for r in rows:
                days = r["active_buckets"] if span == DAY else 1  # trades per active day, so one frantic day still flags
                r["roi"] = r["realized_sol"] / r["basis_sol"] if r["basis_sol"] > EPS else None
                closes = r["wins"] + r["losses"]
                r["win_rate"] = r["wins"] / closes if closes else None
                r["bot"] = 1 if r["trades"] / days > c["bot_trades_per_day"] else 0
                r.update(opens.get(r["wallet"]) or {"unrealized_sol": 0.0, "open_cost_sol": 0.0, "unpriced_cost_sol": 0.0})
            clean = [r for r in rows if not r["bot"]]
            by_roi = sorted(clean, key=lambda r: (-(r["roi"] or 0), -r["realized_sol"]))
            by_pnl = sorted(clean, key=lambda r: -r["realized_sol"])
            for i, r in enumerate(by_roi):
                r["rank_roi"] = i + 1
            for i, r in enumerate(by_pnl):
                r["rank_pnl"] = i + 1
            keep = {r["wallet"] for r in by_roi[: c["size"]]} | {r["wallet"] for r in by_pnl[: c["size"]]}
            keep |= {r["wallet"] for r in sorted((r for r in rows if r["bot"]), key=lambda r: -(r["roi"] or 0))[: 100]}
            out = [r for r in rows if r["wallet"] in keep]
            await self.db.conn.execute("DELETE FROM wallet_board WHERE period=?", (period,))
            await self.db.conn.executemany(
                "INSERT INTO wallet_board (period, wallet, rank_roi, rank_pnl, roi, realized_sol, basis_sol, bought_sol, sold_sol, "
                "unmatched_sol, trades, wins, losses, win_rate, active_buckets, bot, unrealized_sol, open_cost_sol, "
                "unpriced_cost_sol, as_of) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [(period, r["wallet"], r.get("rank_roi"), r.get("rank_pnl"), r["roi"], r["realized_sol"], r["basis_sol"],
                  r["bought_sol"], r["sold_sol"], r["unmatched_sol"], r["trades"], r["wins"], r["losses"], r["win_rate"],
                  r["active_buckets"], r["bot"], r["unrealized_sol"], r["open_cost_sol"], r["unpriced_cost_sol"], now)
                 for r in out])
            await self.db.conn.commit()
            counts[period] = len(clean)
            for r in clean:
                ranks.setdefault(r["wallet"], {})[period] = r["rank_roi"]
        await self._follow(ranks, c["follow"])
        await self.db.exec("INSERT OR REPLACE INTO kv (key, value, updated) VALUES ('leaderboard:last', ?, ?)",
                           (json.dumps(counts), now))
        board_h.ok(0)
        return counts

    async def _follow(self, ranks: dict[str, dict[str, int]], n: int) -> None:
        """Follow the best wallets across periods: rank by each wallet's best ROI rank in 1d / 7d / 30d."""
        best = sorted(ranks, key=lambda w: min(ranks[w].values()))
        self.followed = set(best[:n])
        if self.smart is not None:
            self.smart.also_follow = self.followed
            await self.smart.refresh_tracked()

    async def prune(self) -> None:
        now = time.time()
        await self.db.exec("DELETE FROM wallet_pnl WHERE span=? AND bucket < ?", (HOUR, now - 2 * DAY))
        await self.db.exec("DELETE FROM wallet_pnl WHERE span=? AND bucket < ?", (DAY, now - 35 * DAY))
        await self.db.exec("DELETE FROM wallet_positions WHERE last_ts < ?", (now - 35 * DAY,))

    async def loop(self) -> None:
        try:
            await self.backfill()
        except Exception as e:  # noqa: BLE001
            log.warning("leaderboard backfill: %s", e)
        last_refresh = last_prune = 0.0
        while True:
            try:
                n = await self.flush()
                if n:
                    await self._mark_since(time.time())
                now = time.time()
                if now - last_refresh >= _cfg(self.cfg)["refresh_s"]:
                    last_refresh = now
                    await self.refresh()
                if now - last_prune >= HOUR:
                    last_prune = now
                    await self.prune()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                board_h.fail(f"{type(e).__name__}: {e}")
                log.warning("leaderboard: %s", e)
            await asyncio.sleep(5)

    # ---------- reads ----------
    async def board(self, period: str = "1d", sort: str = "roi", limit: int = 100, offset: int = 0,
                    include_bots: bool = False) -> dict[str, Any]:
        if period not in PERIODS:
            raise ValueError("period must be one of " + ", ".join(PERIODS))
        col = "rank_pnl" if sort == "pnl" else "rank_roi"
        where = "b.period=?" + ("" if include_bots else f" AND b.bot=0 AND b.{col} IS NOT NULL")
        order = f"b.{col}" if not include_bots else ("b.realized_sol DESC" if sort == "pnl" else "b.roi DESC")
        rows = await self.db.all(
            f"SELECT b.*, b.{col} AS rank, w.label, w.kind, w.handle, w.tracked FROM wallet_board b "
            f"LEFT JOIN wallets w ON w.address=b.wallet WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?",
            (period, limit, offset))
        for r in rows:
            r["followed"] = r["wallet"] in self.followed
        total = await self.db.one(f"SELECT COUNT(*) n, MAX(as_of) as_of FROM wallet_board b WHERE {where}", (period,))
        return {"period": period, "sort": sort, "rows": rows, "total": total["n"], "as_of": total["as_of"],
                **(await self.coverage())}

    async def coverage(self) -> dict[str, Any]:
        since = await self.db.one("SELECT value FROM kv WHERE key='leaderboard:since'")
        seen = await self.db.one("SELECT COUNT(DISTINCT wallet) n FROM wallet_pnl WHERE span=?", (DAY,))
        return {"observing_since": json.loads(since["value"]) if since else None, "wallets_seen": seen["n"],
                "followed": len(self.followed)}

    async def wallet(self, address: str) -> dict[str, Any]:
        days = await self.db.all("SELECT bucket ts, realized_sol, basis_sol, bought_sol, sold_sol, unmatched_sol, trades, wins, "
                                 "losses FROM wallet_pnl WHERE wallet=? AND span=? ORDER BY bucket", (address, DAY))
        marks = await self.marks()
        pos = await self.db.all("SELECT p.*, t.symbol, t.name FROM wallet_positions p LEFT JOIN tokens t ON t.address=p.mint "
                                "WHERE p.wallet=? ORDER BY p.last_ts DESC LIMIT 200", (address,))
        for p in pos:
            px = marks.get(p["mint"]) if p["qty"] > 0 else None
            p["mark_sol"] = px
            p["unrealized_sol"] = p["qty"] * px - p["cost_sol"] if px is not None else None
        ranks = {r["period"]: r for r in await self.db.all("SELECT * FROM wallet_board WHERE wallet=?", (address,))}
        return {"wallet": address, "days": days, "positions": pos, "ranks": ranks, "followed": address in self.followed}
