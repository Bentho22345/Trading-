"""X Radar: Radar's main narrative source. It watches the people who move memecoins, scores every tweet for
"would this become a coin?", finds the coins it spawns, and learns who is worth listening to.

Built around X's pay-per-use API (each post returned costs ~$0.005; an empty answer costs nothing), so checking
often is free and only new posts cost money:

  roster      hundreds of accounts in batched `from:a OR from:b` searches with since_id, polled by tier
              (S ~10s, A ~30s, B ~90s); retweets (and replies, unless the account's replies matter) are filtered
              out by X before they are billed
  Tweet radar every post is scored for coinability (author weight, image/video, short catchy text, new names and
              phrases, cashtags / contracts, engagement velocity), then the promising ones go to Claude Haiku in
              batches for the narrative, ticker / name candidates and a meme-potential score  → the home hero
  Coin races  each hot tweet's names and tickers are matched against every pump.fun launch that follows it: how
              many coins it spawned, how fast, which one leads. Matching launches get an "X narrative" boost in
              Snipe, and a tweet that spawns a race pings your Telegram
  Callers     every $ticker / contract an account tweets is logged with the market cap at that moment and graded
              (peak ×, 1h ×). Callers who deliver are promoted (or added to the roster); the rest are demoted
  Watchers    the top accounts' names, bios and pictures (the "Kekius Maximus" move) and Elon's newest follows

Everything respects the X daily budget on the Connectors page (S-tier keeps polling to the last cent, the rest backs
off first), and every post read is metered.
"""
from __future__ import annotations

import asyncio
import calendar
import json
import logging
import math
import os
import re
import time
from collections import deque
from typing import Any

import httpx

from . import feed
from .alerts import coin_buttons
from .detect import detect
from .health import Health, register
from .ratelimit import TokenBucket
from .xroster import FOLLOW_WATCH, SEED, SOCIAL_TIER

log = logging.getLogger("radar.xradar")
xr_h = register(Health("x_radar", "rest", "X Radar: roster polling, tweet scoring, coin races, caller grading"))
xr_h.stale_after = 600

TIER_EVERY = {"S": 10.0, "A": 30.0, "B": 90.0}
TIER_W = {"S": 40.0, "A": 26.0, "B": 16.0}
BUDGET_GATE = {"S": 1.0, "A": 0.9, "B": 0.75, "search": 0.7, "watch": 0.85, "recheck": 0.8}
STOP = set("""the this that with from have just will what when your about there their they them then than been were being
into over more most some such only very also back here even much many really today tonight tomorrow great good thank thanks
people world time year years week day days going make made need know think want love like news breaking update official
crypto bitcoin market price trading trade token coin coins memecoin solana ethereum america american president country
everyone someone something nothing never always again first last best next would could should every still other while""".split())
EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿]")
CAP_WORD = re.compile(r"(?<![@#$\w])([A-Z][a-zA-Z]{3,20})\b")
QUOTED = re.compile(r"[\"“']([^\"”']{3,30})[\"”']")
HASHTAG = re.compile(r"#(\w{3,30})")


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def coinable_terms(text: str, keywords: dict[str, list[str]] | None = None) -> list[str]:
    """Names / phrases a deployer would tokenize: capitalized words, quoted phrases, hashtags, meme keywords."""
    t = re.sub(r"https?://\S+", " ", text or "")
    out: list[str] = []
    for m in QUOTED.findall(t):
        out.append(m)
    for m in HASHTAG.findall(t):
        out.append(m)
    words = t.split()
    for m in CAP_WORD.findall(t):
        if m.lower() not in STOP and not (words and words[0].strip("\"“'") == m and m.lower() in STOP):
            out.append(m)
    low = t.lower()
    for kws in (keywords or {}).values():
        for k in kws:
            if len(k) >= 4 and re.search(rf"\b{re.escape(k)}\b", low):
                out.append(k)
    seen, res = set(), []
    for o in out:
        n = norm(o)
        if len(n) >= 3 and n not in STOP and n not in seen:
            seen.add(n)
            res.append(o.strip())
    return res[:8]


def heuristic_score(text: str, tier: str, has_media: bool, metrics: dict[str, Any], age_min: float, cashtags: int, cas: int,
                    terms: int) -> tuple[float, float]:
    """(score 0-100, engagement velocity per minute)."""
    s = TIER_W.get(tier, 16.0)
    s += 15 if cas else 9 if cashtags else 0
    s += 8 if has_media else 0
    clean = re.sub(r"https?://\S+", "", text or "").strip()
    s += 6 if 0 < len(clean) <= 100 else 2 if len(clean) <= 180 else -4
    s += min(12.0, terms * 4.0)
    s += 4 if EMOJI.search(text or "") else 0
    s -= 8 if clean.startswith("@") else 0
    eng = (metrics.get("like_count", 0) + 2 * metrics.get("retweet_count", 0) + 2 * metrics.get("quote_count", 0)
           + metrics.get("reply_count", 0))
    vel = eng / max(1.0, age_min)
    s += min(20.0, 6 * math.log10(1 + vel))
    return max(0.0, min(100.0, s)), round(vel, 1)


def final_score(heur: float, ai: dict[str, Any] | None, spawns: int) -> float:
    if not ai:
        return round(min(100.0, heur + min(15, spawns * 5)), 1)
    s = 0.55 * heur + 4.0 * float(ai.get("meme_potential") or 0) + (8 if ai.get("coinable") else -10)
    s += min(15, spawns * 5)
    return round(max(0.0, min(100.0, s)), 1)


