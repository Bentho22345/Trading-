import asyncio
import math
import time

from radar.db import DB
from radar.discover import Discover, max_drawdown, regress


def test_regress_steady_climb_vs_noise():
    steady = [(h, math.log(1000 * 1.1 ** h)) for h in range(8)]
    slope, r2 = regress(steady)
    assert 9.9 < slope < 10.1 and r2 > 0.99
    noisy = [(h, math.log(1000 * (1.6 if h % 2 else 0.7))) for h in range(8)]
    assert regress(noisy)[1] < 0.2
    assert max_drawdown([1, 2, 1.5, 3]) == -25.0


class _Alerts:
    def __init__(self):
        self.sent = []

    async def send(self, kind, title, body="", token=None, **kw):
        self.sent.append((kind, title, token))


def test_launch_watch_matches_new_tokens(tmp_path):
    async def run():
        db = DB(tmp_path / "d.db")
        await db.open()
        alerts = _Alerts()
        d = Discover(db, None, None, None, alerts)
        wid = await d.add_watch(["$HAWK", "hawk tuah"], "Hawk Tuah", None)
        await d.check_launch({"address": "A1", "symbol": "HAWK", "name": "Hawk"})
        await d.check_launch({"address": "A2", "symbol": "XYZ", "name": "The Hawk Tuah Girl"})
        await d.check_launch({"address": "A3", "symbol": "DOGE", "name": "Doge"})
        w = (await d.watches())[0]
        await db.close()
        return wid, w, alerts.sent
    wid, w, sent = asyncio.run(run())
    assert w["id"] == wid and w["hits"] == 2 and w["terms"] == ["hawk", "hawk tuah"]
    assert [s[2] for s in sent] == ["A1", "A2"] and sent[0][0] == "flash"


def test_story_heuristic_extracts_narratives():
    from radar.story import StoryEngine

    class Cfg:
        watch = {"category_keywords": {"animal": ["hawk", "dog"]}}
    eng = StoryEngine.__new__(StoryEngine)
    eng.cfg = Cfg()
    ev = [{"source": "x", "text": "Hawk Tuah girl interview goes viral again"},
          {"source": "reddit", "text": "the hawk tuah interview clip everywhere"},
          {"source": "google_news", "text": "Viral interview: hawk tuah girl launches podcast"},
          {"source": "bluesky", "text": "random unrelated post"}]
    st = eng.heuristic({"symbol": "TUAH", "name": "Tuah"}, ev)
    assert st["narratives"]
    title = st["narratives"][0]["title"]
    assert "interview" in title or "hawk" in title or "viral" in title
    assert len(st["narratives"][0]["sources"]) >= 2 and "posts/headlines" in st["why_moving"]
