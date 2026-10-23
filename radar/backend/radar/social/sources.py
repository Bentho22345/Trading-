"""Social adapters. Each produces normalized events and hands them to SocialEngine.ingest().

Keyless: Bluesky Jetstream firehose (real time), 4chan /biz/ (official read-only JSON API).
Keyed (Connectors page): X API, Telegram (Telethon user client), Reddit OAuth, Farcaster (Neynar), YouTube.
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import re
import time
from datetime import datetime
from typing import Any, Awaitable, Callable

import httpx
import websockets

from ..health import Health, register
from ..ratelimit import TokenBucket
from ..adapters.http import USER_AGENT

log = logging.getLogger("radar.social")
Ingest = Callable[[dict[str, Any]], Awaitable[None]]

x_h = register(Health("x", "rest", "X API: VIP watchlist + keyword/cashtag search (pay-per-use)"))
tg_h = register(Health("telegram", "stream", "Telegram public channels via your account (Telethon)"))
bsky_h = register(Health("bluesky", "stream", "Bluesky Jetstream firehose, filtered for crypto/CA/cashtags (keyless)"))
chan_h = register(Health("4chan_biz", "rest", "4chan /biz/ catalog via official read-only API (keyless)"))
reddit_h = register(Health("reddit_api", "rest", "Reddit OAuth API (rising/new posts)"))
neynar_h = register(Health("farcaster", "rest", "Farcaster trending casts via Neynar"))
yt_h = register(Health("youtube", "rest", "YouTube trending videos (mainstream confirmation)"))
for h in (x_h, reddit_h, neynar_h, yt_h):
    h.stale_after = 900
chan_h.stale_after = 300
bsky_h.stale_after = 60


def _iso(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


CRYPTO_HINT = re.compile(r"(\$[A-Za-z][A-Za-z0-9]{1,14}\b|pump\.fun|pumpfun|memecoin|meme coin|solana|\bCA\b|contract address|"
                         r"[1-9A-HJ-NP-Za-km-z]{32,44}pump\b|dexscreener|raydium|bonk|airdrop)", re.I)


class XSource:
    """Polls VIP timelines via one batched recent-search (from:a OR from:b ...) + keyword searches, using since_id."""

    BASE = "https://api.x.com/2"

    def __init__(self, ingest: Ingest, cfg: Any, values: Callable[[], Awaitable[dict[str, str]]], db: Any) -> None:
        self.ingest, self.cfg, self.values, self.db = ingest, cfg, values, db
        self.bucket = TokenBucket(50, burst=5)
        x_h.headroom_fn = self.bucket.headroom
        self.since: dict[str, str] = {}

    async def spent_today(self) -> float:
        start = time.time() - (time.time() % 86400)
        row = await self.db.one("SELECT COALESCE(SUM(cost_usd),0) c FROM api_usage WHERE adapter='x' AND ts>=?", (start,))
        return float(row["c"])

    async def budget(self, v: dict[str, str]) -> float:
        try:
            return float(v.get("daily_budget_usd") or 5)
        except ValueError:
            return 5.0

    def _vip_queries(self) -> list[str]:
        handles = [x["handle"] for x in self.cfg.watch.get("x_vips") or []]
        out, cur = [], []
        for h in handles:
            trial = " OR ".join(f"from:{x}" for x in [*cur, h])
            if len(trial) > 480 and cur:
                out.append(" OR ".join(f"from:{x}" for x in cur))
                cur = [h]
            else:
                cur.append(h)
        if cur:
            out.append(" OR ".join(f"from:{x}" for x in cur))
        return [f"({q}) -is:retweet" for q in out]

    async def _search(self, client: httpx.AsyncClient, token: str, query: str, tag: str) -> int:
        await self.bucket.acquire()
        params = {"query": query, "max_results": 50,
                  "tweet.fields": "created_at,public_metrics,entities,author_id",
                  "expansions": "author_id", "user.fields": "username,name,public_metrics,created_at,verified"}
        if self.since.get(query):
            params["since_id"] = self.since[query]
        t0 = time.perf_counter()
        r = await client.get(f"{self.BASE}/tweets/search/recent", params=params, headers={"Authorization": f"Bearer {token}"})
        ms = (time.perf_counter() - t0) * 1000
        if r.status_code == 429:
            reset = float(r.headers.get("x-rate-limit-reset", time.time() + 60))
            self.bucket.penalize(max(5, reset - time.time()))
            x_h.fail("429 rate limited", rate_limited=True)
            return 0
        if r.status_code >= 400:
            x_h.fail(f"HTTP {r.status_code}: {r.text[:160]}")
            return 0
        x_h.ok(ms)
        d = r.json()
        posts = d.get("data") or []
        cost = len(posts) * float(self.cfg.watch.get("x_cost_per_post_read_usd", 0.005))
        await self.db.exec("INSERT INTO api_usage (ts, adapter, path, status, latency_ms, cost_usd) VALUES (?,?,?,?,?,?)",
                           (time.time(), "x", tag, r.status_code, ms, cost))
        if d.get("meta", {}).get("newest_id"):
            self.since[query] = d["meta"]["newest_id"]
        users = {u["id"]: u for u in (d.get("includes") or {}).get("users", [])}
        vip = {x["handle"].lower(): x.get("tier", "vip") for x in self.cfg.watch.get("x_vips") or []}
        for p in posts:
            u = users.get(p.get("author_id"), {})
            m = p.get("public_metrics") or {}
            handle = u.get("username") or p.get("author_id")
            await self.ingest({
                "id": f"x:{p['id']}", "source": "x", "author": handle, "author_name": u.get("name"),
                "followers": (u.get("public_metrics") or {}).get("followers_count"),
                "author_created": _iso(u.get("created_at")), "verified": u.get("verified"),
                "tier_hint": vip.get((handle or "").lower()),
                "text": p.get("text") or "", "url": f"https://x.com/{handle}/status/{p['id']}",
                "ts": _iso(p.get("created_at")) or time.time(),
                "engagement": (m.get("like_count", 0) + 2 * m.get("retweet_count", 0) + m.get("reply_count", 0)
                               + 2 * m.get("quote_count", 0)),
            })
        return len(posts)

    async def run(self) -> None:
        last_search = 0.0
        async with httpx.AsyncClient(timeout=15) as client:
            while True:
                try:
                    v = await self.values()
                    token = v.get("bearer_token")
                    if not token:
                        x_h.last_error_msg = "not connected (add a bearer token on Connectors)"
                        await asyncio.sleep(10)
                        continue
                    if await self.spent_today() >= await self.budget(v):
                        x_h.last_error_msg = "daily X budget reached — polling paused until UTC midnight"
                        await asyncio.sleep(60)
                        continue
                    for q in self._vip_queries():
                        await self._search(client, token, q, "vip")
                    if time.time() - last_search >= float(self.cfg.watch.get("x_search_every_s", 120)):
                        last_search = time.time()
                        for q in self.cfg.watch.get("x_search_terms") or []:
                            await self._search(client, token, q, "search")
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    x_h.fail(f"{type(e).__name__}: {e}")
                await asyncio.sleep(float(self.cfg.watch.get("x_poll_every_s", 30)))


class BlueskySource:
    """Bluesky Jetstream: a public, keyless, real-time JSON firehose of every post. We keep only crypto-relevant ones."""

    URL = "wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post"

    def __init__(self, ingest: Ingest) -> None:
        self.ingest = ingest

    async def run(self) -> None:
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(self.URL, max_size=2**21, open_timeout=15, ping_interval=20) as ws:
                    bsky_h.connected = True
                    bsky_h.ok()
                    backoff = 1.0
                    async for raw in ws:
                        bsky_h.messages += 1
                        bsky_h.last_ok = time.time()
                        if "app.bsky.feed.post" not in raw or not CRYPTO_HINT.search(raw):
                            continue
                        try:
                            m = json.loads(raw)
                            c = m.get("commit") or {}
                            rec = c.get("record") or {}
                            if c.get("operation") != "create" or not rec.get("text"):
                                continue
                            if not CRYPTO_HINT.search(rec["text"]):
                                continue
                            did = m.get("did")
                            await self.ingest({
                                "id": f"bsky:{did}:{c.get('rkey')}", "source": "bluesky", "author": did,
                                "text": rec["text"], "url": f"https://bsky.app/profile/{did}/post/{c.get('rkey')}",
                                "ts": _iso(rec.get("createdAt")) or time.time(), "engagement": 0,
                            })
                        except (ValueError, KeyError):
                            continue
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                bsky_h.fail(f"{type(e).__name__}: {e}")
            bsky_h.connected = False
            await asyncio.sleep(backoff)
            backoff = min(60, backoff * 2)


class FourChanBiz:
    """Official read-only JSON API (a.4cdn.org). Rules: <= 1 request/second, use If-Modified-Since."""

    def __init__(self, ingest: Ingest) -> None:
        self.ingest = ingest
        self.bucket = TokenBucket(30, burst=1)
        chan_h.headroom_fn = self.bucket.headroom
        self.last_mod: str | None = None
        self.seen_replies: dict[int, int] = {}

    async def run(self) -> None:
        async with httpx.AsyncClient(timeout=15, headers={"User-Agent": USER_AGENT}) as client:
            while True:
                try:
                    await self.bucket.acquire()
                    headers = {"If-Modified-Since": self.last_mod} if self.last_mod else {}
                    t0 = time.perf_counter()
                    r = await client.get("https://a.4cdn.org/biz/catalog.json", headers=headers)
                    if r.status_code == 304:
                        chan_h.ok((time.perf_counter() - t0) * 1000)
                    else:
                        r.raise_for_status()
                        chan_h.ok((time.perf_counter() - t0) * 1000)
                        self.last_mod = r.headers.get("Last-Modified")
                        for page in r.json():
                            for th in page.get("threads", []):
                                no, replies = th.get("no"), th.get("replies", 0)
                                if self.seen_replies.get(no) == replies:
                                    continue
                                first = no not in self.seen_replies
                                self.seen_replies[no] = replies
                                text = html.unescape(re.sub(r"<[^>]+>", " ", f"{th.get('sub', '')} {th.get('com', '')}"))
                                if not first or not CRYPTO_HINT.search(text):
                                    continue
                                await self.ingest({
                                    "id": f"4chan:{no}", "source": "4chan", "author": "anon", "text": text[:2000],
                                    "url": f"https://boards.4chan.org/biz/thread/{no}", "ts": float(th.get("time") or time.time()),
                                    "engagement": replies,
                                })
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    chan_h.fail(f"{type(e).__name__}: {e}")
                await asyncio.sleep(60)


class RedditAPI:
    SUBS = ["memecoins", "solana", "CryptoCurrency", "wallstreetbets", "CryptoMoonShots", "SatoshiStreetBets", "politics", "news"]

    def __init__(self, ingest: Ingest, values: Callable[[], Awaitable[dict[str, str]]]) -> None:
        self.ingest, self.values = ingest, values
        self.token: tuple[str, float] | None = None
        self.bucket = TokenBucket(60, burst=5)  # Reddit free tier: 100 QPM per OAuth client
        reddit_h.headroom_fn = self.bucket.headroom

    async def run(self) -> None:
        async with httpx.AsyncClient(timeout=15, headers={"User-Agent": "MemecoinRadar/0.1 (personal)"}) as client:
            while True:
                try:
                    v = await self.values()
                    if not v.get("client_id") or not v.get("client_secret"):
                        await asyncio.sleep(30)
                        continue
                    if not self.token or self.token[1] < time.time() + 60:
                        r = await client.post("https://www.reddit.com/api/v1/access_token",
                                              data={"grant_type": "client_credentials"}, auth=(v["client_id"], v["client_secret"]))
                        r.raise_for_status()
                        d = r.json()
                        self.token = (d["access_token"], time.time() + float(d.get("expires_in", 3600)))
                    for sub in self.SUBS:
                        for lst in ("new", "rising"):
                            await self.bucket.acquire()
                            t0 = time.perf_counter()
                            r = await client.get(f"https://oauth.reddit.com/r/{sub}/{lst}", params={"limit": 50},
                                                 headers={"Authorization": f"Bearer {self.token[0]}"})
                            if r.status_code >= 400:
                                reddit_h.fail(f"HTTP {r.status_code}")
                                continue
                            reddit_h.ok((time.perf_counter() - t0) * 1000)
                            for ch in (r.json().get("data") or {}).get("children", []):
                                p = ch.get("data") or {}
                                await self.ingest({
                                    "id": f"reddit:{p.get('id')}", "source": "reddit", "author": p.get("author"),
                                    "text": f"{p.get('title', '')}\n{(p.get('selftext') or '')[:1000]}",
                                    "url": f"https://reddit.com{p.get('permalink', '')}", "ts": float(p.get("created_utc") or time.time()),
                                    "engagement": (p.get("score") or 0) + 2 * (p.get("num_comments") or 0), "group": sub,
                                })
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    reddit_h.fail(f"{type(e).__name__}: {e}")
                await asyncio.sleep(60)


class NeynarSource:
    def __init__(self, ingest: Ingest, values: Callable[[], Awaitable[dict[str, str]]]) -> None:
        self.ingest, self.values = ingest, values

    async def run(self) -> None:
        async with httpx.AsyncClient(timeout=15) as client:
            while True:
                try:
                    v = await self.values()
                    if v.get("api_key"):
                        t0 = time.perf_counter()
                        r = await client.get("https://api.neynar.com/v2/farcaster/feed/trending",
                                             params={"limit": 10, "time_window": "1h"}, headers={"x-api-key": v["api_key"]})
                        r.raise_for_status()
                        neynar_h.ok((time.perf_counter() - t0) * 1000)
                        for c in r.json().get("casts", []):
                            a = c.get("author") or {}
                            rx = c.get("reactions") or {}
                            await self.ingest({
                                "id": f"fc:{c.get('hash')}", "source": "farcaster", "author": a.get("username"),
                                "followers": a.get("follower_count"), "text": c.get("text") or "",
                                "url": f"https://warpcast.com/{a.get('username')}/{(c.get('hash') or '')[:10]}",
                                "ts": _iso(c.get("timestamp")) or time.time(),
                                "engagement": (rx.get("likes_count") or 0) + 2 * (rx.get("recasts_count") or 0),
                            })
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    neynar_h.fail(f"{type(e).__name__}: {e}")
                await asyncio.sleep(120)


class YouTubeSource:
    def __init__(self, ingest: Ingest, values: Callable[[], Awaitable[dict[str, str]]]) -> None:
        self.ingest, self.values = ingest, values

    async def run(self) -> None:
        async with httpx.AsyncClient(timeout=15) as client:
            while True:
                try:
                    v = await self.values()
                    from ..ytbuzz import quota
                    if v.get("api_key") and quota.can(1):
                        t0 = time.perf_counter()
                        quota.spend(1, "trending chart")
                        r = await client.get(f"{__import__('radar.ytbuzz', fromlist=['YT']).YT}/videos",
                                             params={"part": "snippet,statistics", "chart": "mostPopular", "regionCode": "US",
                                                     "maxResults": 50, "key": v["api_key"]})
                        r.raise_for_status()
                        yt_h.ok((time.perf_counter() - t0) * 1000)
                        for it in r.json().get("items", []):
                            sn, st = it.get("snippet") or {}, it.get("statistics") or {}
                            await self.ingest({
                                "id": f"yt:{it.get('id')}", "source": "youtube", "author": sn.get("channelTitle"),
                                "text": f"{sn.get('title', '')}", "url": f"https://youtube.com/watch?v={it.get('id')}",
                                "ts": _iso(sn.get("publishedAt")) or time.time(),
                                "engagement": float(st.get("viewCount") or 0) / 1000, "tier_hint": "news",
                            })
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    yt_h.fail(f"{type(e).__name__}: {e}")
                await asyncio.sleep(900)  # 10k units/day quota; this uses ~100/day


class TelegramSource:
    """Telethon user client reading PUBLIC channels you list. Login once via the Connectors page (code flow)."""

    def __init__(self, ingest: Ingest, values: Callable[[], Awaitable[dict[str, str]]], cfg: Any) -> None:
        self.ingest, self.values, self.cfg = ingest, values, cfg
        self.client: Any = None
        self.pending_hash: str | None = None

    async def _client(self) -> Any:
        from telethon import TelegramClient
        from telethon.sessions import StringSession
        v = await self.values()
        if not v.get("api_id") or not v.get("api_hash"):
            return None
        sess = await self.cfg.kv_get("telegram:session")
        if self.client is None:
            self.client = TelegramClient(StringSession(sess or ""), int(v["api_id"]), v["api_hash"])
        if not self.client.is_connected():
            await self.client.connect()
        return self.client

    async def send_code(self) -> str:
        c = await self._client()
        if not c:
            raise ValueError("Save api_id and api_hash first")
        v = await self.values()
        sent = await c.send_code_request(v["phone"])
        self.pending_hash = sent.phone_code_hash
        return "Code sent to your Telegram app"

    async def sign_in(self, code: str, password: str | None = None) -> str:
        c = await self._client()
        v = await self.values()
        try:
            await c.sign_in(phone=v["phone"], code=code, phone_code_hash=self.pending_hash)
        except Exception as e:  # noqa: BLE001 - 2FA accounts need the cloud password
            if "password" in str(e).lower() and password:
                await c.sign_in(password=password)
            else:
                raise
        await self.cfg.kv_set("telegram:session", c.session.save())
        return "Signed in. Channel reader starting."

    async def run(self) -> None:
        from telethon import events
        while True:
            try:
                c = await self._client()
                if not c or not await c.is_user_authorized():
                    tg_h.connected = False
                    tg_h.last_error_msg = "not signed in (Connectors → Telegram channels → Send code)"
                    await asyncio.sleep(20)
                    continue
                v = await self.values()
                chans = [x.strip().lstrip("@") for x in (v.get("channels") or "").split(",") if x.strip()]
                chans += [x.lstrip("@") for x in self.cfg.watch.get("telegram_channels") or []]
                if not chans:
                    tg_h.last_error_msg = "signed in, but no channels listed"
                    await asyncio.sleep(30)
                    continue

                async def handler(ev: Any) -> None:
                    chat = await ev.get_chat()
                    uname = getattr(chat, "username", None) or str(ev.chat_id)
                    tg_h.messages += 1
                    tg_h.last_ok = time.time()
                    await self.ingest({
                        "id": f"tg:{ev.chat_id}:{ev.id}", "source": "telegram", "author": uname,
                        "followers": getattr(chat, "participants_count", None), "text": ev.raw_text or "",
                        "url": f"https://t.me/{uname}/{ev.id}" if getattr(chat, "username", None) else None,
                        "ts": ev.date.timestamp() if ev.date else time.time(), "engagement": getattr(ev.message, "views", 0) or 0,
                    })

                c.add_event_handler(handler, events.NewMessage(chats=chans))
                tg_h.connected = True
                tg_h.ok()
                await c.run_until_disconnected()
                c.remove_event_handler(handler)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                tg_h.fail(f"{type(e).__name__}: {e}")
                tg_h.connected = False
                await asyncio.sleep(30)
