"""Free, keyless trend sources — what the internet is talking about outside crypto, where most memes start.

  Bluesky    trending topics (public AppView API)                          every 5 min
  Mastodon   trending hashtags on mastodon.social, with usage counts        every 10 min
  Wikipedia  the day's most-read articles (Wikimedia feed API)              every hour
  HackerNews top stories (official Firebase API) — tech / AI memes          every 10 min

All are official public APIs (no scraping). Each item feeds the narrative engine, the trend board, and a matcher: a
pump.fun launch named after something trending right now gets a "Trending off-crypto" read in Snipe.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import Any

import httpx

from . import feed
from .adapters.http import USER_AGENT
from .health import Health, register

log = logging.getLogger("radar.trends")
H = {name: register(Health(f"trends_{name}", "rest", desc)) for name, desc in (
    ("bluesky", "Bluesky trending topics (keyless)"), ("mastodon", "Mastodon trending hashtags (keyless)"),
    ("wikipedia", "Wikipedia most-read articles today (keyless)"), ("hackernews", "Hacker News top stories (keyless)"))}
for h in H.values():
    h.stale_after = 3 * 3600
SKIP = {"main page", "special:search", "deaths in 2026", "wikipedia", "help", "portal:current events"}
EVERY = {"bluesky": 300, "mastodon": 600, "wikipedia": 3600, "hackernews": 600}


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


class Trends:
    def __init__(self, db: Any, social: Any) -> None:
        self.db, self.social = db, social
        self.client = httpx.AsyncClient(timeout=15, headers={"User-Agent": USER_AGENT}, follow_redirects=True)
        self.items: dict[str, dict[str, Any]] = {}       # norm(term) -> item
        self.sniper: Any = None
        self.last: dict[str, float] = {}

    def base(self, name: str, default: str) -> str:
        return os.environ.get(f"TRENDS_{name.upper()}_URL", default)

    async def bluesky(self) -> list[dict[str, Any]]:
        r = await self.client.get(f"{self.base('bluesky', 'https://public.api.bsky.app')}/xrpc/app.bsky.unspecced.getTrendingTopics",
                                  params={"limit": 25})
        r.raise_for_status()
        out = []
        for i, t in enumerate(r.json().get("topics") or []):
            name = t.get("displayName") or t.get("topic")
            if name:
                link = t.get("link") or ""
                out.append({"term": name, "url": f"https://bsky.app{link}" if link.startswith("/") else link or None, "rank": i + 1, "score": None})
        return out

    async def mastodon(self) -> list[dict[str, Any]]:
        r = await self.client.get(f"{self.base('mastodon', 'https://mastodon.social')}/api/v1/trends/tags", params={"limit": 20})
        r.raise_for_status()
        out = []
        for i, t in enumerate(r.json() or []):
            uses = sum(int(h.get("uses") or 0) for h in (t.get("history") or [])[:1])
            out.append({"term": t.get("name"), "url": t.get("url"), "rank": i + 1, "score": uses})
        return [o for o in out if o["term"]]

    async def wikipedia(self) -> list[dict[str, Any]]:
        d = time.gmtime(time.time() - 3600)
        r = await self.client.get(f"{self.base('wikipedia', 'https://api.wikimedia.org')}/feed/v1/wikipedia/en/featured/"
                                  f"{d.tm_year}/{d.tm_mon:02d}/{d.tm_mday:02d}")
        r.raise_for_status()
        out = []
        for a in ((r.json().get("mostread") or {}).get("articles") or [])[:30]:
            title = ((a.get("titles") or {}).get("normalized")) or a.get("title")
            if title and title.lower() not in SKIP and ":" not in title:
                out.append({"term": title, "url": ((a.get("content_urls") or {}).get("desktop") or {}).get("page"),
                            "rank": a.get("rank"), "score": a.get("views")})
        return out

    async def hackernews(self) -> list[dict[str, Any]]:
        base = self.base("hackernews", "https://hacker-news.firebaseio.com")
        r = await self.client.get(f"{base}/v0/topstories.json")
        r.raise_for_status()
        ids = (r.json() or [])[:15]
        items = await asyncio.gather(*(self.client.get(f"{base}/v0/item/{i}.json") for i in ids), return_exceptions=True)
        out = []
        for rank, it in enumerate(items, 1):
            if isinstance(it, Exception) or it.status_code != 200:
                continue
            j = it.json() or {}
            if j.get("title"):
                out.append({"term": j["title"], "url": j.get("url") or f"https://news.ycombinator.com/item?id={j.get('id')}", "rank": rank,
                            "score": j.get("score")})
        return out

    async def poll(self, name: str) -> int:
        t0 = time.perf_counter()
        rows = await getattr(self, name)()
        H[name].ok((time.perf_counter() - t0) * 1000)
        now = time.time()
        new = 0
        for r in rows:
            key = norm(r["term"])
            if len(key) < 3:
                continue
            prev = self.items.get(key)
            item = {"term": r["term"], "source": name, "url": r.get("url"), "rank": r.get("rank"), "score": r.get("score"),
                    "first_seen": prev["first_seen"] if prev else now, "ts": now,
                    "sources": sorted(set((prev or {}).get("sources", [])) | {name}),
                    "words": [norm(w) for w in re.split(r"\W+", r["term"]) if len(w) >= 4]}
            self.items[key] = item
            if prev is None:
                new += 1
                await self.db.exec("INSERT OR REPLACE INTO trend_items (key, term, source, url, rank, score, ts) VALUES (?,?,?,?,?,?,?)",
                                   (key, r["term"], name, r.get("url"), r.get("rank"), r.get("score"), now))
                if self.social is not None and name != "hackernews":
                    try:
                        await self.social.ingest({"id": f"trend:{name}:{key}", "source": "trends", "author": name, "tier_hint": "news",
                                                  "text": f"Trending on {name}: {r['term']}", "url": r.get("url"), "ts": now,
                                                  "engagement": float(r.get("score") or 0) / 100})
                    except Exception as e:  # noqa: BLE001
                        log.debug("trend ingest: %s", e)
        cut = now - 12 * 3600
        self.items = {k: v for k, v in self.items.items() if v["ts"] > cut}
        return new

    async def loop(self) -> None:
        for r in await self.db.all("SELECT * FROM trend_items WHERE ts > ?", (time.time() - 12 * 3600,)):
            self.items[r["key"]] = {"term": r["term"], "source": r["source"], "url": r["url"], "rank": r["rank"], "score": r["score"],
                                    "first_seen": r["ts"], "ts": r["ts"], "sources": [r["source"]],
                                    "words": [norm(w) for w in re.split(r"\W+", r["term"] or "") if len(w) >= 4]}
        await asyncio.sleep(float(os.environ.get("TRENDS_DELAY", "20")))
        while True:
            now = time.time()
            for name, every in EVERY.items():
                if now - self.last.get(name, 0) >= float(os.environ.get("TRENDS_EVERY", every)):
                    self.last[name] = now
                    try:
                        await self.poll(name)
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:  # noqa: BLE001
                        H[name].fail(f"{type(e).__name__}: {e}"[:200])
            await asyncio.sleep(5)

    # ---------------- matching launches ----------------
    def match(self, name: str | None, symbol: str | None) -> dict[str, Any] | None:
        """A launch named after a live trend: exact name / ticker, or the trend's distinctive word in the name."""
        nm, sym = norm(name or ""), norm(symbol or "")
        if not (nm or sym):
            return None
        best = None
        for key, it in self.items.items():
            words = it.get("words") or []
            hit = key == nm or (len(key) >= 4 and key == sym) or (len(nm) >= 5 and nm in key and len(nm) >= len(key) * 0.5) \
                or (len(words) == 1 and words[0] and (words[0] == nm or words[0] == sym))
            if hit and (best is None or (it.get("rank") or 99) < (best.get("rank") or 99)):
                best = it
        return {"term": best["term"], "sources": best["sources"], "url": best.get("url"), "rank": best.get("rank")} if best else None

    def board(self, limit: int = 60) -> list[dict[str, Any]]:
        rows = sorted(self.items.values(), key=lambda r: (-len(r["sources"]), r["source"], r.get("rank") or 99))
        return [{k: v for k, v in r.items() if k != "words"} for r in rows[:limit]]

    async def announce_match(self, L: Any, m: dict[str, Any]) -> None:
        await feed.push("trends", "match", f"🌐 ${L.symbol or L.mint[:6]} is named after a live trend: {m['term']}",
                        f"trending on {', '.join(m['sources'])}", L.mint, url=m.get("url"))
