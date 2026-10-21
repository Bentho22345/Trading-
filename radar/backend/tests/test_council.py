"""The Nebula council: executor + skeptic + optimist, Hedge credibility, counterfactual playbooks, ghosts, regimes."""
import asyncio
import time

from .test_autopilot import _newborn, launch, make

from radar.council import ORDER, PLAYBOOKS


def test_debate_votes_veto_and_size():
    async def run(tmp):
        ap, db = await make(tmp, [])
        c = ap.brain.council
        f_good = {"ape_wave": 1.0, "holder_growth": 1.0, "narrative": 1.0, "upside": 0.8, "influx": 1.0}
        f_bad = {"dev_serial": 1.0, "coordinated": 1.0, "liq_drain": 1.0, "risk": 0.9, "insiders": 1.0, "dump_candle": 1.0}
        good, bad = c.decide("scalp", f_good, 0.7, "GOOD", "m1"), c.decide("scalp", f_bad, 0.7, "BAD", "m2")
        assert good["votes"]["optimist"] > bad["votes"]["optimist"] and good["votes"]["skeptic"] > bad["votes"]["skeptic"]
        assert good["go"] and good["size_mult"] > bad["size_mult"] and good["play"] in ORDER
        assert "exec" in good["summary"] and c.debate[0]["symbol"] == "BAD"
        c.skeptic.b = 4.0
        assert not c.decide("scalp", f_bad, 0.9, "BAD", "m2")["veto"]      # sure, but unproven: no veto power yet
        c.skeptic.n = 100                                                  # an experienced, well-calibrated skeptic that's sure → veto
        c.skeptic.hits.extend([1] * 70 + [0] * 30)
        c.skeptic.brier.extend([0.15] * 100)
        v = c.decide("scalp", f_bad, 0.9, "BAD", "m2")
        assert v["veto"] and not v["go"] and c.stats["vetoed"] == 1
        await db.close()
    import tempfile
    from pathlib import Path
    asyncio.run(run(Path(tempfile.mkdtemp())))


def test_hedge_moves_credibility_to_whoever_was_right(tmp_path):
    async def run():
        ap, db = await make(tmp_path, [])
        c = ap.brain.council
        for _ in range(12):                                                # the skeptic kept saying no, and trades kept losing
            c.hedge({"executor": 0.8, "skeptic": 0.1, "optimist": 0.9}, -0.1)
        assert c.cred["skeptic"] > c.cred["executor"] > 0.07 and c.cred["skeptic"] > c.cred["optimist"]
        assert abs(sum(c.cred.values()) - 1) < 1e-9 and min(c.cred.values()) >= 0.07
        await db.close()
    asyncio.run(run())


def test_every_playbook_is_replayed_on_the_real_path_and_ghosts_teach_the_veto(tmp_path):
    async def run():
        coin = launch("PATHmint" + "1" * 32, mcap_sol=40.0)
        ap, db = await make(tmp_path, [coin])
        c = ap.brain.council
        d = c.decide("scalp", {"ape_wave": 1.0}, 0.6, "PATH", coin.mint)
        c.open_track("g:test", coin.mint, {"ape_wave": 1.0}, 40.0, 0.1, 40.0, {**d, "go": False}, real=False, sol=0.1)
        t = c.track["g:test"]
        t["t0"] -= 10
        for m in (41, 43, 45, 48, 50):                                    # the coin climbs +25%
            coin.mcap_sol = m
            c.last_step = 0
            c.step(time.time())
        t["t0"] -= 2000                                                   # …and time runs out for the slow playbooks
        coin.mcap_sol = 52
        c.last_step = 0
        c.step(time.time())
        assert "g:test" not in c.track
        stats = c.plays["scalp"]
        assert set(stats) == set(PLAYBOOKS) - {"moon"}                    # fast styles never hold 25 minutes
        assert stats["quick"][1] > 0.05 and stats["flash"][1] < stats["quick"][1]          # tp 12% beat tp 8% on a +25% run
        assert c.stats["ghosts_done"] == 1 and c.stats["missed_sol"] > 0                    # saying no to this one cost money
        await db.close()
    asyncio.run(run())


def test_losing_run_flips_defensive_and_changes_things_up(tmp_path):
    async def run():
        ap, db = await make(tmp_path, [])
        c = ap.brain.council
        notes = []
        for _ in range(22):
            notes += c.on_close({"council": {"votes": {"executor": 0.8, "skeptic": 0.3, "optimist": 0.8}}}, 0.9, {"risk": 0.5})
        assert c.regime == "defensive" and c.explore_left > 0 and any("DEFENSIVE" in n for n in notes)
        d = c.decide("scalp", {}, 0.6, "X", "m")
        assert d["bar"] > 0.48 and d["size_mult"] < 1.0                   # pickier and smaller
        for _ in range(45):
            notes += c.on_close({"council": {}}, 1.2, {"ape_wave": 1.0})
        assert c.regime == "aggressive"
        await db.close()
    asyncio.run(run())


def test_skeptic_pulls_the_plug_and_the_optimist_holds_a_surge(tmp_path):
    async def run():
        ap, db = await make(tmp_path, [])
        c = ap.brain.council
        c.skeptic.b = 5.0                                                 # it's sure this one loses
        c.cred = {"executor": 0.2, "skeptic": 0.6, "optimist": 0.2}
        p = {"opened": time.time() - 30}
        ex = c.exit_vote(p, {"risk": 1.0}, 0.95, 30)
        assert ex and ex[0] == 1.0 and "skeptic" in ex[1]
        c.cred = {"executor": 0.2, "skeptic": 0.35, "optimist": 0.45}
        c.optimist.b = 3.0                                                # …but now the optimist sees a run and outvotes it
        assert c.exit_vote(p, {"risk": 1.0}, 1.1, 30) is None
        await db.close()
    asyncio.run(run())


def test_council_runs_the_executor_end_to_end_and_learns_on_close(tmp_path):
    async def run():
        now = time.time()
        coins = [_newborn(f"NB{i:02d}mint" + str(i % 10) * 30, now) for i in range(6)]
        ap, db = await make(tmp_path, coins)
        b = ap.brain
        await b.set_aggression("surreal")
        await ap.set_mode("auto")
        await b.tick("auto")
        held = [p for p in ap.open.values() if p["mode"] == "auto"]
        assert held and all(p.get("council") for p in held) and all("🗳" in p["detail"] for p in held)
        assert b.council.stats["approved"] >= len(held) and b.council.track            # real positions tracked counterfactually
        p = held[0]
        n0 = b.council.skeptic.n
        await ap.sell(p, 1.0, "test")
        assert b.council.skeptic.n == n0 + 1 and len(b.council.recent) == 1
        snap = await b.snapshot()
        assert snap["nebula"]["cred"] and "debate" in snap["nebula"]
        await b.save()
        b2 = type(b)(ap)
        await b2.load()
        assert b2.council.skeptic.n == b.council.skeptic.n                  # the council's memory survives a restart
        await db.close()
    asyncio.run(run())
