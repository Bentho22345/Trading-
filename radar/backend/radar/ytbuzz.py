"""YouTube, used to the edge of the free quota (10,000 units/day), through the official Data API only.

  quota      one meter for every YouTube call Radar makes (search = 100 units, list calls = 1) with a daily cap
  buzz       hourly: the newest memecoin videos → which $tickers / contract addresses / coin names they mention, plus
             their live view counts → a "YouTube buzz" signal on matching launches (Snipe) and the intel feed
  channels   creators whose strategy videos produced real filters are followed through their uploads playlist
             (1 unit instead of a 100-unit search) so new strategy videos are digested the day they drop
  comments   a strategy video's top comments (often the creator's pinned filter settings) are digested with it

YouTube's API doesn't give other channels' captions, so Radar reads titles, descriptions and comments — no scraping.
"""
from __future__ import annotations

import asyncio
import calendar
import json
import logging
import os
import re
import time
from typing import Any

import httpx

from . import feed
from .health import Health, register

log = logging.getLogger("radar.ytbuzz")
buzz_h = register(Health("youtube_buzz", "rest", "YouTube buzz: memecoin videos mentioning live coins (hourly)"))
buzz_h.stale_after = 3 * 3600
YT = os.environ.get("YOUTUBE_API_URL", "https://www.googleapis.com/youtube/v3")
CASHTAG = re.compile(r"\$([A-Za-z][A-Za-z0-9]{1,11})\b")
CA = re.compile(r"\b([1-9A-HJ-NP-Za-km-z]{32,44})\b")
STOP = {"SOL", "USDC", "USDT", "BTC", "ETH", "PUMP", "MEME", "AI", "CTO", "DEV", "THE", "CAT", "DOG", "USD", "BONK", "WIF",
        "TRUMP", "XRP", "BNB"}
BUZZ_Q = "memecoin|meme coin|pump.fun|solana gem|100x coin|new crypto launch"


