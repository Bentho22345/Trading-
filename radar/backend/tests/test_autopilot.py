"""Autopilot: demo trading end to end against the live-scoring objects, exits, limits, real-mode safety, and wallet signing
(all offline — no transaction ever leaves the test)."""
import asyncio
import time
from types import SimpleNamespace

import pytest

from radar.autopilot import DEFAULT, REAL_PHRASE, Autopilot, merge, validate
from radar.db import DB
from radar.solwallet import TradeError, TradingWallet


class KV:
    def __init__(self):
        self.d = {}

    async def kv_get(self, k, default=None):
        return self.d.get(k, default)

    async def kv_set(self, k, v):
        self.d[k] = v


class Alerts:
    def __init__(self):
        self.sent = []

    async def send(self, kind, title, body="", **kw):
        self.sent.append((kind, title))


def launch(mint, mcap_sol=40.0, **res):
    L = SimpleNamespace(mint=mint, symbol=mint[:4].upper(), mcap_sol=mcap_sol, vsol=40.0, dev={"graduated": 0}, result=None)
    L.result = {"mint": mint, "symbol": L.symbol, "tier": "WATCH", "score": 50, "bundled": False, "buyers": 20, "risk": 20, "upside": 60,
                "mcap_usd": mcap_sol * 150, "age_s": 60, "scores": {"safe": 30, "balanced": 40, "degen": 55}, "metrics": {}, "flags": [],
                "strategies": [], "x": None, **res}
    return L


class Sniper:
    def __init__(self, launches):
        self.launches = {L.mint: L for L in launches}

    def board(self, appetite="", limit=25, max_age_min=30, **kw):
        rows = sorted((L.result for L in self.launches.values()), key=lambda r: -r["scores"].get(appetite, 0))
        return {"rows": rows[:limit]}

    def one(self, mint):
        L = self.launches.get(mint)
        return L.result if L else None


async def make(tmp_path, launches, **cfg):
    db = DB(tmp_path / "ap.db")
    await db.open()
    kv = KV()
    tracker = SimpleNamespace(sol_usd=150.0, launch_watch={}, token_summary=lambda m: asyncio.sleep(0, None))
    ap = Autopilot(db, kv, Sniper(launches), tracker, SimpleNamespace(ranked={}, followed=set()), None, Alerts(), None)
    await ap.load()
    if cfg:
        await ap.save(cfg)
    return ap, db


def test_config_merge_and_validation_clamps():
    c = validate(merge(DEFAULT, {"size": {"buy_sol": 50, "max_buy_sol_hard": 0.5, "max_open": 0}, "exits": {"stop_loss_pct": 400},
                                 "bogus": 1, "mode": "yolo"}))
    assert c["size"]["buy_sol"] == 0.5 and c["size"]["max_open"] == 1 and c["exits"]["stop_loss_pct"] == 95 and c["mode"] == "off"
    assert "bogus" not in c


def test_demo_buys_on_signal_then_takes_profit_and_stops_out(tmp_path):
    async def run():
        a, b = launch("AAAAmint" + "1" * 32), launch("BBBBmint" + "2" * 32, bundled=True)
        ap, db = await make(tmp_path, [a, b], size={"buy_sol": 0.1, "cooldown_s": 0})
        await ap.set_mode("demo")
        await ap.scan()
        assert len(ap.open) == 1                                             # the bundled one is filtered out
        p = next(iter(ap.open.values()))
        assert p["mint"] == a.mint and p["trigger"] == "snipe" and p["mode"] == "demo"
        assert await ap.demo_balance() == pytest.approx(10 - 0.1 - 0.0005)
        a.mcap_sol = 40.0 * 2.2                                              # 2× → first take-profit sells half
        await ap.manage()
        assert p["tp_done"] == [0] and p["tokens_left"] == pytest.approx(p["tokens"] / 2) and p["sol_out"] > 0.09
        a.mcap_sol = 40.0 * 0.5                                              # then it dumps → trailing stop / stop loss closes it
        await ap.manage()
        assert p["status"] == "closed" and not ap.open
        row = await db.one("SELECT * FROM auto_positions WHERE id=?", (p["id"],))
        assert row["status"] == "closed" and row["exit_reason"].startswith(("trailing", "stop")) and row["pnl_sol"] is not None
        orders = await db.all("SELECT side, status, reason FROM auto_orders ORDER BY id")
        assert [o["side"] for o in orders] == ["buy", "sell", "sell"] and all(o["status"] == "filled" for o in orders)
        await ap.scan()
        assert not ap.open                                                   # never re-enters the same coin
        await db.close()
    asyncio.run(run())


