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
        assert lb.followed == {"A", "B"} and set(smart.also_follow) == {"A", "B"} and smart.also_follow["A"]["rank"] == 1 and smart.calls == 1
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


def test_top_wallet_trades_flash_push_and_cluster():
    from radar import smartmoney
    from radar.smartmoney import SmartMoney

    published = []

    async def publish(ch, data):
        published.append((ch, data))

    class Tracker:
        sol_usd = 200.0

        async def _ensure_token(self, *a):
            pass

        def _usd(self, sol):
            return sol * 200 if sol is not None else None

    class Alerts:
        def __init__(self):
            self.sent = []

        async def send(self, kind, title, body="", token=None, dedupe=None, ttl=900, extra=None):
            if any(d == dedupe for *_, d in self.sent):
                return None
            self.sent.append((kind, title, token, dedupe))
            return {"kind": kind}

    class C:
        scoring = {"leaderboard": {"flash": {"push_min_sol": 1, "push_max_per_min": 2, "cluster_wallets": 2, "cluster_minutes": 10}},
                   "smart_money": {"wallet_min_score": 60}}

    async def run():
        db = DB(":memory:")
        await db.open()
        orig, smartmoney.hub.publish = smartmoney.hub.publish, publish
        alerts = Alerts()
        sm = SmartMoney(db, C(), Tracker(), alerts, None)
        sm.also_follow = {"A": {"rank": 1, "period": "1d", "roi": 2.0}, "B": {"rank": 7, "period": "30d", "roi": 0.5}}
        now = time.time()
        t = {"trader": "A", "mint": "M1", "side": "buy", "sol": 2.0, "tokens": 1000, "ts": now, "mcap_sol": 50, "signature": "s1"}
        await sm.on_trade(t)
        await sm.on_trade(dict(t))  # same trade again from the token subscription: ignored
        await sm.on_trade({**t, "signature": "s2", "sol": 0.1})  # small: flashes in UI, not pushed
        await sm.on_trade({**t, "trader": "Z", "signature": "s3"})  # not a followed wallet
        tops = [d for ch, d in published if ch == "top_trade"]
        assert [d["signature"] for d in tops] == ["s1", "s2"] and tops[0]["rank"] == 1 and tops[0]["usd"] == 400
        assert [a[0] for a in alerts.sent] == ["wallet"]
        assert (await db.one("SELECT COUNT(*) n FROM wallet_trades WHERE wallet='A'"))["n"] == 2
        await sm.on_trade({**t, "trader": "B", "signature": "s4"})  # second distinct top wallet buying M1 -> FLASH
        flashes = [d for ch, d in published if ch == "flash"]
        assert flashes and flashes[0]["kind"] == "top_cluster" and [w["wallet"] for w in flashes[0]["wallets"]] == ["A", "B"]
        assert ("flash" in [a[0] for a in alerts.sent]) and len([a for a in alerts.sent if a[0] == "wallet"]) == 2  # cap = 2/min
        await sm.on_trade({**t, "trader": "B", "signature": "s5", "sol": 5})  # over the push cap: UI only
        assert len([a for a in alerts.sent if a[0] == "wallet"]) == 2
        smartmoney.hub.publish = orig
        await db.close()
    asyncio.run(run())