TWEET_SCHEMA = {
    "type": "object",
    "properties": {"tweets": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "coinable": {"type": "boolean"},
            "narrative": {"type": "string"},
            "tickers": {"type": "array", "items": {"type": "string"}},
            "names": {"type": "array", "items": {"type": "string"}},
            "meme_potential": {"type": "integer"},
            "urgency": {"type": "string", "enum": ["minutes", "hours", "days"]},
            "category": {"type": "string", "enum": ["politifi", "ai", "animal", "celebrity", "news", "culture", "brainrot", "gaming",
                                                     "crypto", "sports", "other"]},
            "why": {"type": "string"},
        },
        "required": ["id", "coinable", "narrative", "tickers", "names", "meme_potential", "urgency", "category", "why"],
        "additionalProperties": False}}},
    "required": ["tweets"],
    "additionalProperties": False,
}
TWEET_SYSTEM = """You read tweets for a memecoin trader and judge whether each one will be turned into a memecoin on
pump.fun (people race to launch coins named after viral tweets, phrases, pets, nicknames, images and moments).
For each tweet (one JSON line each) return:
- coinable: true only if a coin named after something in this tweet is plausible within hours
- narrative: 2-5 words naming the meme
- tickers: likely tickers UPPERCASE without $ (2-10 chars), best first; names: likely coin names, best first
- meme_potential 0-10: how hard this will be traded as a memecoin (author reach, catchiness, novelty, timing);
  ordinary news, ads and replies are 0-2; reserve 8-10 for things like a famous person naming a pet, a new nickname,
  a viral phrase or image from a top account
- urgency: minutes / hours / days — how fast the window closes
- why: max 90 characters
Judge from the tweet only. Never invent facts."""


