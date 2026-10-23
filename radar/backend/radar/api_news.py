"""News & meta endpoints: the tagged live news feed (grouped into stories) and the meta heat board."""
from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, HTTPException

from .app import S

router = APIRouter(prefix="/api")


def _news_row(r: dict[str, Any]) -> dict[str, Any]:
    for k in ("tags_json", "metas_json", "tickers_json"):
        r[k[:-5]] = json.loads(r.pop(k) or "[]")
    r["group"] = r.pop("grp", None)
    return r


@router.get("/news/feed")
async def news_feed(group: str = "", tag: str = "", meta: str = "", ticker: str = "", q: str = "", hours: float = 24,
                    limit: int = 200, min_impact: float = 0, collapse: bool = True) -> dict[str, Any]:
    """Newest first. collapse=true folds the same story from several outlets into one item with `coverage` and `outlets`."""
    now = time.time()
    sql, args = "SELECT * FROM news WHERE COALESCE(published, fetched) > ? AND fetched > ?", [now - hours * 3600, now - hours * 3600 - 86400]
    if group:
        sql += " AND grp=?"
        args.append(group)
    if tag:
        sql += " AND tags_json LIKE ?"
        args.append(f'%"{tag}"%')
    if meta:
        sql += " AND metas_json LIKE ?"
        args.append(f'%"{meta}"%')
    if ticker:
        sql += " AND tickers_json LIKE ?"
        args.append(f'%"{ticker.upper().lstrip("$")}"%')
    if q:
        sql += " AND title LIKE ?"
        args.append(f"%{q}%")
    if min_impact:
        sql += " AND COALESCE(impact, 0) >= ?"
        args.append(min_impact)
    rows = [_news_row(r) for r in await S.db.all(sql + " ORDER BY COALESCE(published, fetched) DESC LIMIT ?", [*args, min(limit * 3, 1500)])]
    if collapse:
        stories: dict[str, dict[str, Any]] = {}
        out = []
        for r in rows:
            sid = r.get("story_id") or r["id"]
            s = stories.get(sid)
            if s is None:
                r["outlets"] = [r.get("publisher") or r["source"]]
                r["coverage"] = 1
                stories[sid] = r
                out.append(r)
            else:
                pub = r.get("publisher") or r["source"]
                if pub not in s["outlets"]:
                    s["outlets"].append(pub)
                    s["coverage"] += 1
                s["first_seen"] = min(s.get("first_seen") or s["fetched"], r["fetched"])
                s["impact"] = max(s.get("impact") or 0, r.get("impact") or 0)
        rows = out
    return {"as_of": now, "items": rows[:limit]}


@router.get("/news/facets")
async def news_facets(hours: float = 6) -> dict[str, Any]:
    now = time.time()
    rows = await S.db.all("SELECT grp, tags_json, metas_json, tickers_json, sentiment FROM news WHERE COALESCE(published, fetched) > ? "
                          "AND fetched > ?", (now - hours * 3600, now - hours * 3600 - 86400))
    groups: dict[str, int] = {}
    tags: dict[str, int] = {}
    metas: dict[str, int] = {}
    ticks: dict[str, int] = {}
    sent = [r["sentiment"] for r in rows if r["sentiment"] is not None]
    for r in rows:
        if r["grp"]:
            groups[r["grp"]] = groups.get(r["grp"], 0) + 1
        for k, bag in (("tags_json", tags), ("metas_json", metas), ("tickers_json", ticks)):
            for v in json.loads(r[k] or "[]"):
                bag[v] = bag.get(v, 0) + 1
    last_min = await S.db.one("SELECT COUNT(*) n FROM news WHERE fetched > ?", (now - 60,))
    names = {m.id: m.name for m in S.metas.metas}
    top = lambda d, n: sorted(d.items(), key=lambda kv: -kv[1])[:n]  # noqa: E731
    return {"hours": hours, "total": len(rows), "per_min": last_min["n"], "groups": dict(top(groups, 30)), "tags": dict(top(tags, 20)),
            "metas": [{"id": k, "name": names.get(k, k), "n": v} for k, v in top(metas, 20)], "tickers": dict(top(ticks, 20)),
            "sentiment": round(sum(sent) / len(sent), 2) if sent else 0}


@router.get("/news/sources")
async def news_sources() -> dict[str, Any]:
    from .tracker import _sources_cfg
    feeds = (_sources_cfg().get("rss") or {}).get("feeds") or []
    now = time.time()
    last = {r["source"]: r["t"] for r in await S.db.all("SELECT source, MAX(fetched) t FROM news GROUP BY source")}
    out = []
    for f in feeds:
        fails, until = S.tracker.feed_backoff.get(f["name"], (0, 0.0))
        out.append({"name": f["name"], "group": f.get("group"), "every_s": f.get("every_s"), "last_item": last.get(f["name"]),
                    "failing": fails > 0, "fails": fails, "retry_in_s": max(0, round(until - now))})
    return {"feeds": out, "total": len(out), "failing": sum(1 for f in out if f["failing"])}


# ---------------- metas ----------------
@router.get("/metas")
async def metas() -> dict[str, Any]:
    if not S.metas.rows:
        await S.metas.refresh()
    return {"as_of": S.metas.as_of, "metas": S.metas.rows}


@router.get("/meta/{mid}")
async def meta(mid: str) -> dict[str, Any]:
    d = await S.metas.detail(mid)
    if not d:
        raise HTTPException(404)
    d["news_items"] = [_news_row(r) for r in await S.db.all(
        "SELECT * FROM news WHERE metas_json LIKE ? AND fetched > ? ORDER BY COALESCE(published, fetched) DESC LIMIT 30",
        (f'%"{mid}"%', time.time() - 48 * 3600))]
    return d
