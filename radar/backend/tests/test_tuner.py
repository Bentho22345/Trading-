"""The Tuner: walk-forward tournaments of brain variants on the recorded tape; adopt only a variant that wins both windows."""
import asyncio

from radar.tuner import CHANGES, Tuner, merge

from .test_autopilot import make


def test_merge_stacks_changes_on_the_current_settings():
    t = merge({"tape_mult": 0.6, "off": ["swing"]}, {"tape_mult": 0.5, "off": ["snipe:mid"], "ev_margin": 0.01})
    assert t == {"tape_mult": 0.3, "off": ["snipe:mid", "swing"], "ev_margin": 0.01}


def test_tournament_adopts_only_a_variant_that_wins_train_and_fresh_hours(tmp_path):
    async def run():
        ap, db = await make(tmp_path, [])
        await ap.set_mode("auto")
        tu = Tuner(ap, tmp_path / "radar.db")
        results = {"train": {"current": 1.0, "no swings": 6.0, "strict tape": 4.0},
                   "valid": {"current": 0.5, "no swings": 3.0, "strict tape": 9.0}}
        calls = []

        async def fake(hours, end, tune, level):
            name = next((n for n, ch in CHANGES.items() if merge({}, ch) == tune), "current")
            phase = "valid" if hours == 3.0 else "train"
            calls.append((phase, name))
            return {"ok": True, "return_pct": results[phase].get(name, -5.0), "max_drawdown_pct": 0.0, "positions": 10, "wins": 5}
        tu._replay = fake
        last = await tu.tournament(8.0, 3.0, auto_adopt=True)
        assert len([c for c in calls if c[0] == "train"]) == 1 + len(CHANGES)
        assert {c[1] for c in calls if c[0] == "valid"} == {"current", "no swings", "strict tape"}   # top 2 + current
        assert last["winner"] == "strict tape" and last["adopted"] and ap.brain.tune == {"tape_mult": 0.6}
        assert any("Tuner" in e["text"] and "adopted" in e["text"] for e in ap.brain.log)
        # a challenger that only wins on the training hours is NOT adopted
        results["valid"] = {"current": 2.0, "no swings": 2.5, "strict tape": 1.0}
        ap.brain.tune = {}
        last = await tu.tournament(8.0, 3.0, auto_adopt=True)
        assert last["winner"] == "current" and not last["adopted"] and ap.brain.tune == {}
        # real money: never auto-adopted
        results["valid"] = {"current": 0.0, "no swings": 9.0, "strict tape": 9.5}
        ap.c["mode"] = "real"
        last = await tu.tournament(8.0, 3.0, auto_adopt=True)
        assert not last["adopted"] and ap.brain.tune == {}
        await db.close()
    asyncio.run(run())