class XRadar:
    def __init__(self, db: Any, cfg: Any, connectors: Any, social: Any, sniper: Any, alerts: Any, ai: Any, tracker: Any) -> None:
        self.db, self.cfg, self.connectors, self.social, self.sniper = db, cfg, connectors, social, sniper
        self.alerts, self.ai, self.tracker = alerts, ai, tracker
        self.client = httpx.AsyncClient(timeout=15)
        self.bucket = TokenBucket(28, burst=6)          # X recent search: 450 requests / 15 min per app
        self.roster: dict[str, dict[str, Any]] = {}     # handle(lower) -> row
        self.by_id: dict[str, str] = {}                 # user id -> handle(lower)
        self.since: dict[str, str] = {}
        self.next_at: dict[str, float] = {}
        self.hot: dict[str, dict[str, Any]] = {}        # tweet id -> tweet (last 3h, coinable / high score) for coin races
        self.ai_queue: deque[dict[str, Any]] = deque(maxlen=200)
        self.recent: deque[dict[str, Any]] = deque(maxlen=400)
        self.alert_times: list[float] = []
        self.stats = {"posts": 0, "requests": 0, "empty": 0, "ai_read": 0, "spawns": 0, "races": 0, "calls": 0, "alerts": 0,
                      "last_poll": {}, "errors": 0, "last_error": None, "budget_paused": None}
        self.cost_post = float(os.environ.get("X_COST_PER_POST", "0.005"))
        self.cost_user = float(os.environ.get("X_COST_PER_USER", "0.010"))

    @property
    def base(self) -> str:
        return os.environ.get("X_API_URL", "https://api.x.com/2")

    # ---------------- roster ----------------
    async def load(self) -> None:
        if not await self.db.one("SELECT 1 FROM x_accounts LIMIT 1"):
            now = time.time()
            rows = [(h, h.lower(), c, t, 1 if r else 0, "seed", now) for h, c, t, r in SEED]
            for v in self.cfg.watch.get("x_vips") or []:
                if v["handle"].lower() not in {r[1] for r in rows}:
                    rows.append((v["handle"], v["handle"].lower(), "news" if v.get("tier") == "news" else "celebrity",
                                 "A" if v.get("tier") == "news" else "S", 0, "watchlist", now))
            await self.db.many("INSERT OR IGNORE INTO x_accounts (handle, key, category, tier, replies, source, added) VALUES (?,?,?,?,?,?,?)",
                               rows)
        await self.reload()
        self.since = await self.cfg.kv_get("x:since", {}) or {}

    async def reload(self) -> None:
        rows = await self.db.all("SELECT * FROM x_accounts WHERE enabled=1")
        self.roster = {r["key"]: dict(r) for r in rows}
        self.by_id = {r["user_id"]: r["key"] for r in rows if r["user_id"]}

    async def add_account(self, handle: str, category: str = "kol", tier: str = "B", replies: bool = False, source: str = "user") -> dict[str, Any]:
        h = handle.strip().lstrip("@").split("/")[-1]
        if not re.fullmatch(r"[A-Za-z0-9_]{1,15}", h):
            raise ValueError("That isn't an X handle (letters, numbers, _ — up to 15)")
        tier = tier if tier in TIER_EVERY else "B"
        await self.db.exec("INSERT INTO x_accounts (handle, key, category, tier, replies, source, added) VALUES (?,?,?,?,?,?,?) "
                           "ON CONFLICT(key) DO UPDATE SET category=excluded.category, tier=excluded.tier, replies=excluded.replies, enabled=1",
                           (h, h.lower(), category, tier, 1 if replies else 0, source, time.time()))
        await self.reload()
        self.next_at.clear()
        return self.roster[h.lower()]

    async def remove_account(self, handle: str) -> None:
        await self.db.exec("UPDATE x_accounts SET enabled=0 WHERE key=?", (handle.lower().lstrip("@"),))
        await self.reload()
        self.next_at.clear()

    def batches(self) -> dict[str, list[tuple[str, list[str]]]]:
        """Roster → batched recent-search queries per tier (each ≤ ~480 chars)."""
        out: dict[str, list[tuple[str, list[str]]]] = {t: [] for t in TIER_EVERY}
        for tier in TIER_EVERY:
            for replies in (True, False):
                hs = sorted(r["handle"] for r in self.roster.values() if r["tier"] == tier and bool(r["replies"]) == replies)
                cur: list[str] = []
                suffix = " -is:retweet" + ("" if replies else " -is:reply")
                for h in hs:
                    trial = " OR ".join(f"from:{x}" for x in [*cur, h])
                    if len(trial) + len(suffix) + 2 > 480 and cur:
                        out[tier].append((f"({' OR '.join(f'from:{x}' for x in cur)}){suffix}", cur))
                        cur = [h]
                    else:
                        cur.append(h)
                if cur:
                    out[tier].append((f"({' OR '.join(f'from:{x}' for x in cur)}){suffix}", cur))
        return out

    # ---------------- budget ----------------
    async def budget(self) -> float:
        b = await self.cfg.kv_get("x:budget_usd")
        if b is not None:
            return float(b)
        try:
            return float((await self.connectors.values("x")).get("daily_budget_usd") or 5)
        except ValueError:
            return 5.0

    async def spent_today(self) -> float:
        start = time.time() - (time.time() % 86400)
        row = await self.db.one("SELECT COALESCE(SUM(cost_usd),0) c FROM api_usage WHERE adapter='x' AND ts>=?", (start,))
        return float(row["c"])

    async def allowed(self, kind: str) -> bool:
        cap, spent = await self.budget(), await self.spent_today()
        gate = BUDGET_GATE.get(kind, 0.75)
        if spent >= cap * gate:
            self.stats["budget_paused"] = kind
            return False
        if kind not in ("S",):
            frac = (time.time() % 86400) / 86400
            if spent >= cap * min(1.0, frac + 0.15) * gate:   # pace: non-S work can't run ahead of the clock
                self.stats["budget_paused"] = kind
                return False
        return True

    async def _meter(self, path: str, status: int, ms: float, posts: int, users: int = 0) -> None:
        cost = posts * self.cost_post + users * self.cost_user
        await self.db.exec("INSERT INTO api_usage (ts, adapter, path, status, latency_ms, cost_usd) VALUES (?,?,?,?,?,?)",
                           (time.time(), "x", path, status, ms, cost))

    async def _get(self, token: str, path: str, params: dict[str, Any], tag: str) -> dict[str, Any] | None:
        await self.bucket.acquire()
        t0 = time.perf_counter()
        r = await self.client.get(f"{self.base}{path}", params=params, headers={"Authorization": f"Bearer {token}"})
        ms = (time.perf_counter() - t0) * 1000
        self.stats["requests"] += 1
        if r.status_code == 429:
            reset = float(r.headers.get("x-rate-limit-reset", time.time() + 60))
            self.bucket.penalize(max(5.0, reset - time.time()))
            xr_h.fail("429 rate limited", rate_limited=True)
            return None
        if r.status_code in (401, 403):
            xr_h.fail(f"HTTP {r.status_code}: {r.text[:160]}")
            await self._meter(tag, r.status_code, ms, 0)
            raise PermissionError(f"X said {r.status_code}: check the bearer token and that your account has pay-per-use credits")
        if r.status_code == 402:
            xr_h.fail("402: out of X credits")
            raise PermissionError("X credits used up — top up in the X developer console")
        if r.status_code >= 400:
            xr_h.fail(f"HTTP {r.status_code}: {r.text[:160]}")
            return None
        xr_h.ok(ms)
        d = r.json()
        data = d.get("data")
        n = len(data) if isinstance(data, list) else (1 if data else 0)
        if path.startswith("/users"):
            posts, users = 0, n
        else:
            # expanded authors may be billed as user reads; counting them keeps the meter on the safe (high) side
            posts = n
            users = len((d.get("includes") or {}).get("users") or []) if os.environ.get("X_BILL_EXPANSIONS", "1") == "1" else 0
        await self._meter(tag, r.status_code, ms, posts, users)
        return d

    # ---------------- main loop ----------------
    async def run(self) -> None:
        await self.load()
        last_ids, last_watch, last_follow, last_recheck = 0.0, 0.0, 0.0, 0.0
        while True:
            try:
                v = await self.connectors.values("x")
                token = v.get("bearer_token")
                if not token:
                    xr_h.last_error_msg = "add your X bearer token on Connectors"
                    await asyncio.sleep(10)
                    continue
                now = time.time()
                if now - last_ids > 6 * 3600 or any(not r["user_id"] for r in self.roster.values()) and now - last_ids > 300:
                    last_ids = now
                    await self.resolve_users(token)
                for tier, qs in self.batches().items():
                    for q, _ in qs:
                        if now >= self.next_at.get(q, 0) and await self.allowed(tier):
                            self.next_at[q] = now + TIER_EVERY[tier]
                            await self.poll(token, q, tier)
                            self.stats["last_poll"][tier] = time.time()
                for q in self.cfg.watch.get("x_search_terms") or []:
                    if now >= self.next_at.get(q, 0) and await self.allowed("search"):
                        self.next_at[q] = now + float(self.cfg.watch.get("x_search_every_s", 180))
                        await self.poll(token, q, "search", max_results=25)
                if now - last_watch > float(os.environ.get("X_PROFILE_EVERY", "3600")) and await self.allowed("watch"):
                    last_watch = now
                    await self.watch_profiles(token)
                if now - last_follow > float(os.environ.get("X_FOLLOW_EVERY", "7200")) and await self.allowed("watch"):
                    last_follow = now
                    await self.watch_follows(token)
                if now - last_recheck > 300 and await self.allowed("recheck"):
                    last_recheck = now
                    await self.recheck(token)
                await self.read_with_ai()
            except asyncio.CancelledError:
                raise
            except PermissionError as e:
                self.stats["last_error"] = str(e)
                await asyncio.sleep(60)
            except Exception as e:  # noqa: BLE001
                self.stats["errors"] += 1
                self.stats["last_error"] = f"{type(e).__name__}: {e}"[:200]
                xr_h.fail(self.stats["last_error"])
                await asyncio.sleep(3)
            await asyncio.sleep(2)

    async def resolve_users(self, token: str) -> None:
        """Handle → user id (+ followers, picture, bio) for the whole roster, 100 per request. Refreshed every 6h."""
        keys = [r["handle"] for r in self.roster.values()]
        for i in range(0, len(keys), 100):
            d = await self._get(token, "/users/by", {"usernames": ",".join(keys[i:i + 100]),
                                                     "user.fields": "public_metrics,profile_image_url,description,name,verified,created_at"}, "users")
            for u in (d or {}).get("data") or []:
                await self._store_user(u, baseline=True)
        await self.reload()

    async def _store_user(self, u: dict[str, Any], baseline: bool = False) -> dict[str, Any] | None:
        key = (u.get("username") or "").lower()
        prev = await self.db.one("SELECT * FROM x_accounts WHERE key=?", (key,))
        if not prev:
            return None
        changes = {}
        for col, val in (("name", u.get("name")), ("bio", u.get("description")), ("avatar", u.get("profile_image_url"))):
            if prev[col] is not None and val is not None and prev[col] != val:
                changes[col] = (prev[col], val)
        await self.db.exec("UPDATE x_accounts SET user_id=?, name=?, bio=?, avatar=?, followers=? WHERE key=?",
                           (u.get("id"), u.get("name"), u.get("description"), u.get("profile_image_url"),
                            (u.get("public_metrics") or {}).get("followers_count"), key))
        return changes or None

    async def poll(self, token: str, query: str, tier: str, max_results: int = 50) -> int:
        params = {"query": query, "max_results": max(10, min(100, max_results)),
                  "tweet.fields": "created_at,public_metrics,entities,author_id,attachments,referenced_tweets,lang",
                  "expansions": "author_id,attachments.media_keys", "user.fields": "username,name,public_metrics,profile_image_url,created_at,verified",
                  "media.fields": "type,url,preview_image_url"}
        if self.since.get(query):
            params["since_id"] = self.since[query]
        d = await self._get(token, "/tweets/search/recent", params, f"x:{tier}")
        if d is None:
            return 0
        posts = d.get("data") or []
        if not posts:
            self.stats["empty"] += 1
        newest = (d.get("meta") or {}).get("newest_id")
        if newest:
            self.since[query] = newest
            await self.cfg.kv_set("x:since", self.since)
        users = {u["id"]: u for u in (d.get("includes") or {}).get("users", [])}
        media = {m["media_key"]: m for m in (d.get("includes") or {}).get("media", [])}
        for p in reversed(posts):
            await self.process(p, users.get(p.get("author_id"), {}), media, tier if tier != "search" else None)
        self.stats["posts"] += len(posts)
        return len(posts)

    # ---------------- one tweet ----------------
    async def process(self, p: dict[str, Any], u: dict[str, Any], media: dict[str, Any], tier: str | None) -> dict[str, Any] | None:
        tid = str(p["id"])
        if await self.db.one("SELECT 1 FROM x_tweets WHERE id=?", (tid,)):
            return None
        handle = u.get("username") or self.roster.get(self.by_id.get(p.get("author_id"), ""), {}).get("handle") or str(p.get("author_id"))
        acct = self.roster.get(handle.lower())
        tier = (acct or {}).get("tier") or tier or "B"
        cat = (acct or {}).get("category") or "search"
        text = p.get("text") or ""
        try:
            ts = calendar.timegm(time.strptime(p["created_at"][:19], "%Y-%m-%dT%H:%M:%S")) if p.get("created_at") else time.time()
        except ValueError:
            ts = time.time()
        m = p.get("public_metrics") or {}
        keys = (p.get("attachments") or {}).get("media_keys") or []
        med = [media[k] for k in keys if k in media]
        img = next((x.get("url") or x.get("preview_image_url") for x in med if x.get("url") or x.get("preview_image_url")), None)
        hits = detect(text)
        terms = coinable_terms(text, self.cfg.watch.get("category_keywords"))
        heur, vel = heuristic_score(text, tier, bool(med), m, max(1.0, (time.time() - ts) / 60), len(hits["cashtags"]), len(hits["solana"]),
                                    len(terms))
        row = {"id": tid, "handle": handle, "author_name": u.get("name") or (acct or {}).get("name"),
               "avatar": u.get("profile_image_url") or (acct or {}).get("avatar"), "tier": tier, "category": cat, "text": text[:1000],
               "ts": ts, "url": f"https://x.com/{handle}/status/{tid}", "media_url": img, "likes": m.get("like_count", 0),
               "rts": m.get("retweet_count", 0), "replies": m.get("reply_count", 0), "quotes": m.get("quote_count", 0), "velocity": vel,
               "heur": round(heur, 1), "ai_json": None, "score": final_score(heur, None, 0), "terms_json": json.dumps(terms),
               "tickers_json": json.dumps(hits["cashtags"]), "cas_json": json.dumps(hits["solana"]), "coinable": None, "spawns": 0,
               "kind": "tweet", "alerted": 0, "updated": time.time(), "followers": (u.get("public_metrics") or {}).get("followers_count")}
        await self.db.upsert("x_tweets", row, "id")
        if acct:
            await self.db.exec("UPDATE x_accounts SET tweets=COALESCE(tweets,0)+1, last_tweet=? WHERE key=?", (ts, acct["key"]))
        # the narrative engine (clusters, FLASH on a VIP contract) sees it too
        try:
            await self.social.ingest({"id": f"x:{tid}", "source": "x", "author": handle, "author_name": row["author_name"],
                                      "followers": row["followers"], "tier_hint": SOCIAL_TIER.get(cat) if acct else None, "text": text,
                                      "url": row["url"], "ts": ts, "engagement": m.get("like_count", 0) + 2 * m.get("retweet_count", 0)})
        except Exception as e:  # noqa: BLE001
            log.debug("social ingest: %s", e)
        t = self._mem(row)
        self.recent.appendleft(t)
        if tier == "S" or heur >= 34 or hits["cashtags"] or hits["solana"]:
            self.ai_queue.append(t)
        if heur >= 40 or hits["cashtags"] or hits["solana"] or (tier == "S" and terms):
            self.hot[tid] = t
        await self._publish(t)
        if hits["solana"] or hits["cashtags"]:
            await self.log_calls(t, hits)
        await self.maybe_alert(t)
        return t

    def _mem(self, row: dict[str, Any]) -> dict[str, Any]:
        t = {k: row[k] for k in ("id", "handle", "author_name", "avatar", "tier", "category", "text", "ts", "url", "media_url", "likes", "rts",
                                 "replies", "quotes", "velocity", "heur", "score", "spawns", "kind", "followers")}
        t["terms"] = json.loads(row["terms_json"] or "[]")
        t["tickers"] = json.loads(row["tickers_json"] or "[]")
        t["cas"] = json.loads(row.get("cas_json") or "[]")
        t["ai"] = json.loads(row["ai_json"]) if row.get("ai_json") else None
        t["coins"] = []
        t["match"] = self._match_terms(t)
        return t

    @staticmethod
    def _match_terms(t: dict[str, Any]) -> set[str]:
        ai = t.get("ai") or {}
        out = {norm(x) for x in (t.get("tickers") or []) + (ai.get("tickers") or []) + (ai.get("names") or []) + (t.get("terms") or [])}
        return {x for x in out if len(x) >= 3 and x not in STOP}

    async def _publish(self, t: dict[str, Any]) -> None:
        from .hub import hub
        await hub.publish("x_tweet", {k: v for k, v in t.items() if k != "match"})

    # ---------------- Claude, in batches ----------------
    async def read_with_ai(self) -> int:
        if not self.ai.enabled or not self.ai_queue:
            return 0
        batch = []
        while self.ai_queue and len(batch) < 15:
            batch.append(self.ai_queue.popleft())
        urgent = any(t["tier"] == "S" for t in batch)
        if len(batch) < 4 and not urgent and time.time() - self.stats.get("ai_last", 0) < 60:
            for t in reversed(batch):
                self.ai_queue.appendleft(t)
            return 0
        self.stats["ai_last"] = time.time()
        lines = "\n".join(json.dumps({"id": t["id"], "author": f"@{t['handle']} ({t['category']}, tier {t['tier']}, "
                                                                f"{t.get('followers') or '?'} followers)",
                                      "text": t["text"][:500], "has_image": bool(t.get("media_url"))}, ensure_ascii=False) for t in batch)
        try:
            out = await self.ai.json("x_tweets", TWEET_SYSTEM, lines, TWEET_SCHEMA, max_tokens=170 * len(batch) + 200)
        except Exception as e:  # noqa: BLE001
            self.stats["last_error"] = f"Claude: {e}"[:200]
            return 0
        by = {str(x.get("id")): x for x in out.get("tweets") or []}
        n = 0
        for t in batch:
            a = by.get(t["id"])
            if not a:
                continue
            a["meme_potential"] = max(0, min(10, int(a.get("meme_potential") or 0)))
            a["tickers"] = [re.sub(r"[^A-Z0-9]", "", x.upper())[:12] for x in a.get("tickers") or [] if x][:5]
            a["names"] = [x[:40] for x in a.get("names") or [] if x][:5]
            a["why"] = (a.get("why") or "")[:120]
            t["ai"] = a
            t["score"] = final_score(t["heur"], a, t.get("spawns", 0))
            t["match"] = self._match_terms(t)
            if a["coinable"] or t["score"] >= 45:
                self.hot[t["id"]] = t
            else:
                self.hot.pop(t["id"], None)
            await self.db.exec("UPDATE x_tweets SET ai_json=?, coinable=?, score=?, updated=? WHERE id=?",
                               (json.dumps(a), 1 if a["coinable"] else 0, t["score"], time.time(), t["id"]))
            await self._publish(t)
            await self.maybe_alert(t)
            n += 1
        self.stats["ai_read"] += n
        return n

    # ---------------- alerts ----------------
    async def maybe_alert(self, t: dict[str, Any]) -> None:
        ai = t.get("ai") or {}
        big = (t["tier"] == "S" and (ai.get("coinable") or (ai.get("meme_potential") or 0) >= 6)) or \
              ((ai.get("meme_potential") or 0) >= 8) or (t["velocity"] >= 2000 and t["tier"] in ("S", "A"))
        if not big or t.get("_alerted"):
            return
        now = time.time()
        self.alert_times = [x for x in self.alert_times if x > now - 3600]
        if len(self.alert_times) >= int(os.environ.get("X_ALERTS_PER_HOUR", "12")):
            return
        t["_alerted"] = True
        self.alert_times.append(now)
        self.stats["alerts"] += 1
        await self.db.exec("UPDATE x_tweets SET alerted=1 WHERE id=?", (t["id"],))
        tick = " ".join(f"${x}" for x in (ai.get("tickers") or t.get("tickers") or [])[:4])
        title = f"🐦 @{t['handle']}: {ai.get('narrative') or 'big tweet'}" + (f" · meme {ai['meme_potential']}/10" if ai.get("meme_potential") is not None else "")
        body = f"“{t['text'][:240]}”" + (f"\nWatch for: {tick}" if tick else "") + (f"\n{ai['why']}" if ai.get("why") else "") + f"\n{t['url']}"
        await feed.push("x", "big_tweet", title, t["text"][:200], None, url=t["url"])
        await self.alerts.send("flash" if t["tier"] == "S" else "info", title, body, dedupe=f"xt:{t['id']}", ttl=86400)

    # ---------------- coin races: tweets → the launches they spawn ----------------
    async def on_launch(self, row: dict[str, Any]) -> None:
        if row.get("is_mayhem"):
            return
        mint, now = row["address"], time.time()
        name, sym = norm(row.get("name") or ""), norm(row.get("symbol") or "")
        if not (name or sym):
            return
        words = {norm(w) for w in re.split(r"\W+", row.get("name") or "") if w}
        best = None
        for tid, t in list(self.hot.items()):
            if now - t["ts"] > 3 * 3600:
                self.hot.pop(tid, None)
                continue
            if row.get("launched_at") and row["launched_at"] < t["ts"] - 5:
                continue
            hit = next((x for x in t["match"] if x == sym or x == name or x in words or (len(x) >= 5 and x in name)), None)
            if hit and (best is None or t["score"] > best[0]["score"]):
                best = (t, hit)
        if best is None:
            return
        t, term = best
        t["spawns"] = t.get("spawns", 0) + 1
        delay = max(0.0, now - t["ts"])
        coin = {"mint": mint, "symbol": row.get("symbol"), "name": row.get("name"), "ts": now, "delay_s": round(delay), "rank": t["spawns"],
                "term": term}
        t["coins"] = (t.get("coins") or []) + [coin]
        t["score"] = final_score(t["heur"], t.get("ai"), t["spawns"])
        self.stats["spawns"] += 1
        await self.db.exec("INSERT OR IGNORE INTO x_spawns (tweet_id, mint, symbol, name, ts, delay_s, rank, term) VALUES (?,?,?,?,?,?,?,?)",
                           (t["id"], mint, row.get("symbol"), row.get("name"), now, delay, t["spawns"], term))
        await self.db.exec("UPDATE x_tweets SET spawns=?, score=? WHERE id=?", (t["spawns"], t["score"], t["id"]))
        await self.db.exec("UPDATE x_accounts SET spawns=COALESCE(spawns,0)+1 WHERE key=?", (t["handle"].lower(),))
        L = self.sniper.launches.get(mint)
        if L is not None:
            L.x = {"tweet_id": t["id"], "handle": t["handle"], "tier": t["tier"], "score": t["score"], "text": t["text"][:200],
                   "url": t["url"], "delay_s": round(delay), "rank": t["spawns"], "term": term,
                   "narrative": (t.get("ai") or {}).get("narrative")}
            L.dirty = True
            self.sniper.dirty.add(mint)
            self.tracker.launch_watch[mint] = max(self.tracker.launch_watch.get(mint, 0), now + 1800)
            L.until = max(L.until, now + 3600)
        await self._publish(t)
        from .hub import hub
        await hub.publish("x_race", {"tweet": {k: v for k, v in t.items() if k != "match"}, "coin": coin})
        if t["spawns"] in (3, 10):
            self.stats["races"] += 1
            lead = self.race_leader(t)
            title = f"🏁 Tweet race: {t['spawns']} coins launched off @{t['handle']}'s tweet"
            body = (f"“{t['text'][:180]}”\nfirst coin {t['coins'][0]['delay_s']}s after the tweet"
                    + (f" · leader ${lead['symbol']}" if lead else "") + f"\n{t['url']}")
            await feed.push("x", "race", title, body, lead["mint"] if lead else mint, url=t["url"])
            await self.alerts.send("flash", title, body, token=lead["mint"] if lead else mint, dedupe=f"race:{t['id']}:{t['spawns']}", ttl=86400)

    def race_leader(self, t: dict[str, Any]) -> dict[str, Any] | None:
        best, top = None, -1.0
        for c in t.get("coins") or []:
            L = self.sniper.launches.get(c["mint"])
            mc = (L.mcap_sol or 0) if L else 0
            if mc > top:
                best, top = c, mc
        return best

    # ---------------- callers: every $ticker / contract call, graded ----------------
    async def log_calls(self, t: dict[str, Any], hits: dict[str, list[str]]) -> None:
        mints: list[tuple[str, str | None]] = [(ca, None) for ca in hits["solana"][:3]]
        for tag in hits["cashtags"][:4]:
            m = self.resolve_ticker(tag)
            if m:
                mints.append((m, tag))
        if not mints and hits["cashtags"]:
            for tag in hits["cashtags"][:2]:
                r = await self.db.one("SELECT t.address FROM tokens t JOIN pairs p ON p.pair_address=t.best_pair WHERE UPPER(t.symbol)=? "
                                      "AND t.chain='solana' ORDER BY p.vol_h24 DESC LIMIT 1", (tag,))
                if r:
                    mints.append((r["address"], tag))
        for mint, tag in dict.fromkeys(mints):
            mc = await self.mcap_usd(mint)
            await self.db.exec("INSERT OR IGNORE INTO x_calls (tweet_id, handle, mint, symbol, ts, mcap_at_call, peak_mcap, last_mcap, updated) "
                               "VALUES (?,?,?,?,?,?,?,?,?)", (t["id"], t["handle"], mint, tag, t["ts"], mc, mc, mc, time.time()))
            self.stats["calls"] += 1
            if t["tier"] in ("S", "A"):
                await self.tracker._ensure_token(mint, "solana", None, tag, None, "x_call")
            await feed.push("x", "call", f"📣 @{t['handle']} called {('$' + tag) if tag else mint[:6] + '…'}",
                            (f"at ${mc:,.0f} mcap · " if mc else "") + t["text"][:140], mint, url=t["url"])

    def resolve_ticker(self, tag: str) -> str | None:
        c = [L for L in self.sniper.launches.values() if (L.symbol or "").upper() == tag]
        return max(c, key=lambda L: L.mcap_sol or 0).mint if c else None

    async def mcap_usd(self, mint: str) -> float | None:
        L = self.sniper.launches.get(mint)
        if L is not None and L.mcap_sol and self.tracker.sol_usd:
            return round(L.mcap_sol * self.tracker.sol_usd, 2)
        tok = await self.tracker.token_summary(mint)
        return (tok or {}).get("market_cap") or (tok or {}).get("fdv")

    async def grade_loop(self) -> None:
        """Every minute: call outcomes (peak, 1h); every 30 min: promote callers who deliver, demote the rest."""
        last_learn = time.time()
        while True:
            await asyncio.sleep(60)
            try:
                now = time.time()
                for c in await self.db.all("SELECT * FROM x_calls WHERE ts > ? AND mcap_at_call > 0", (now - 24 * 3600,)):
                    mc = await self.mcap_usd(c["mint"])
                    if not mc:
                        continue
                    one_h = c["mcap_1h"] if c["mcap_1h"] is not None or now - c["ts"] < 3600 else mc
                    await self.db.exec("UPDATE x_calls SET peak_mcap=MAX(COALESCE(peak_mcap,0), ?), last_mcap=?, mcap_1h=?, updated=? WHERE tweet_id=? AND mint=?",
                                       (mc, mc, one_h, now, c["tweet_id"], c["mint"]))
                if now - last_learn > 1800:
                    last_learn = now
                    await self.learn()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("x grade: %s", e)

    async def callers(self, days: float = 7, min_calls: int = 1) -> list[dict[str, Any]]:
        rows = await self.db.all("SELECT c.handle, COUNT(*) calls, AVG(c.peak_mcap / c.mcap_at_call) avg_peak_x, "
                                 "SUM(c.peak_mcap >= 2 * c.mcap_at_call) hit2, SUM(c.peak_mcap >= 5 * c.mcap_at_call) hit5, "
                                 "AVG(CASE WHEN c.mcap_1h IS NOT NULL THEN c.mcap_1h / c.mcap_at_call END) avg_1h_x, MAX(c.ts) last_call, "
                                 "a.tier, a.category, a.avatar, a.name, a.source FROM x_calls c LEFT JOIN x_accounts a ON a.key=LOWER(c.handle) "
                                 "WHERE c.ts > ? AND c.mcap_at_call > 0 GROUP BY c.handle HAVING calls >= ? ORDER BY hit2 * 1.0 / calls DESC, avg_peak_x DESC LIMIT 100",
                                 (time.time() - days * 86400, min_calls))
        for r in rows:
            r["hit_2x_pct"] = round((r["hit2"] or 0) / r["calls"] * 100)
            r["avg_peak_x"] = round(r["avg_peak_x"] or 0, 2)
            r["avg_1h_x"] = round(r["avg_1h_x"], 2) if r["avg_1h_x"] else None
        return rows

    async def learn(self) -> list[dict[str, Any]]:
        """The roster improves itself: callers whose calls run get promoted (or added); ones that don't, demoted."""
        changes = []
        for r in await self.callers(days=7, min_calls=3):
            key = r["handle"].lower()
            acct = await self.db.one("SELECT * FROM x_accounts WHERE key=?", (key,))
            good, bad = r["hit_2x_pct"] >= 40, r["hit_2x_pct"] < 10 and r["calls"] >= 6
            if good and not acct:
                await self.add_account(r["handle"], "caller", "B", False, "learned")
                changes.append({"handle": r["handle"], "change": "added", "why": f"{r['hit_2x_pct']}% of {r['calls']} calls hit 2×"})
            elif good and acct and acct["tier"] == "B":
                await self.db.exec("UPDATE x_accounts SET tier='A' WHERE key=?", (key,))
                changes.append({"handle": r["handle"], "change": "promoted to A", "why": f"{r['hit_2x_pct']}% of {r['calls']} calls hit 2×"})
            elif bad and acct and acct["tier"] == "A" and acct["source"] != "seed":
                await self.db.exec("UPDATE x_accounts SET tier='B' WHERE key=?", (key,))
                changes.append({"handle": r["handle"], "change": "demoted to B", "why": f"only {r['hit_2x_pct']}% of {r['calls']} calls hit 2×"})
        for c in changes:
            await self.db.exec("INSERT INTO x_events (ts, handle, kind, detail) VALUES (?,?,?,?)", (time.time(), c["handle"], "learned",
                                                                                                    f"{c['change']}: {c['why']}"))
            await feed.push("x", "learned", f"🧠 @{c['handle']} {c['change']}", c["why"])
        if changes:
            await self.reload()
            self.next_at.clear()
        return changes

    # ---------------- watchers: names / bios / pictures, and new follows ----------------
    async def watch_profiles(self, token: str) -> None:
        s_tier = [r["handle"] for r in self.roster.values() if r["tier"] == "S"][:int(os.environ.get("X_PROFILE_MAX", "12"))]
        if not s_tier:
            return
        d = await self._get(token, "/users/by", {"usernames": ",".join(s_tier), "user.fields": "profile_image_url,description,name,public_metrics"},
                            "profiles")
        for u in (d or {}).get("data") or []:
            ch = await self._store_user(u)
            if ch:
                await self.profile_changed(u, ch)

    async def profile_changed(self, u: dict[str, Any], ch: dict[str, tuple[Any, Any]]) -> None:
        handle = u.get("username")
        parts = []
        if "name" in ch:
            parts.append(f"name “{ch['name'][0]}” → “{ch['name'][1]}”")
        if "bio" in ch:
            parts.append(f"bio → “{(ch['bio'][1] or '')[:120]}”")
        if "avatar" in ch:
            parts.append("new profile picture")
        detail = " · ".join(parts)
        await self.db.exec("INSERT INTO x_events (ts, handle, kind, detail) VALUES (?,?,?,?)", (time.time(), handle, "profile", detail))
        # the new name / bio becomes a "tweet" the coin-race matcher hunts for (the Kekius Maximus pattern)
        text = f"{handle} changed profile: {u.get('name')} — {u.get('description') or ''}"
        await self._synthetic(f"profile:{handle}:{int(time.time())}", handle, text, "profile", [u.get("name") or ""])
        title = f"🪪 @{handle} changed their profile"
        await feed.push("x", "profile", title, detail)
        await self.alerts.send("flash", title, f"{detail}\nCoins named after it may launch now.\nhttps://x.com/{handle}",
                               dedupe=f"profile:{handle}:{detail[:60]}", ttl=6 * 3600)

    async def watch_follows(self, token: str) -> None:
        for h in FOLLOW_WATCH:
            acct = self.roster.get(h.lower())
            if not acct or not acct.get("user_id"):
                continue
            d = await self._get(token, f"/users/{acct['user_id']}/following",
                                {"max_results": 10, "user.fields": "description,public_metrics,created_at,name"}, "follows")
            users = (d or {}).get("data") or []
            known = set(json.loads(acct.get("follows_json") or "[]"))
            if known:
                for u in users:
                    if u["id"] not in known:
                        await self.new_follow(acct["handle"], u)
            ids = list(dict.fromkeys([u["id"] for u in users] + list(known)))[:500]
            await self.db.exec("UPDATE x_accounts SET follows_json=? WHERE key=?", (json.dumps(ids), acct["key"]))
            acct["follows_json"] = json.dumps(ids)

    async def new_follow(self, who: str, u: dict[str, Any]) -> None:
        bio = (u.get("description") or "")[:160]
        small = (u.get("public_metrics") or {}).get("followers_count", 0) < 50_000
        coiny = bool(detect(bio)["solana"] or re.search(r"\$[A-Za-z]|\bpump\b|\bcoin\b|\btoken\b|\bCA\b|\bmeme", bio, re.I))
        detail = f"followed @{u.get('username')} ({u.get('name')}, {(u.get('public_metrics') or {}).get('followers_count', 0):,} followers): {bio}"
        await self.db.exec("INSERT INTO x_events (ts, handle, kind, detail) VALUES (?,?,?,?)", (time.time(), who, "follow", detail))
        await self._synthetic(f"follow:{who}:{u['id']}", who, f"{who} followed {u.get('username')} {u.get('name')} {bio}", "follow",
                              [u.get("name") or "", u.get("username") or ""])
        title = f"👀 @{who} followed @{u.get('username')}" + (" — looks like a coin" if coiny else "")
        await feed.push("x", "follow", title, bio)
        if coiny or small:
            await self.alerts.send("flash" if coiny else "info", title, f"{detail}\nhttps://x.com/{u.get('username')}",
                                   dedupe=f"follow:{who}:{u['id']}", ttl=86400)

    async def _synthetic(self, tid: str, handle: str, text: str, kind: str, names: list[str]) -> None:
        acct = self.roster.get(handle.lower()) or {}
        terms = [n for n in names if n] + coinable_terms(text)
        row = {"id": tid, "handle": handle, "author_name": acct.get("name"), "avatar": acct.get("avatar"), "tier": acct.get("tier") or "S",
               "category": acct.get("category") or "celebrity", "text": text[:1000], "ts": time.time(), "url": f"https://x.com/{handle}",
               "media_url": None, "likes": 0, "rts": 0, "replies": 0, "quotes": 0, "velocity": 0, "heur": 60.0, "ai_json": None,
               "score": 60.0, "terms_json": json.dumps(terms[:8]), "tickers_json": "[]", "cas_json": "[]", "coinable": 1, "spawns": 0,
               "kind": kind, "alerted": 1, "updated": time.time(), "followers": acct.get("followers")}
        await self.db.upsert("x_tweets", row, "id")
        t = self._mem(row)
        self.hot[tid] = t
        self.recent.appendleft(t)
        await self._publish(t)

    # ---------------- velocity re-check for the hottest fresh tweets ----------------
    async def recheck(self, token: str) -> None:
        now = time.time()
        cands = sorted((t for t in self.hot.values() if t["kind"] == "tweet" and 180 < now - t["ts"] < 3600 and not t.get("_rechecked")),
                       key=lambda t: -t["score"])[:10]
        if not cands:
            return
        d = await self._get(token, "/tweets", {"ids": ",".join(t["id"] for t in cands), "tweet.fields": "public_metrics"}, "recheck")
        for p in (d or {}).get("data") or []:
            t = self.hot.get(str(p["id"]))
            if not t:
                continue
            t["_rechecked"] = True
            m = p.get("public_metrics") or {}
            eng = m.get("like_count", 0) + 2 * m.get("retweet_count", 0) + 2 * m.get("quote_count", 0) + m.get("reply_count", 0)
            t.update(likes=m.get("like_count", 0), rts=m.get("retweet_count", 0), replies=m.get("reply_count", 0), quotes=m.get("quote_count", 0))
            t["velocity"] = round(eng / max(1.0, (now - t["ts"]) / 60), 1)
            t["heur"] = min(100.0, t["heur"] + min(10.0, 3 * math.log10(1 + t["velocity"])))
            t["score"] = final_score(t["heur"], t.get("ai"), t.get("spawns", 0))
            await self.db.exec("UPDATE x_tweets SET likes=?, rts=?, replies=?, quotes=?, velocity=?, heur=?, score=? WHERE id=?",
                               (t["likes"], t["rts"], t["replies"], t["quotes"], t["velocity"], t["heur"], t["score"], t["id"]))
            await self._publish(t)
            await self.maybe_alert(t)

    # ---------------- reads ----------------
    async def board(self, hours: float = 12, limit: int = 60, min_score: float = 0, category: str = "", kind: str = "") -> list[dict[str, Any]]:
        q = "SELECT * FROM x_tweets WHERE ts > ? AND score >= ?"
        args: list[Any] = [time.time() - hours * 3600, min_score]
        if category:
            q += " AND category=?"
            args.append(category)
        if kind:
            q += " AND kind=?"
            args.append(kind)
        rows = await self.db.all(q + " ORDER BY ts DESC LIMIT 600", args)
        now = time.time()
        out = []
        spawn_rows = await self.db.all("SELECT * FROM x_spawns WHERE ts > ? ORDER BY ts", (now - hours * 3600,))
        coins: dict[str, list[dict[str, Any]]] = {}
        for s in spawn_rows:
            L = self.sniper.launches.get(s["mint"])
            coins.setdefault(s["tweet_id"], []).append({**s, "mcap_usd": round(L.mcap_sol * self.tracker.sol_usd) if L and L.mcap_sol and self.tracker.sol_usd else None,
                                                        "tier": (L.result or {}).get("tier") if L else None})
        for r in rows:
            t = self._mem(r)
            t.pop("match", None)
            t["coins"] = coins.get(t["id"], [])
            t["rank_score"] = round(t["score"] * math.exp(-(now - t["ts"]) / (6 * 3600)), 1)
            out.append(t)
        out.sort(key=lambda t: -t["rank_score"])
        return out[:limit]

    async def races(self, hours: float = 12) -> list[dict[str, Any]]:
        rows = await self.board(hours=hours, limit=300)
        return [t for t in rows if t["coins"]][:40]

    async def status(self) -> dict[str, Any]:
        tiers = {t: sum(1 for r in self.roster.values() if r["tier"] == t) for t in TIER_EVERY}
        token = (await self.connectors.values("x")).get("bearer_token")
        return {"connected": bool(token), "budget_usd": await self.budget(), "spent_usd": round(await self.spent_today(), 4),
                "accounts": len(self.roster), "tiers": tiers, "hot": len(self.hot), "queue": len(self.ai_queue),
                "cost_per_post": self.cost_post, "follow_watch": FOLLOW_WATCH, **{k: v for k, v in self.stats.items() if k != "ai_last"}}

    async def accounts(self) -> list[dict[str, Any]]:
        rows = await self.db.all("SELECT handle, category, tier, replies, source, name, avatar, followers, tweets, spawns, last_tweet, enabled "
                                 "FROM x_accounts WHERE enabled=1 ORDER BY CASE tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 ELSE 2 END, followers DESC")
        return rows

    async def events(self, limit: int = 50) -> list[dict[str, Any]]:
        return await self.db.all("SELECT * FROM x_events ORDER BY ts DESC LIMIT ?", (limit,))
