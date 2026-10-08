"""Token stories: every narrative behind a coin, researched from the web and socials.

Evidence: posts Radar already ingested (X, Telegram, Bluesky, 4chan, Reddit, news…), the coin's DexScreener profile,
plus live keyless web searches (Google News, Reddit, Bluesky) and X search when connected. Claude turns the evidence
into named narratives with explanations; without a key, keyword clustering does it deterministically.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import urllib.parse
from typing import Any

import httpx

from .adapters import feeds
from .adapters.http import USER_AGENT
from .health import Health, register
from .ratelimit import TokenBucket
from .social import text as tx

log = logging.getLogger("radar.story")
web_h = register(Health("web_research", "rest", "Per-coin web research: Google News, Reddit & Bluesky search"))
web_h.stale_after = 1800
bucket = TokenBucket(20, burst=4)
web_h.headroom_fn = bucket.headroom

STORY_SCHEMA = {
    "type": "object",
    "properties": {
        "why_moving": {"type": "string"},
        "origin": {"type": "string"},
        "narratives": {"type": "array", "items": {"type": "object", "properties": {
            "title": {"type": "string"}, "category": {"type": "string"}, "explanation": {"type": "string"},
            "strength": {"type": "number"}, "evidence": {"type": "array", "items": {"type": "integer"}}},
            "required": ["title", "category", "explanation", "strength", "evidence"], "additionalProperties": False}},
        "risks": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["why_moving", "origin", "narratives", "risks"],
    "additionalProperties": False,
}
STORY_SYSTEM = """You explain WHY a memecoin is getting attention, for a trader. You get the coin's data and numbered evidence
(posts, headlines, its own profile text). Identify every distinct narrative behind it (the meme/story/catalyst people are
trading: a viral moment, a celebrity or politician, news, an AI/animal/political theme, a community takeover, a listing…).
Use ONLY the evidence; cite evidence numbers; never invent events or numbers. If evidence is thin, say so in why_moving
and return fewer narratives. strength = 0-100 how much of the attention that narrative explains. Add concrete risks
(e.g. copycat of another coin, paid shilling, single-source hype, bot-looking posts)."""


def _q(s: str) -> str:
    return urllib.parse.quote_plus(s)


class StoryEngine:
    def __init__(self, db: Any, ai: Any, social: Any, connectors: Any, discover: Any, cfg: Any) -> None:
        self.db, self.ai, self.social, self.connectors, self.discover, self.cfg = db, ai, social, connectors, discover, cfg
        self.client = httpx.AsyncClient(timeout=12, follow_redirects=True, headers={"User-Agent": USER_AGENT})
        self.inflight: set[str] = set()

    async def get(self, addr: str) -> dict[str, Any] | None:
        r = await self.db.one("SELECT * FROM token_stories WHERE token_address=?", (addr,))
        if not r:
            return None
        return {**json.loads(r["story_json"]), "ts": r["ts"], "method": r["method"]}

    # ---------------- evidence ----------------
    async def _web(self, kind: str, url: str, source: str) -> list[dict[str, Any]]:
        await bucket.acquire()
        t0 = time.perf_counter()
        try:
            if kind == "rss":
                rows = await feeds.fetch(url, source, h=web_h)
                return [{"source": source, "text": r["title"], "url": r["link"], "ts": r["published"] or r["fetched"]} for r in rows[:15]]
            r = await self.client.get(url)
            if r.status_code >= 400:
                web_h.fail(f"{source}: HTTP {r.status_code}")
                return []
            web_h.ok((time.perf_counter() - t0) * 1000)
            posts = r.json().get("posts") or []
            out = []
            for p in posts[:25]:
                rec = p.get("record") or {}
                a = p.get("author") or {}
                rkey = (p.get("uri") or "").rsplit("/", 1)[-1]
                out.append({"source": "bluesky", "text": rec.get("text") or "", "author": a.get("handle"),
                            "url": f"https://bsky.app/profile/{a.get('handle')}/post/{rkey}",
                            "ts": time.time(), "engagement": (p.get("likeCount") or 0) + 2 * (p.get("repostCount") or 0)})
            return out
        except Exception as e:  # noqa: BLE001
            web_h.fail(f"{source}: {type(e).__name__}: {e}")
            return []

    async def _x(self, sym: str, addr: str) -> list[dict[str, Any]]:
        v = await self.connectors.values("x")
        if not v.get("bearer_token"):
            return []
        r = await self.client.get("https://api.x.com/2/tweets/search/recent",
                                  params={"query": f'("${sym}" OR {addr}) -is:retweet', "max_results": 25,
                                          "tweet.fields": "created_at,public_metrics", "expansions": "author_id", "user.fields": "username"},
                                  headers={"Authorization": f"Bearer {v['bearer_token']}"})
        if r.status_code >= 400:
            return []
        d = r.json()
        users = {u["id"]: u.get("username") for u in (d.get("includes") or {}).get("users", [])}
        posts = d.get("data") or []
        await self.db.exec("INSERT INTO api_usage (ts, adapter, path, status, latency_ms, cost_usd) VALUES (?,?,?,?,?,?)",
                           (time.time(), "x", "story", r.status_code, 0,
                            len(posts) * float(self.cfg.watch.get("x_cost_per_post_read_usd", 0.005))))
        return [{"source": "x", "text": p.get("text", ""), "author": users.get(p.get("author_id")),
                 "url": f"https://x.com/{users.get(p.get('author_id'))}/status/{p['id']}", "ts": time.time(),
                 "engagement": sum((p.get("public_metrics") or {}).values())} for p in posts]

    async def evidence(self, tok: dict[str, Any], use_x: bool) -> list[dict[str, Any]]:
        addr, sym, name = tok["address"], (tok.get("symbol") or "").strip(), (tok.get("name") or "").strip()
        ev: list[dict[str, Any]] = []
        # 1) the coin's own profile (what it claims to be)
        prof = await self.db.one("SELECT data_json FROM trending WHERE source='dexscreener' AND list IN ('profiles','takeovers') "
                                 "AND token_address=? LIMIT 1", (addr,))
        if prof:
            desc = json.loads(prof["data_json"]).get("description")
            if desc:
                ev.append({"source": "profile", "text": desc, "url": f"https://dexscreener.com/solana/{addr}", "ts": time.time()})
        t = await self.db.one("SELECT links_json FROM tokens WHERE address=?", (addr,))
        links = json.loads((t or {}).get("links_json") or "null") or {}
        for s in (links.get("socials") or [])[:4]:
            ev.append({"source": "profile", "text": f"Official {s.get('type') or 'link'}: {s.get('url')}", "url": s.get("url"), "ts": time.time()})
        # 2) posts Radar already captured
        conds, args = ["cas_json LIKE ?"], [f"%{addr}%"]
        if len(sym) >= 3:
            conds.append("cashtags_json LIKE ?")
            args.append(f'%"{sym.upper()}"%')
        if len(name) >= 5:
            conds.append("text LIKE ?")
            args.append(f"%{name}%")
        for r in await self.db.all(f"SELECT source, author_id, text, url, ts, engagement FROM social_events WHERE ({' OR '.join(conds)}) "
                                   "AND ts > ? ORDER BY engagement DESC, ts DESC LIMIT 40", [*args, time.time() - 72 * 3600]):
            ev.append({"source": r["source"], "text": r["text"], "url": r["url"], "ts": r["ts"], "engagement": r["engagement"],
                       "author": (r["author_id"] or "").split(":", 1)[-1]})
        # 3) live web + social search (keyless)
        terms = [x for x in (f'"{name}"' if len(name) >= 4 else None, f'"${sym}"' if len(sym) >= 2 else None) if x]
        if terms:
            q = " OR ".join(terms)
            jobs = [self._web("rss", f"https://news.google.com/rss/search?q={_q(q + ' when:3d')}&hl=en-US&gl=US&ceid=US:en", "google_news"),
                    self._web("rss", f"https://www.reddit.com/search.rss?q={_q(q)}&sort=new&t=week", "reddit"),
                    self._web("json", f"https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q={_q(sym or name)}&limit=25&sort=latest", "bluesky")]
            if use_x and sym:
                jobs.append(self._x(sym, addr))
            for res in await asyncio.gather(*jobs, return_exceptions=True):
                if isinstance(res, list):
                    ev.extend(res)
        # dedupe + keep the most relevant
        seen, out = set(), []
        for e in ev:
            k = re.sub(r"\W+", " ", (e.get("text") or "").lower())[:120]
            if not k.strip() or k in seen:
                continue
            seen.add(k)
            out.append(e)
        return out[:60]

    # ---------------- synthesis ----------------
    def heuristic(self, tok: dict[str, Any], ev: list[dict[str, Any]]) -> dict[str, Any]:
        own = {w.lower() for w in re.findall(r"\w+", f"{tok.get('symbol') or ''} {tok.get('name') or ''}")}
        counts: dict[str, dict[str, Any]] = {}
        for i, e in enumerate(ev):
            for kw in tx.keywords(e.get("text") or "", 6):
                if kw in own or kw in ("coin", "token", "crypto", "solana", "pump", "memecoin", "launch", "buy", "price"):
                    continue
                c = counts.setdefault(kw, {"n": 0, "sources": set(), "ev": []})
                c["n"] += 1
                c["sources"].add(e["source"])
                c["ev"].append(i + 1)
        ranked = sorted(counts.items(), key=lambda kv: (-len(kv[1]["sources"]), -kv[1]["n"]))
        narrs, used = [], set()
        for kw, c in ranked:
            if c["n"] < 2 or kw in used:
                continue
            related = [k for k, cc in ranked if k != kw and set(cc["ev"]) & set(c["ev"]) and k not in used][:2]
            used |= {kw, *related}
            first = ev[c["ev"][0] - 1]
            narrs.append({"title": " ".join([kw, *related]), "category": tx.category(" ".join([kw, *related]),
                                                                                    self.cfg.watch.get("category_keywords") or {}),
                          "explanation": f"Mentioned in {c['n']} items across {', '.join(sorted(c['sources']))}. e.g. “{(first.get('text') or '')[:140]}”",
                          "strength": min(100, c["n"] * 10 + len(c["sources"]) * 10), "evidence": c["ev"][:6],
                          "sources": sorted(c["sources"])})
            if len(narrs) >= 4:
                break
        src = sorted({e["source"] for e in ev})
        return {"why_moving": (f"{len(ev)} posts/headlines found across {', '.join(src)}." if ev else
                               "No web or social evidence found yet — attention may be purely on-chain (bots, snipers, paid calls)."),
                "origin": ev[0]["text"][:200] if ev else "", "narratives": narrs,
                "risks": [] if len(src) > 1 else ["single-source attention"]}

    async def build(self, addr: str, use_x: bool = False) -> dict[str, Any] | None:
        if addr in self.inflight:
            return await self.get(addr)
        self.inflight.add(addr)
        try:
            tok = await self.discover.tracker.token_summary(addr)
            if not tok:
                return None
            ev = await self.evidence(tok, use_x)
            # feed web/social finds into the social engine so they cluster and match like any other post
            for e in ev:
                if e["source"] in ("google_news", "reddit", "bluesky", "x") and e.get("url"):
                    await self.social.ingest({"id": f"story:{e['url']}", "source": "rss" if e["source"] == "google_news" else e["source"],
                                              "author": e.get("author") or e["source"], "text": e["text"], "url": e["url"],
                                              "ts": e.get("ts") or time.time(), "engagement": e.get("engagement") or 0})
            method = "heuristic"
            story = self.heuristic(tok, ev)
            if self.ai.enabled and ev:
                try:
                    from .ai import FAST_MODEL
                    numbered = "\n".join(f"[{i + 1}] ({e['source']}{' @' + e['author'] if e.get('author') else ''}) {(e.get('text') or '')[:400]}"
                                         for i, e in enumerate(ev))
                    coin = {k: tok.get(k) for k in ("symbol", "name", "market_cap", "liquidity_usd", "vol_h1", "vol_h24", "chg_h1", "chg_h24",
                                                    "launched_at")}
                    resp = await self.ai._create("story", model=FAST_MODEL, max_tokens=2500,
                                                 system=[{"type": "text", "text": STORY_SYSTEM, "cache_control": {"type": "ephemeral"}}],
                                                 output_config={"effort": "low", "format": {"type": "json_schema", "schema": STORY_SCHEMA}},
                                                 messages=[{"role": "user", "content": f"Coin: {json.dumps(coin, default=str)}\n\nEvidence:\n{numbered}"}])
                    story = json.loads(self.ai._text(resp))
                    for n in story["narratives"]:
                        n["sources"] = sorted({ev[i - 1]["source"] for i in n.get("evidence") or [] if 0 < i <= len(ev)})
                    method = "claude"
                except Exception as e:  # noqa: BLE001
                    log.debug("story ai: %s", e)
            story["evidence"] = [{k: e.get(k) for k in ("source", "text", "url", "author", "ts")} for e in ev]
            story["linked"] = [n for n in (await self.discover._narr([addr]))[addr] if not n.get("from_story")]
            if not story["narratives"]:
                # fall back to the live narratives Radar's social engine already linked to this coin
                story["narratives"] = [{"title": n["title"], "category": n.get("category") or "other",
                                        "explanation": f"Live Radar narrative ({n.get('stage')}, {n.get('vel_5m') or 0}/min across "
                                                       f"{', '.join(n.get('sources') or []) or 'social'}); this coin matches it"
                                                       + (" — but it looks like a copycat." if n.get("fake") else "."),
                                        "strength": min(100, n.get("strength") or 30), "evidence": [], "sources": n.get("sources") or []}
                                       for n in story["linked"][:4]]
            await self.db.exec("INSERT OR REPLACE INTO token_stories (token_address, ts, story_json, method) VALUES (?,?,?,?)",
                               (addr, time.time(), json.dumps(story, default=str), method))
            from .hub import hub
            await hub.publish("story", {"token_address": addr, "method": method, "narratives": story["narratives"],
                                        "why_moving": story["why_moving"]})
            return {**story, "ts": time.time(), "method": method}
        finally:
            self.inflight.discard(addr)

    async def loop(self) -> None:
        """Keep stories fresh for whatever is trending or launching right now."""
        while True:
            try:
                launch = await self.discover.launching(limit=10)
                climb = await self.discover.climbers(limit=10)
                for r in [*launch, *climb]:
                    st = await self.db.one("SELECT ts FROM token_stories WHERE token_address=?", (r["address"],))
                    if not st or st["ts"] < time.time() - 20 * 60:
                        await self.build(r["address"])
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("story loop: %s", e)
            await asyncio.sleep(90)
