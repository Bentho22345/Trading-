"""Intel feed: one stream of what every engine just found (insider clusters, YouTube mentions, AI reads, Dune imports…)."""
from __future__ import annotations

import time
from collections import deque
from typing import Any

from .hub import hub

FEED: deque[dict[str, Any]] = deque(maxlen=300)
COUNTS: dict[str, int] = {}
_DAY = [int(time.time() // 86400)]


async def push(engine: str, kind: str, title: str, body: str = "", mint: str | None = None, **extra: Any) -> dict[str, Any]:
    d = int(time.time() // 86400)
    if d != _DAY[0]:
        _DAY[0] = d
        COUNTS.clear()
    COUNTS[f"{engine}:{kind}"] = COUNTS.get(f"{engine}:{kind}", 0) + 1
    ev = {"ts": time.time(), "engine": engine, "kind": kind, "title": title, "body": body, "mint": mint, **extra}
    FEED.appendleft(ev)
    await hub.publish("intel", ev)
    return ev


def recent(limit: int = 100, engine: str | None = None) -> list[dict[str, Any]]:
    return [e for e in FEED if not engine or e["engine"] == engine][:limit]


def count(engine: str, kind: str) -> int:
    return COUNTS.get(f"{engine}:{kind}", 0)
