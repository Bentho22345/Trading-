"""Social & news intelligence: ingest -> CA detection (FLASH) -> classify -> cluster into narratives
-> velocity/lifecycle -> match launching tokens -> pick the real one from the copycats."""
from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import logging
import math
import re
import time
from collections import defaultdict, deque
from typing import Any

from ..detect import detect
from ..hub import hub
from . import text as tx

log = logging.getLogger("radar.social")
TIER_W = {"vip": 3.0, "kol": 2.0, "news": 2.0, "verified": 1.5, "normal": 1.0, "new": 0.3}
NEWS_SOURCES = {"rss", "google_trends", "polymarket", "youtube"}


def _norm(text: str) -> str:
    return re.sub(r"\W+", " ", (text or "").lower()).strip()[:280]


class SocialEngine:
    def __init__(self, db: Any, cfg: Any, ai: Any, alerts: Any, tracker: Any) -> None:
        self.db, self.cfg, self.ai, self.alerts, self.tracker = db, cfg, ai, alerts, tracker
        self.ai_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)
        self.text_authors: dict[str, set[str]] = defaultdict(set)   # normalized text hash -> authors (bot detection)
        self.recent_ids: deque[str] = deque(maxlen=20000)
        self.seen: set[str] = set()
        self.tasks: list[asyncio.Task] = []
        self.ai_per_min = 30
        self._ai_window: deque[float] = deque()

    def start(self) -> None:
        self.tasks = [asyncio.create_task(c) for c in (self.metrics_loop(), self.match_loop(), self.ai_worker(), self.ai_worker())]

    # ---------------- ingest ----------------
    async def ingest(self, ev: dict[str, Any], fixture: bool = False) -> dict[str, Any] | None:
        eid = ev["id"]
        if eid in self.seen:
            return None
        self.seen.add(eid)
        self.recent_ids.append(eid)
        if len(self.seen) > 25000:
            self.seen = set(self.recent_ids)
        ingested = time.time()
        text = ev.get("text") or ""
        hits = detect(text)
        tier = await self._author(ev)
        cas = hits["solana"] + hits["evm"]
        row = {"id": eid, "source": ev["source"], "author_id": f"{ev['source']}:{ev.get('author')}", "author_tier": tier,
               "followers": ev.get("followers"), "text": text[:4000], "url": ev.get("url"),
               "media_json": json.dumps(ev.get("media")) if ev.get("media") else None,
               "ts": float(ev.get("ts") or ingested), "ingested": ingested, "engagement": ev.get("engagement") or 0,
               "cas_json": json.dumps(cas), "cashtags_json": json.dumps(hits["cashtags"]), "is_fixture": 1 if fixture else 0}
        # 1) highest priority: a CA from a VIP/official account -> FLASH before anything else
        flash = None
        if cas and tier == "vip":
            flash = await self.flash_ca(row, cas[0], ev)
        await self.db.upsert("social_events", row, "id")
        out = {**row, "cas": cas, "cashtags": hits["cashtags"]}
        await hub.publish("social", {k: out[k] for k in ("id", "source", "author_id", "author_tier", "text", "url", "ts",
                                                        "engagement", "cas", "cashtags", "is_fixture")})
        # 2) classify (Claude for high-value posts, heuristics otherwise) and cluster
        cls = tx.heuristic_classify(text, hits["cashtags"], cas, self.cfg.watch.get("category_keywords") or {},
                                    self.cfg.watch.get("exchange_listing_words") or [])
        important = tier in ("vip", "kol", "news") or cas or hits["cashtags"] or (row["engagement"] or 0) >= 200 \
            or ev["source"] in NEWS_SOURCES
        nid = await self.cluster(row, cls, cas, tier)
        if important and self.ai.enabled:
            try:
                self.ai_queue.put_nowait({"row": row, "cas": cas, "tier": tier, "nid": nid})
            except asyncio.QueueFull:
                pass
        if flash:
            out["flash"] = flash
        return out

    async def _author(self, ev: dict[str, Any]) -> str:
        handle = (ev.get("author") or "").lower()
        vips = {x["handle"].lower(): x.get("tier", "vip") for x in self.cfg.watch.get("x_vips") or []}
        kols = {(x.get("handle") or "").lower() for x in self.cfg.watch.get("kol_wallets") or []}
        if ev.get("tier_hint"):
            tier = ev["tier_hint"]
        elif ev["source"] == "x" and handle in vips:
            tier = vips[handle]
        elif handle in kols:
            tier = "kol"
        elif ev["source"] in NEWS_SOURCES:
            tier = "news"
        elif ev.get("author_created") and time.time() - ev["author_created"] < 30 * 86400:
            tier = "new"
        elif ev["source"] == "x" and (ev.get("followers") or 0) < 50:
            tier = "new"
        elif (ev.get("followers") or 0) >= 100_000 or ev.get("verified"):
            tier = "verified"
        else:
            tier = "normal"
        # bot / astroturf: identical text from many distinct authors
        h = hashlib.sha1(_norm(ev.get("text") or "").encode()).hexdigest()[:16]
        self.text_authors[h].add(handle)
        dup = len(self.text_authors[h])
        if len(self.text_authors) > 50000:
            self.text_authors.clear()
        bot = min(1.0, (dup - 2) * 0.25) if dup >= 3 else 0.0
        if tier == "new":
            bot = max(bot, 0.4)
        aid = f"{ev['source']}:{ev.get('author')}"
        await self.db.exec(
            "INSERT INTO authors (id, source, handle, name, followers, created_at, tier, bot_score, posts, last_seen) "
            "VALUES (?,?,?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET followers=COALESCE(excluded.followers, followers), "
            "tier=excluded.tier, bot_score=MAX(bot_score, excluded.bot_score), posts=posts+1, last_seen=excluded.last_seen",
            (aid, ev["source"], ev.get("author"), ev.get("author_name"), ev.get("followers"), ev.get("author_created"),
             tier, bot, time.time()))
        return tier

    # ---------------- FLASH ----------------
    async def flash_ca(self, row: dict[str, Any], ca: str, ev: dict[str, Any], narrative_id: int | None = None) -> dict[str, Any]:
        detected = row["ingested"]
        links = {"dexscreener": f"https://dexscreener.com/solana/{ca}", "axiom": f"https://axiom.trade/t/{ca}",
                 "photon": f"https://photon-sol.tinyastro.io/en/lp/{ca}", "rugcheck": f"https://rugcheck.xyz/tokens/{ca}",
                 "gmgn": f"https://gmgn.ai/sol/token/{ca}"}
        payload = {"kind": "vip_ca", "token_address": ca, "author": ev.get("author"), "source": row["source"],
                   "text": row["text"][:500], "url": row["url"], "post_ts": row["ts"], "detected_ts": detected,
                   "links": links, "is_fixture": row["is_fixture"]}
        pushed = time.time()
        payload["pushed_ts"] = pushed
        payload["latency_ms"] = round((pushed - row["ts"]) * 1000)
        payload["internal_ms"] = round((pushed - detected) * 1000, 1)
        await hub.publish("flash", payload)                                   # on screen first
        fid = await self.db.exec(
            "INSERT INTO flash_events (kind, narrative_id, token_address, social_event_id, author, text, post_ts, detected_ts, "
            "pushed_ts, latency_ms, is_fixture) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ("vip_ca", narrative_id, ca, row["id"], ev.get("author"), row["text"][:1000], row["ts"], detected, pushed,
             payload["latency_ms"], row["is_fixture"]))
        payload["id"] = fid
        title = f"⚡ FLASH: {ev.get('author')} posted a contract address"
        asyncio.create_task(self.alerts.send("flash", title, row["text"][:300], token=ca, dedupe=f"flash:{ca}", ttl=3600,
                                             extra={"flash_id": fid}))
        self.tracker.flash_tokens[ca] = time.time() + 1800                   # max refresh rate for 30 min
        asyncio.create_task(self._flash_enrich(fid, ca, payload))
        return payload

    async def _flash_enrich(self, fid: int, ca: str, payload: dict[str, Any]) -> None:
        try:
            await self.tracker._ensure_token(ca, "solana", None, None, None, "flash")
            await self.tracker.refresh("solana", [ca])
        except Exception as e:  # noqa: BLE001
            log.debug("flash refresh: %s", e)
        self.tracker.queue_rug(ca)
        for _ in range(30):  # safety check runs automatically; wait up to ~15s for it
            s = await self.db.one("SELECT * FROM safety_reports WHERE token_address=?", (ca,))
            if s:
                break
            await asyncio.sleep(0.5)
        tok = await self.tracker.token_summary(ca)
        safety = await self.db.one("SELECT mint_authority, freeze_authority, lp_locked_pct, top10_pct, score_normalised, rugged "
                                   "FROM safety_reports WHERE token_address=?", (ca,))
        await self.db.exec("UPDATE flash_events SET safety_json=? WHERE id=?", (json.dumps(safety), fid))
        await hub.publish("flash_update", {"id": fid, "token_address": ca, "token": tok, "safety": safety})

    # ---------------- classify / cluster ----------------
    async def ai_worker(self) -> None:
        while True:
            job = await self.ai_queue.get()
            now = time.time()
            while self._ai_window and self._ai_window[0] < now - 60:
                self._ai_window.popleft()
            if len(self._ai_window) >= self.ai_per_min and job["tier"] not in ("vip", "news"):
                continue
            self._ai_window.append(now)
            row = job["row"]
            try:
                cls = await self.ai.classify(row["text"], row["source"], row["author_id"])
                cls["method"] = "claude"
                await self.db.exec("UPDATE social_events SET ai_json=? WHERE id=?", (json.dumps(cls), row["id"]))
                if cls.get("tokenizable") or job["cas"]:
                    await self.cluster(row, cls, job["cas"], job["tier"], refine=job["nid"])
            except Exception as e:  # noqa: BLE001
                log.debug("classify: %s", e)

    async def cluster(self, row: dict[str, Any], cls: dict[str, Any], cas: list[str], tier: str,
                      refine: int | None = None) -> int | None:
        if refine is None:
            await self.db.exec("UPDATE social_events SET ai_json=COALESCE(ai_json, ?) WHERE id=?", (json.dumps(cls), row["id"]))
        if not (cls.get("tokenizable") or cas):
            return None
        kws = [k.lower() for k in cls.get("keywords") or []]
        tick = [t.upper().lstrip("$") for t in (cls.get("ticker_candidates") or []) + (cls.get("name_candidates") or [])]
        tick = [re.sub(r"[^A-Z0-9]", "", t)[:12] for t in tick if t]
        now = time.time()
        best, best_sim = None, 0.0
        if refine:
            best = await self.db.one("SELECT * FROM narratives WHERE id=?", (refine,))
            best_sim = 1.0
        else:
            for n in await self.db.all("SELECT * FROM narratives WHERE last_seen > ? ORDER BY last_seen DESC LIMIT 400",
                                       (now - 6 * 3600,)):
                nk, nt = json.loads(n["keywords_json"] or "[]"), json.loads(n["tickers_json"] or "[]")
                flags = json.loads(n["flags_json"] or "{}")
                sim = tx.jaccard(kws, nk) + 0.6 * tx.jaccard(tick, nt)
                if cas and set(cas) & set(flags.get("cas") or []):
                    sim += 1
                if sim > best_sim:
                    best, best_sim = n, sim
        if best and best_sim >= 0.3:
            nid = best["id"]
            nk = list(dict.fromkeys(json.loads(best["keywords_json"] or "[]") + kws))[:20]
            nt = list(dict.fromkeys(json.loads(best["tickers_json"] or "[]") + tick))[:20]
            flags = json.loads(best["flags_json"] or "{}")
            cat = best["category"] if best["category"] not in (None, "other") else cls.get("category")
            title = cls.get("title") if cls.get("method") == "claude" and refine else best["title"]
            life = cls.get("expected_life_hours") if cls.get("method") == "claude" else best["expected_life_h"]
        else:
            nk, nt, flags, cat, title = kws[:20], tick[:20], {}, cls.get("category"), cls.get("title")
            life = cls.get("expected_life_hours") or self.cfg.scoring["narrative"]["expected_life_hours"]
            nid = await self.db.exec("INSERT INTO narratives (title, category, keywords_json, tickers_json, first_seen, last_seen, "
                                     "stage, posts, expected_life_h, updated, flags_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                     (title, cat, json.dumps(nk), json.dumps(nt), row["ts"], row["ts"], "birth", 0, life, now, "{}"))
            await hub.publish("narrative_new", {"id": nid, "title": title, "category": cat})
        if tier == "vip":
            flags["vip_mention"] = True
        if cas:
            flags["cas"] = list(dict.fromkeys((flags.get("cas") or []) + cas))[:20]
            if tier == "vip":
                flags["vip_cas"] = list(dict.fromkeys((flags.get("vip_cas") or []) + cas))[:10]
        if cls.get("is_breaking_news"):
            flags["breaking_news"] = True
        if cls.get("is_exchange_listing"):
            flags["exchange_listing"] = True
        await self.db.exec("UPDATE narratives SET keywords_json=?, tickers_json=?, flags_json=?, category=?, title=?, "
                           "expected_life_h=?, last_seen=MAX(last_seen, ?), updated=? WHERE id=?",
                           (json.dumps(nk), json.dumps(nt), json.dumps(flags), cat, title, life, row["ts"], now, nid))
        await self.db.exec("UPDATE social_events SET narrative_id=? WHERE id=?", (nid, row["id"]))
        return nid

    # ---------------- metrics / lifecycle / velocity FLASH ----------------
    async def metrics_loop(self) -> None:
        while True:
            try:
                await self.update_metrics()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("narrative metrics: %s", e)
            await asyncio.sleep(5)

    async def update_metrics(self) -> None:
        now = time.time()
        k = self.cfg.scoring["narrative"]
        for n in await self.db.all("SELECT * FROM narratives WHERE last_seen > ?", (now - 24 * 3600,)):
            rows = await self.db.all(
                "SELECT e.ts, e.source, e.author_id, e.author_tier, e.followers, e.engagement, COALESCE(a.bot_score,0) bot "
                "FROM social_events e LEFT JOIN authors a ON a.id=e.author_id WHERE e.narrative_id=? AND e.ts > ?",
                (n["id"], now - 24 * 3600))
            if not rows:
                continue
            c1 = sum(r["ts"] > now - 60 for r in rows)
            c5 = sum(r["ts"] > now - 300 for r in rows)
            c60 = sum(r["ts"] > now - 3600 for r in rows)
            age_min = max(1.0, (now - (n["first_seen"] or now)) / 60)
            base = (len(rows) - c5) / max(5.0, min(age_min, 1440) - 5)          # per-minute baseline before the last 5m
            v5 = c5 / 5
            z = (v5 - base) / math.sqrt(max(base, 0.05) / 5)                    # Poisson z-score of the last 5 minutes
            authors = {r["author_id"] for r in rows}
            sources = sorted({r["source"] for r in rows})
            reach = sum(TIER_W.get(r["author_tier"] or "normal", 1) * math.log10((r["followers"] or 10) + 10) for r in rows)
            bot_share = sum(1 for r in rows if (r["bot"] or 0) >= 0.5) / len(rows)
            if age_min < 15 or len(rows) < 5:
                stage = "birth"
            elif now - max(r["ts"] for r in rows) > 1800 or (c60 and v5 < 0.4 * (c60 / 60)):
                stage = "fading"
            elif c1 >= v5 and v5 >= max(base * 1.5, 0.2):
                stage = "ignition"
            else:
                stage = "peak" if v5 >= base else "fading"
            strength = min(100.0, 20 * math.log2(1 + v5 * 5) + 10 * len(sources) + min(30, reach / 10)) * (1 - 0.5 * bot_share)
            flash_until = n["flash_until"]
            if z >= k["breakout_sigma"] and c5 >= 5 and (not flash_until or flash_until < now) and stage != "fading":
                flash_until = now + 1800
                await self._velocity_flash(n, v5, z, sources)
            await self.db.exec("UPDATE narratives SET stage=?, posts=?, authors=?, sources_json=?, vel_1m=?, vel_5m=?, vel_1h=?, "
                               "accel=?, reach=?, bot_share=?, strength=?, flash_until=?, zscore=?, updated=? WHERE id=?",
                               (stage, len(rows), len(authors), json.dumps(sources), c1, round(v5, 2), round(c60 / 60, 3),
                                round(c1 - v5, 2), round(reach, 1), round(bot_share, 2), round(strength, 1), flash_until,
                                round(z, 2), now, n["id"]))
        await hub.publish("narratives", await self.board(limit=40))

    async def _velocity_flash(self, n: dict[str, Any], v5: float, z: float, sources: list[str]) -> None:
        now = time.time()
        matches = await self.db.all("SELECT token_address FROM narrative_tokens WHERE narrative_id=? ORDER BY legit_score DESC LIMIT 5",
                                    (n["id"],))
        for m in matches:
            self.tracker.flash_tokens[m["token_address"]] = now + 1800
        payload = {"kind": "narrative_breakout", "narrative_id": n["id"], "title": n["title"], "category": n["category"],
                   "vel_5m": v5, "zscore": round(z, 1), "sources": sources, "pushed_ts": now,
                   "tokens": [m["token_address"] for m in matches]}
        await hub.publish("flash", payload)
        await self.db.exec("INSERT INTO flash_events (kind, narrative_id, token_address, text, detected_ts, pushed_ts, latency_ms) "
                           "VALUES (?,?,?,?,?,?,?)", ("narrative_breakout", n["id"], matches[0]["token_address"] if matches else None,
                                                     n["title"], now, now, 0))
        await self.alerts.send("flash", f"⚡ Narrative breakout: {n['title']}",
                               f"{v5:.1f} mentions/min ({z:.1f}σ above baseline) across {', '.join(sources)}",
                               dedupe=f"nflash:{n['id']}", ttl=3600)

    # ---------------- token matching & real-vs-fake ----------------
    async def match_loop(self) -> None:
        searched: dict[str, float] = {}
        while True:
            try:
                await self.match_tokens(searched)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("token matching: %s", e)
            await asyncio.sleep(10)

    async def match_tokens(self, searched: dict[str, float]) -> None:
        now = time.time()
        recent = await self.db.all("SELECT address, symbol, name, first_seen, launched_at, deployer FROM tokens "
                                   "WHERE first_seen > ? AND symbol IS NOT NULL", (now - 6 * 3600,))
        for n in await self.db.all("SELECT * FROM narratives WHERE last_seen > ? AND stage != 'fading' ORDER BY strength DESC LIMIT 60",
                                   (now - 6 * 3600,)):
            ticks = [t for t in json.loads(n["tickers_json"] or "[]") if len(t) >= 2]
            kws = [k for k in json.loads(n["keywords_json"] or "[]") if len(k) >= 4][:6]
            flags = json.loads(n["flags_json"] or "{}")
            cands: dict[str, tuple[float, list[str]]] = {}
            for ca in flags.get("cas") or []:
                cands[ca] = (1.0, ["contract address posted in the narrative"])
            for t in recent:
                sym = re.sub(r"[^A-Z0-9]", "", (t["symbol"] or "").upper())
                name = (t["name"] or "").lower()
                score, why = 0.0, []
                for tk in ticks:
                    if sym == tk:
                        score, why = max(score, 0.95), [f"ticker ${sym} matches"]
                    elif len(tk) >= 4 and difflib.SequenceMatcher(None, sym, tk).ratio() >= 0.8:
                        if score < 0.7:
                            score, why = 0.7, [f"ticker ${sym} ≈ {tk}"]
                for kw in kws:
                    if kw in name and score < 0.6:
                        score, why = 0.6, [f"name contains '{kw}'"]
                if score and (t["first_seen"] or 0) >= (n["first_seen"] or now) - 3600:
                    cands[t["address"]] = max(cands.get(t["address"], (0, [])), (score, why))
            # discover tokens we haven't seen via DexScreener search (rate-limited per ticker)
            if n["stage"] in ("ignition", "peak") or flags.get("vip_mention"):
                for tk in ticks[:3]:
                    if searched.get(tk, 0) > now - 120:
                        continue
                    searched[tk] = now
                    try:
                        for p in (await self.tracker.dex.search(tk))[:15]:
                            b = p.get("baseToken") or {}
                            if re.sub(r"[^A-Z0-9]", "", (b.get("symbol") or "").upper()) == tk and b.get("address"):
                                await self.tracker._ensure_token(b["address"], p.get("chainId") or "solana", b.get("name"),
                                                                 b.get("symbol"), None, "dexscreener_search",
                                                                 (p.get("pairCreatedAt") or 0) / 1000 or None)
                                cands.setdefault(b["address"], (0.9, [f"DexScreener search ${tk}"]))
                    except Exception as e:  # noqa: BLE001
                        log.debug("dex search %s: %s", tk, e)
            if cands:
                await self._legitimacy(n, flags, cands)

    async def _legitimacy(self, n: dict[str, Any], flags: dict[str, Any], cands: dict[str, tuple[float, list[str]]]) -> None:
        now = time.time()
        addrs = list(cands)[:60]
        toks = {r["address"]: r for r in await self.db.all(
            "SELECT t.address, t.first_seen, t.launched_at, t.deployer, t.boost_amount, p.vol_h1, p.liquidity_usd, s.holders, "
            "s.rugged FROM tokens t LEFT JOIN pairs p ON p.pair_address=t.best_pair LEFT JOIN safety_reports s "
            f"ON s.token_address=t.address WHERE t.address IN ({','.join('?' * len(addrs))})", addrs)}
        vip_cas = set(flags.get("vip_cas") or [])
        launches = sorted((t.get("launched_at") or t.get("first_seen") or now) for t in toks.values()) or [now]
        vols = sorted((t.get("vol_h1") or 0) for t in toks.values())
        rows = []
        for a in addrs:
            t = toks.get(a, {})
            ms, why = cands[a]
            why = list(why)
            legit = 0.0
            if a in vip_cas:
                legit += 50
                why.append("CA posted by a VIP/official account")
            launch = t.get("launched_at") or t.get("first_seen")
            if launch and launch == launches[0]:
                legit += 15
                why.append("earliest launch")
            if vols and (t.get("vol_h1") or 0) > 0:
                legit += 20 * (vols.index(t.get("vol_h1") or 0) + 1) / len(vols)
            if t.get("holders"):
                legit += min(10, math.log10(t["holders"] + 1) * 3)
            if t.get("boost_amount"):
                legit -= 5
                why.append("paid boosts")
            if t.get("rugged"):
                legit -= 50
            dev = await self.deployer_history(t.get("deployer"))
            if dev["rugged_tokens"]:
                legit -= 30
                why.append(f"deployer has {dev['rugged_tokens']} rugged token(s)")
            rows.append([a, ms, legit, why])
        rows.sort(key=lambda r: (-r[2], -r[1]))
        top = rows[0][2] if rows else 0
        for a, ms, legit, why in rows:
            fake = len(rows) > 1 and a != rows[0][0] and (bool(vip_cas) and a not in vip_cas or legit < top - 25)
            if fake:
                why.append("likely copycat")
            await self.db.exec("INSERT INTO narrative_tokens (narrative_id, token_address, match_score, legit_score, is_likely_fake, "
                               "reasons_json, updated) VALUES (?,?,?,?,?,?,?) ON CONFLICT(narrative_id, token_address) DO UPDATE SET "
                               "match_score=excluded.match_score, legit_score=excluded.legit_score, is_likely_fake=excluded.is_likely_fake, "
                               "reasons_json=excluded.reasons_json, updated=excluded.updated",
                               (n["id"], a, ms, round(legit, 1), 1 if fake else 0, json.dumps(why), now))

    async def deployer_history(self, deployer: str | None) -> dict[str, Any]:
        if not deployer:
            return {"tokens": 0, "rugged_tokens": 0}
        r = await self.db.one("SELECT COUNT(*) n, SUM(COALESCE(s.rugged,0)) rugged FROM tokens t LEFT JOIN safety_reports s "
                              "ON s.token_address=t.address WHERE t.deployer=?", (deployer,))
        return {"tokens": r["n"] or 0, "rugged_tokens": int(r["rugged"] or 0)}

    # ---------------- read models ----------------
    async def narrative_for_token(self, addr: str) -> dict[str, Any] | None:
        r = await self.db.one(
            "SELECT n.*, nt.match_score, nt.legit_score, nt.is_likely_fake, nt.reasons_json FROM narrative_tokens nt "
            "JOIN narratives n ON n.id=nt.narrative_id WHERE nt.token_address=? AND n.last_seen > ? "
            "ORDER BY nt.match_score * COALESCE(n.strength, 0) DESC LIMIT 1", (addr, time.time() - 24 * 3600))
        if not r:
            return None
        flags = json.loads(r.pop("flags_json") or "{}")
        r["sources"] = json.loads(r.pop("sources_json") or "[]")
        r["vip_mention"] = bool(flags.get("vip_mention"))
        r["vip_ca"] = bool(flags.get("vip_cas"))
        r["vip_ca_match"] = addr in (flags.get("vip_cas") or [])
        r["breaking_news"] = bool(flags.get("breaking_news"))
        r["exchange_listing"] = bool(flags.get("exchange_listing"))
        r["reach_score"] = min(100, (r.get("reach") or 0) / 3)
        return r

    async def board(self, limit: int = 50, hours: float = 24) -> list[dict[str, Any]]:
        now = time.time()
        rows = await self.db.all("SELECT * FROM narratives WHERE last_seen > ? AND posts > 0 ORDER BY "
                                 "CASE stage WHEN 'ignition' THEN 0 WHEN 'birth' THEN 1 WHEN 'peak' THEN 2 ELSE 3 END, strength DESC LIMIT ?",
                                 (now - hours * 3600, limit))
        for r in rows:
            r["keywords"] = json.loads(r.pop("keywords_json") or "[]")
            r["tickers"] = json.loads(r.pop("tickers_json") or "[]")
            r["sources"] = json.loads(r.pop("sources_json") or "[]")
            r["flags"] = json.loads(r.pop("flags_json") or "{}")
            r["flash"] = bool(r.get("flash_until") and r["flash_until"] > now)
        return rows

    async def sparkline(self, nid: int, minutes: int = 60) -> list[int]:
        now = time.time()
        rows = await self.db.all("SELECT ts FROM social_events WHERE narrative_id=? AND ts > ?", (nid, now - minutes * 60))
        buckets = [0] * minutes
        for r in rows:
            i = int((now - r["ts"]) // 60)
            if 0 <= i < minutes:
                buckets[minutes - 1 - i] += 1
        return buckets