class Quota:
    def __init__(self) -> None:
        self.cap = int(os.environ.get("YOUTUBE_DAILY_UNITS", "9000"))
        self.day = int(time.time() // 86400)
        self.used = 0
        self.by: dict[str, int] = {}

    def can(self, units: int) -> bool:
        d = int(time.time() // 86400)
        if d != self.day:
            self.day, self.used, self.by = d, 0, {}
        return self.used + units <= self.cap

    def spend(self, units: int, what: str) -> None:
        self.can(0)
        self.used += units
        self.by[what] = self.by.get(what, 0) + units

    def snapshot(self) -> dict[str, Any]:
        self.can(0)
        return {"used": self.used, "cap": self.cap, "by": dict(self.by), "resets_in_s": round(86400 - time.time() % 86400)}


quota = Quota()


async def yt_get(client: httpx.AsyncClient, path: str, params: dict[str, Any], key: str, units: int, what: str) -> dict[str, Any]:
    if not quota.can(units):
        raise RuntimeError("YouTube daily quota reserved by Radar is used up")
    r = await client.get(f"{YT}/{path}", params={**params, "key": key})
    quota.spend(units, what)
    if r.status_code == 403 and "quota" in r.text.lower():
        quota.used = quota.cap
        raise RuntimeError("YouTube quota exceeded for today")
    r.raise_for_status()
    return r.json()


def mentions(text: str) -> tuple[list[str], list[str]]:
    tags = sorted({t.upper() for t in CASHTAG.findall(text or "") if t.upper() not in STOP})
    cas = sorted({c for c in CA.findall(text or "") if len(c) >= 32 and not c.isdigit()})
    return tags, cas


class YouTubeBuzz:
    def __init__(self, db: Any, connectors: Any, alerts: Any) -> None:
        self.db, self.connectors, self.alerts = db, connectors, alerts
        self.client = httpx.AsyncClient(timeout=15)
        self.by_tag: dict[str, list[dict[str, Any]]] = {}
        self.by_ca: dict[str, list[dict[str, Any]]] = {}
        self.titles: list[tuple[str, dict[str, Any]]] = []
        self.last_run: float | None = None
        self.sniper: Any = None
        self.every = float(os.environ.get("YT_BUZZ_EVERY", "3600"))

    async def key(self) -> str | None:
        return (await self.connectors.values("youtube")).get("api_key")

    # ---------------- index (memory, read by the snipe context loop) ----------------
    async def reindex(self) -> None:
        rows = await self.db.all("SELECT * FROM yt_videos WHERE published > ? ORDER BY views DESC", (time.time() - 48 * 3600,))
        by_tag: dict[str, list[dict[str, Any]]] = {}
        by_ca: dict[str, list[dict[str, Any]]] = {}
        titles = []
        for r in rows:
            v = {"id": r["id"], "title": r["title"], "channel": r["channel"], "views": int(r["views"] or 0), "published": r["published"]}
            for t in json.loads(r["tickers_json"] or "[]"):
                by_tag.setdefault(t, []).append(v)
            for c in json.loads(r["cas_json"] or "[]"):
                by_ca.setdefault(c, []).append(v)
            titles.append(((r["title"] or "").lower(), v))
        self.by_tag, self.by_ca, self.titles = by_tag, by_ca, titles

    def match(self, mint: str, symbol: str | None, name: str | None) -> dict[str, Any] | None:
        vids: dict[str, dict[str, Any]] = {}
        for v in self.by_ca.get(mint, []):
            vids[v["id"]] = v
        sym = (symbol or "").upper()
        if len(sym) >= 3 and sym not in STOP:
            for v in self.by_tag.get(sym, []):
                vids[v["id"]] = v
        nm = (name or "").lower().strip()
        if len(nm) >= 6 and nm not in ("solana", "memecoin", "pump fun"):
            rx = re.compile(rf"\b{re.escape(nm)}\b")
            for t, v in self.titles:
                if rx.search(t):
                    vids[v["id"]] = v
        if not vids:
            return None
        lst = sorted(vids.values(), key=lambda v: -v["views"])
        return {"videos": len(lst), "views": sum(v["views"] for v in lst), "top": lst[0]["title"], "list": lst[:5]}

    # ---------------- hourly buzz search ----------------
    async def run_once(self) -> int:
        key = await self.key()
        if not key:
            return 0
        t0 = time.perf_counter()
        after = self.last_run - 600 if self.last_run else time.time() - 3 * 3600
        j = await yt_get(self.client, "search", {"part": "snippet", "q": BUZZ_Q, "type": "video", "order": "date", "maxResults": 50,
                                                 "publishedAfter": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(after))},
                         key, 100, "buzz search")
        self.last_run = time.time()
        ids = [i["id"]["videoId"] for i in j.get("items", []) if (i.get("id") or {}).get("videoId")]
        # also refresh view counts of recent videos already indexed (views decide how loud the buzz is)
        old = [r["id"] for r in await self.db.all("SELECT id FROM yt_videos WHERE published > ? ORDER BY published DESC LIMIT 100",
                                                  (time.time() - 48 * 3600,))]
        ids = list(dict.fromkeys(ids + old))
        new = 0
        for i in range(0, len(ids), 50):
            d = await yt_get(self.client, "videos", {"part": "snippet,statistics", "id": ",".join(ids[i:i + 50])}, key, 1, "buzz stats")
            for it in d.get("items", []):
                sn, st = it.get("snippet") or {}, it.get("statistics") or {}
                text = f"{sn.get('title', '')}\n{sn.get('description', '')}"
                tags, cas = mentions(text)
                pub = sn.get("publishedAt")
                ts = calendar.timegm(time.strptime(pub[:19], "%Y-%m-%dT%H:%M:%S")) if pub else time.time()
                prev = await self.db.one("SELECT id FROM yt_videos WHERE id=?", (it["id"],))
                await self.db.upsert("yt_videos", {"id": it["id"], "title": sn.get("title"), "channel": sn.get("channelTitle"),
                                                   "channel_id": sn.get("channelId"), "published": ts,
                                                   "views": float(st.get("viewCount") or 0), "likes": float(st.get("likeCount") or 0),
                                                   "comments": float(st.get("commentCount") or 0), "tickers_json": json.dumps(tags),
                                                   "cas_json": json.dumps(cas), "fetched": time.time()}, "id")
                if prev is None:
                    new += 1
                    await self._announce(it["id"], sn, tags, cas, float(st.get("viewCount") or 0))
        await self.db.exec("DELETE FROM yt_videos WHERE published < ?", (time.time() - 7 * 86400,))
        await self.reindex()
        buzz_h.ok((time.perf_counter() - t0) * 1000)
        return new

    async def _announce(self, vid: str, sn: dict[str, Any], tags: list[str], cas: list[str], views: float) -> None:
        live = self.sniper.launches if self.sniper else {}
        hit = next((c for c in cas if c in live), None)
        if hit is None and tags:
            sym = {(L.symbol or "").upper(): m for m, L in live.items() if L.symbol}
            hit = next((sym[t] for t in tags if t in sym), None)
        if not (tags or cas):
            return
        what = ", ".join([f"${t}" for t in tags[:4]] + [c[:6] + "…" for c in cas[:2]])
        await feed.push("youtube", "mention", f"▶ {sn.get('channelTitle') or 'YouTube'}: {what}", sn.get("title") or "", hit,
                        url=f"https://www.youtube.com/watch?v={vid}", views=views)
        if hit:
            L = live[hit]
            await self.alerts.send("info", f"▶ YouTube video on live coin ${L.symbol or hit[:6]}",
                                   f"{sn.get('channelTitle')}: {sn.get('title')}\nhttps://www.youtube.com/watch?v={vid}",
                                   token=hit, dedupe=f"yt:{hit}", ttl=6 * 3600)

    async def loop(self) -> None:
        await self.reindex()
        await asyncio.sleep(float(os.environ.get("YT_BUZZ_DELAY", "45")))
        while True:
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                buzz_h.fail(f"{type(e).__name__}: {e}"[:200])
            await asyncio.sleep(self.every)

    def snapshot(self) -> dict[str, Any]:
        return {"videos_48h": len(self.titles), "tickers": len(self.by_tag), "contracts": len(self.by_ca), "last_run": self.last_run,
                "every_s": self.every}
