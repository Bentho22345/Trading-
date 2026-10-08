import asyncio
import time

from radar.db import DB
from radar.leaderboard import DAY, Leaderboard


class Cfg:
    scoring = {"leaderboard": {"size": 2, "follow": 2, "min_basis_sol": {"1d": 0.5, "30d": 1}, "min_closes": {"1d": 1, "30d": 1}}}


class Smart:
    def __init__(self):
        self.also_follow, self.calls = set(), 0

    async def refresh_tracked(self):
        self.calls += 1


def trade(w, mint, side, sol, tokens, ts, sig=None):
    return {"trader": w, "mint": mint, "side": side, "sol": sol, "tokens": tokens, "ts": ts, "signature": sig or f"{w}{mint}{side}{ts}"}


async def _board():
    db = DB(":memory:")
    await db.open()
    smart = Smart()
    return db, smart, Leaderboard(db, Cfg(), smart)


def test_average_cost_realized_return_and_ranking():
    async def run():
        db, smart, lb = await _board()
        now = time.time()
        # A: buys 1 SOL of 1000 tokens twice (avg 0.002), sells half for 3 SOL -> +2 SOL on 1 SOL basis (+200%)
        for t in (trade("A", "M1", "buy", 1, 1000, now - 50), trade("A", "M1", "buy", 1, 1000, now - 40),
                  trade("A", "M1", "sell", 3, 1000, now - 30),
                  # B: +50% on 2 SOL
                  trade("B", "M1", "buy", 2, 1000, now - 50), trade("B", "M1", "sell", 3, 1000, now - 20),
                  # C: -50% on 1 SOL
                  trade("C", "M2", "buy", 1, 500, now - 50), trade("C", "M2", "sell", 0.5, 500, now - 20),
                  # D: sells tokens bought before we were watching -> unmatched, never profit, never qualifies
                  trade("D", "M2", "sell", 5, 500, now - 10),
                  # duplicate delivery (token + account subscription) is applied once
                  trade("B", "M1", "sell", 3, 1000, now - 20)):
            await lb.on_trade(t)
        await lb.flush()
        pos = await db.one("SELECT * FROM wallet_positions WHERE wallet='A' AND mint='M1'")
        assert abs(pos["qty"] - 1000) < 1e-6 and abs(pos["cost_sol"] - 1) < 1e-9 and abs(pos["realized_sol"] - 2) < 1e-9
        await db.exec("INSERT INTO tokens (address, first_seen, pump_mcap_sol) VALUES ('M1', ?, 4000000)", (now,))  # 0.004 SOL/token
        counts = await lb.refresh()
        assert counts["1d"] == 3 and counts["30d"] == 3
        b = await lb.board("1d")
        assert [r["wallet"] for r in b["rows"]] == ["A", "B"]  # size=2 keeps the top two by ROI
        a = b["rows"][0]
        assert abs(a["roi"] - 2.0) < 1e-9 and a["rank"] == 1 and a["win_rate"] == 1
        assert abs(a["unrealized_sol"] - 3.0) < 1e-6  # 1000 tokens * 0.004 - 1 SOL cost
        pnl = await lb.board("30d", sort="pnl")
        assert pnl["rows"][0]["wallet"] == "A"
        d = await db.one("SELECT * FROM wallet_pnl WHERE wallet='D' AND span=?", (DAY,))
        assert d["unmatched_sol"] == 5 and d["realized_sol"] == 0
        assert lb.followed == {"A", "B"} and smart.also_follow == {"A", "B"} and smart.calls == 1
        w = await lb.wallet("A")
        assert w["ranks"]["1d"]["rank_roi"] == 1 and w["positions"][0]["unrealized_sol"] is not None
        await db.close()
    asyncio.run(run())


def test_windows_bots_and_backfill():
    async def run():
        db, _, lb = await _board()
        now = time.time()
        # E made +100% 3 days ago: in 30d, not in 1d
        await lb.on_trade(trade("E", "M3", "buy", 1, 100, now - 3 * DAY))
        await lb.on_trade(trade("E", "M3", "sell", 2, 100, now - 3 * DAY + 60))
        # F trades like a bot: 1000 round trips today
        for i in range(500):
            await lb.on_trade(trade("F", "M4", "buy", 1, 100, now - 600 + i))
            await lb.on_trade(trade("F", "M4", "sell", 1.1, 100, now - 600 + i))
        await lb.flush()
        await lb.refresh()
        assert [r["wallet"] for r in (await lb.board("30d"))["rows"]] == ["E"]
        assert (await lb.board("1d"))["rows"] == []
        bots = await lb.board("1d", include_bots=True)
        assert bots["rows"][0]["wallet"] == "F" and bots["rows"][0]["bot"] == 1
        # backfill replays raw pump_trades into an empty ledger
        db2, _, lb2 = await _board()
        await db2.many("INSERT INTO pump_trades (mint, ts, side, sol, tokens, trader, signature) VALUES (?,?,?,?,?,?,?)",
                       [("M5", now - 100, "buy", 1, 10, "G", "s1"), ("M5", now - 50, "sell", 1.5, 10, "G", "s2")])
        assert await lb2.backfill() == 2
        assert (await db2.one("SELECT realized_sol FROM wallet_positions WHERE wallet='G'"))["realized_sol"] == 0.5
        assert await lb2.backfill() == 0  # only once
        assert (await lb2.coverage())["observing_since"] == now - 100
        await db.close()
        await db2.close()
    asyncio.run(run())
