"""RSS/Atom polling (keyless). Also used by user-added custom sources."""
from __future__ import annotations

import calendar
import hashlib
import re
import time
from typing import Any

import feedparser
import httpx

from ..health import Health, register
from ..ratelimit import TokenBucket
from .http import USER_AGENT

health = register(Health("rss", "rest", "News RSS, Reddit RSS, Google News & Google Trends feeds"))
health.stale_after = 600
bucket = TokenBucket(240, burst=20)
health.headroom_fn = bucket.headroom

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=15, follow_redirects=True, headers={"User-Agent": USER_AGENT})
    return _client


def parse_feed(text: str, source: str) -> list[dict[str, Any]]:
    fp = feedparser.parse(text)
    out = []
    now = time.time()
    for e in fp.entries[:60]:
        title = (e.get("title") or "").strip()
        link = e.get("link") or ""
        if not title:
            continue
        st = e.get("published_parsed") or e.get("updated_parsed")
        pub = float(calendar.timegm(st)) if st else None
        out.append({
            "id": hashlib.sha1(f"{source}|{link or title}".encode()).hexdigest()[:20],
            "source": source, "title": re.sub(r"\s+", " ", title)[:400], "link": link,
            "published": pub, "fetched": now,
            "traffic": e.get("ht_approx_traffic"),  # Google Trends extension
        })
    return out


# url -> (etag, last-modified): conditional GETs make fast polling cheap for us and polite to publishers
_validators: dict[str, tuple[str | None, str | None]] = {}


async def fetch(url: str, source: str, headers: dict[str, str] | None = None, h: Health | None = None,
                conditional: bool = False) -> list[dict[str, Any]]:
    """conditional=True sends ETag/Last-Modified validators and returns [] when the feed hasn't changed (304)."""
    h = h or health
    await bucket.acquire()
    t0 = time.perf_counter()
    hdrs = dict(headers or {})
    etag, modified = _validators.get(url, (None, None)) if conditional else (None, None)
    if etag:
        hdrs["If-None-Match"] = etag
    if modified:
        hdrs["If-Modified-Since"] = modified
    try:
        r = await client().get(url, headers=hdrs)
        if r.status_code == 304:
            h.ok((time.perf_counter() - t0) * 1000)
            return []
        r.raise_for_status()
    except httpx.HTTPError as e:
        h.fail(f"{source}: {e}")
        raise
    h.ok((time.perf_counter() - t0) * 1000)
    if conditional and (r.headers.get("etag") or r.headers.get("last-modified")):
        _validators[url] = (r.headers.get("etag"), r.headers.get("last-modified"))
    return parse_feed(r.text, source)


FEED_LINK = re.compile(r'<link[^>]+type=["\']application/(?:rss|atom)\+xml["\'][^>]*>', re.I)
HREF = re.compile(r'href=["\']([^"\']+)["\']', re.I)


async def discover(url: str) -> tuple[str, str]:
    """Given any link, return (kind, resolved_url): rss | json | websocket. Raises ValueError if unusable.

    Plain web pages are only accepted if they advertise an RSS/Atom feed — we don't scrape HTML.
    """
    if url.startswith(("ws://", "wss://")):
        return "websocket", url
    r = await client().get(url)
    r.raise_for_status()
    ctype = r.headers.get("content-type", "")
    body = r.text[:500_000]
    if "json" in ctype or body.lstrip()[:1] in ("{", "["):
        return "json", str(r.url)
    if "xml" in ctype or "<rss" in body[:2000] or "<feed" in body[:2000]:
        if feedparser.parse(body).entries:
            return "rss", str(r.url)
    m = FEED_LINK.search(body)
    if m:
        href = HREF.search(m.group(0))
        if href:
            return "rss", str(httpx.URL(str(r.url)).join(href.group(1)))
    raise ValueError("That page has no RSS/Atom feed or JSON API. Paste the site's feed or API link instead "
                     "(we don't scrape web pages).")