def test_limits_tweet_race_and_rug_exit(tmp_path):
    async def run():
        ls = [launch(f"M{i}mint" + str(i) * 32) for i in range(5)]
        race = launch("RACEmint" + "9" * 32, scores={"safe": 0, "balanced": 0, "degen": 0},
                      x={"rank": 1, "handle": "elonmusk", "score": 80})
        ap, db = await make(tmp_path, [race, *ls], size={"buy_sol": 0.1, "max_open": 2, "cooldown_s": 0})
        await ap.set_mode("demo")
        await ap.scan()
        assert len(ap.open) == 2 and ap.paused_reason is None
        assert any(p["trigger"] == "tweet_race" for p in ap.open.values())
        await ap.scan()
        assert len(ap.open) == 2 and ap.paused_reason == "max open positions"
        victim = next(p for p in ap.open.values())
        ap.sniper.launches[victim["mint"]].result["tier"] = "TRAP"
        ap.sniper.launches[victim["mint"]].result["flags"] = ["insider cluster"]
        await ap.manage()
        assert victim["status"] == "closed" and "rug exit" in victim["exit_reason"]
        # daily loss limit stops new buys
        await ap.save({"size": {"daily_loss_limit_sol": 0.0001}})
        await db.exec("UPDATE auto_positions SET pnl_sol=-1 WHERE id=?", (victim["id"],))
        assert "loss limit" in (await ap.can_buy() or "")
        n = await ap.panic()
        assert n == 1 and not ap.open and ap.c["mode"] == "off"
        await db.close()
    asyncio.run(run())


def test_real_mode_needs_password_confirmation_and_wallet(tmp_path, monkeypatch):
    async def run():
        ap, db = await make(tmp_path, [])
        ap.wallet = TradingWallet(KV(), None)
        monkeypatch.delenv("RADAR_PASSWORD", raising=False)
        with pytest.raises(ValueError, match="site password"):
            await ap.set_mode("real", REAL_PHRASE, True)
        monkeypatch.setenv("RADAR_PASSWORD", "pw")
        with pytest.raises(ValueError, match="password"):
            await ap.set_mode("real", REAL_PHRASE, False)
        with pytest.raises(ValueError, match="Type exactly"):
            await ap.set_mode("real", "yes", True)
        with pytest.raises(ValueError, match="trading wallet"):
            await ap.set_mode("real", REAL_PHRASE, True)
        await ap.wallet.create()
        assert (await ap.set_mode("real", REAL_PHRASE.lower(), True))["mode"] == "real"
        with pytest.raises(TradeError):
            await ap.wallet.create()                                         # never silently replaces a wallet
        await db.close()
    asyncio.run(run())


def test_wallet_key_is_encrypted_and_signs_offline(tmp_path, monkeypatch):
    from solders.hash import Hash
    from solders.message import MessageV0
    from solders.pubkey import Pubkey
    from solders.system_program import TransferParams, transfer
    from solders.transaction import VersionedTransaction
    monkeypatch.setenv("RADAR_SECRET", "unit-test-secret")

    async def run():
        kv = KV()
        w = TradingWallet(kv, None)
        info = await w.create()
        stored = kv.d["autopilot:wallet"]
        sk = await w.export_key()
        assert sk not in str(stored) and info["pubkey"] == stored["pubkey"]   # only ciphertext at rest
        payer = Pubkey.from_string(info["pubkey"])
        ix = transfer(TransferParams(from_pubkey=payer, to_pubkey=Pubkey.default(), lamports=1))
        msg = MessageV0.try_compile(payer, [ix], [], Hash.default())
        unsigned = bytes(VersionedTransaction.populate(msg, [__import__("solders.signature", fromlist=["Signature"]).Signature.default()]))
        signed = VersionedTransaction.from_bytes(await w.sign(unsigned))
        assert signed.verify_with_results() == [True]
    asyncio.run(run())


def test_real_buy_reads_fills_back_from_chain(tmp_path, monkeypatch):
    """The execution path with the chain and PumpPortal stubbed in-process: fills come from balance changes."""
    monkeypatch.setenv("RADAR_SECRET", "unit-test-secret")

    async def run():
        state = {"sol": 1.0, "tok": 0.0, "sent": []}

        class FakeChain:
            async def sol_balance(self, pub):
                return state["sol"]

            async def token_balance(self, owner, mint):
                return state["tok"]

            async def send(self, raw):
                state["sent"].append(raw)
                state["sol"] -= 0.1012
                state["tok"] += 2_000_000
                return "sig1"

            async def confirm(self, sig, timeout=45):
                return True

        w = TradingWallet(KV(), FakeChain())
        await w.create()

        async def fake_pp(*a, **k):
            from solders.hash import Hash
            from solders.message import MessageV0
            from solders.pubkey import Pubkey
            from solders.signature import Signature
            from solders.system_program import TransferParams, transfer
            from solders.transaction import VersionedTransaction
            payer = Pubkey.from_string(await w.pubkey())
            msg = MessageV0.try_compile(payer, [transfer(TransferParams(from_pubkey=payer, to_pubkey=Pubkey.default(), lamports=1))], [], Hash.default())
            return bytes(VersionedTransaction.populate(msg, [Signature.default()]))
        monkeypatch.setattr(w, "_pumpportal", fake_pp)
        r = await w.buy("MINT" + "x" * 40, 0.1, 15, 0.0005)
        assert r == {"sig": "sig1", "route": "pumpportal", "tokens": 2_000_000, "sol": pytest.approx(0.1012)} and state["sent"]
        state["sol"] = 0.05
        with pytest.raises(TradeError, match="not enough"):
            await w.buy("MINT" + "x" * 40, 0.1, 15, 0.0005)
    asyncio.run(run())
