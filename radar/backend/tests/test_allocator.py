"""The allocator (the Nebula's risk manager): benches strategies that lose, probes them, pays the ones that work."""
import asyncio
import time

from radar.allocator import Allocator, strat_key

from .test_autopilot import _tape_launch, make


def test_benches_losers_probes_and_unbenches():
    a = Allocator()
    for _ in range(14):
        a.book("snipe:early", -0.06, -0.006)
    ok, mult, why = a.gate("snipe:early")
    assert not ok and why == "benched" and any("benched snipe:early" in n for n in a.notes)
    probes = [a.gate("snipe:early") for _ in range(12)]
    assert sum(1 for p in probes if p[0]) == 2 and all(p[1] == 0.3 for p in probes if p[0])     # 1 in 6, at 30% size
    for _ in range(4):
        a.book("snipe:early", 0.08, 0.008, probe=True)
    assert a.gate("snipe:early")[0] and any("un-benched" in n for n in a.notes)


def test_winners_get_more_size_and_state_round_trips():
    a = Allocator()
    for i in range(20):
        a.book("wave2", 0.06 + (i % 3) * 0.01, 0.006)
        a.book("drought", -0.002 if i % 2 else 0.001, 0.0)
    assert a.gate("wave2")[1] > 1.1 and a.gate("wave2")[1] > a.gate("drought")[1]
    b = Allocator()
    b.restore(a.state())
    assert b.s["wave2"]["trades"] == 20 and abs(b.s["wave2"]["mean"] - a.s["wave2"]["mean"]) < 1e-9
    assert strat_key("snipe", 5) == "snipe:early" and strat_key("snipe", 30) == "snipe:mid" and strat_key("scalp") == "scalp"
    assert {r["strategy"] for r in a.snapshot()["strategies"]} == {"wave2", "drought"}


def test_second_wave_buys_the_coin_that_survived_the_flush_and_the_report_reads_it(tmp_path):
    async def run():
        now = time.time()
        # launched 2 min ago: early pump to vsol 45, the flush down to 37, now buyers back in with many holders
        tr = [(now - 115 + i, "buy", 0.6, 1e6, f"e{i}", 30 + i * 0.75) for i in range(20)]
        tr += [(now - 90 + i, "sell", 0.9, 1e6, f"e{i}", 45 - i * 0.8) for i in range(10)]
        tr += [(now - 28 + i, "buy", 0.35, 1e6, f"w{i}", 37 + i * 0.25) for i in range(26)]
        L = _tape_launch("WAVEmint" + "5" * 32, tr, vsol=37 + 26 * 0.25, peak=40.0 * (45 / 40) ** 2, upside=40, risk=15, buyers=46)
        L.created = now - 120
        L.mcap_sol = 40.0 * ((37 + 26 * 0.25) / 40) ** 2 * 0.8
        ap, db = await make(tmp_path, [L])
        b = ap.brain
        await b.set_aggression("surreal")
        await ap.set_mode("auto")
        await b.tick("auto")
        w = [p for p in ap.open.values() if p.get("strat") == "wave2"]
        assert w, (b.skips, b.bars, b.wave2_score(b.cache[L.mint]["f"], b.charts[L.mint]))
        await ap.sell(w[0], 1.0, "test")
        rep = await b.report()
        assert rep["trades"] == 1 and rep["by_strategy"][0]["key"] == "wave2"
        assert b.alloc.s["wave2"]["trades"] == 1
        await db.close()
    asyncio.run(run())
