"""Replay lab: a fresh brain trades the tape Radar recorded, on a virtual clock, with no look-ahead."""
import asyncio
import sqlite3
import time

from radar.db import DB
from radar import curve, replay


def test_replay_trades_recorded_tape_and_restores_the_clock(tmp_path):
    db_path = tmp_path / "live.db"

    async def setup():
        d = DB(db_path)
        await d.open()
        await d.close()
    asyncio.run(setup())
    t0 = 1_790_000_000.0
    with sqlite3.connect(db_path) as c:
        for k in range(6):                                            # six launches; trades climb with plenty of buyers
            mint = f"RPLY{k}mint" + str(k) * 30
            c.execute("INSERT INTO tokens (address, chain, symbol, name, source, deployer, launched_at, first_seen, dev_initial_buy_pct) "
                      "VALUES (?,?,?,?,?,?,?,?,?)", (mint, "solana", f"R{k}", f"Replay {k}", "pumpportal", f"Dev{k}", t0 + k * 20, t0 + k * 20, 2.0))
            v = 31.0
            for i in range(400):
                ts = t0 + k * 20 + 1 + i * 1.5
                side = "sell" if i % 5 == 4 else "buy"
                sol = 0.4 + (i % 7) * 0.05
                v = max(30.5, v + (sol if side == "buy" else -sol * 0.8))
                c.execute("INSERT INTO pump_trades (mint, ts, side, sol, tokens, trader, mcap_sol, signature, sol_usd) VALUES (?,?,?,?,?,?,?,?,?)",
                          (mint, ts, side, sol, sol * 1e6, f"W{k}{i % 90}" + "x" * 30, v * v * 1e9 / curve.K, f"s{k}-{i}", 150.0))
    real = time.time
    res = asyncio.run(replay.run(str(db_path), hours=0.2, level="surreal", end=t0 + 650))
    assert time.time is real and abs(time.time() - real()) < 5            # the virtual clock is gone afterwards
    assert res["ok"] and res["trades_replayed"] > 1000 and res["launches"] == 6, res
    assert "by_strategy" in res and "skips" in res and res["last_error"] is None
    assert res["positions"] > 0                                         # it actually trades the replayed tape
    assert replay.KV is not None


def test_a_brain_adopts_only_models_that_saw_more_tape(tmp_path):
    from .test_autopilot import make

    async def run():
        ap, db = await make(tmp_path, [])
        a = ap.brain
        teacher = type(a)(ap)
        teacher.up.n, teacher.council.referee.n, teacher.rug.n = 900, 400, 0
        teacher.up.w = {k: v + 0.5 for k, v in teacher.up.w.items()}
        a.rug.n = 50
        took = a.adopt_models(teacher.learned())
        assert any(t.startswith("up") for t in took) and any(t.startswith("referee") for t in took)
        assert not any(t.startswith("rug") for t in took) and a.rug.n == 50          # it knew more: kept its own
        assert a.up.n == 900 and abs(sum(a.up.w.values()) - sum(teacher.up.w.values())) < 1e-6
        assert a.adopt_models(None) == []
        await db.close()
    asyncio.run(run())
