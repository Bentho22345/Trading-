"""Meta board: every recurring memecoin theme (dogs, cats, AI agents, PolitiFi, brainrot, Base memes, listings...) from
config/metas.yaml, ranked live by heat.

Each meta is scored from four live inputs, all measured by Radar itself:
  mentions  social posts + headlines matching the meta (last hour vs the prior 6h baseline)
  launches  new coins whose name/symbol fits the meta (last hour vs the prior 6h)
  volume    1h DEX volume of matching coins, and how fast it is rising vs the 24h pace
  price     volume-weighted 1h change of matching coins
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import time
from collections import defaultdict
from typing import Any

from .cfg import load_yaml
from .hub import hub
from .tracker import TOKEN_SUMMARY_SQL

log = logging.getLogger("radar.metas")
NEWS_SOURCES = {"rss", "google_trends", "polymarket", "youtube"}
BUCKET_S = 600            # mention buckets are 10 minutes
WINDOW_S = 24 * 3600      # keep 24h of mention buckets


def _sat(x: float) -> float:
    return max(0.0, min(1.0, x))


class Meta:
    def __init__(self, d: dict[str, Any], families: dict[str, str]) -> None:
        self.id: str = d["id"]
        self.name: str = d.get("name") or self.id
        self.family: str = d.get("family") or "topics"
        self.family_name: str = families.get(self.family, self.family)
        self.emoji: str = d.get("emoji") or ""
        self.keywords = [str(k).lower() for k in d.get("keywords") or []]
        self.phrases = [str(p).lower() for p in d.get("phrases") or []]
        self.tickers = {str(t).upper().lstrip("$") for t in d.get("tickers") or [] if t}
        words = sorted(set(self.keywords) | {p for p in self.phrases if p.isascii()}, key=len, reverse=True)
        self.rx = re.compile(r"(?<![a-z0-9])(?:" + "|".join(re.escape(w) for w in words) + r")(?![a-z0-9])") if words else None
        self.cjk = [p for p in self.phrases if not p.isascii()]
        tick = sorted(self.tickers, key=len, reverse=True)
        self.tick_rx = re.compile(r"\$(?:" + "|".join(re.escape(t.lower()) for t in tick) + r")(?![a-z0-9])") if tick else None
        self.sym_affixes = [k.replace(".", "").replace("-", "") for k in self.keywords if len(k) >= 3 and k.replace(".", "").isalnum()]

    def text_match(self, low: str) -> bool:
        if self.rx and self.rx.search(low):
            return True
        if self.tick_rx and self.tick_rx.search(low):
            return True
        return any(p in low for p in self.cjk)

    def coin_match(self, name: str | None, symbol: str | None) -> bool:
        sym = re.sub(r"[^A-Z0-9]", "", (symbol or "").upper())
        if sym and sym in self.tickers:
            return True
        low = (name or "").lower()
        if low and self.text_match(low):
            return True
        s = sym.lower()
        if len(s) >= 3:
            for k in self.sym_affixes:
                if s == k or (len(s) > len(k) and (s.startswith(k) or s.endswith(k))):
                    return True
        return False


def load_metas() -> list[Meta]:
    cfg = load_yaml("metas.yaml")
    fam = cfg.get("families") or {}
    return [Meta(m, fam) for m in cfg.get("metas") or [] if m.get("id")]


class MetaBoard:
    def __init__(self, db: Any, alerts: Any = None) -> None:
        self.db, self.alerts = db, alerts
        self.metas = load_metas()
        self.by_id = {m.id: m for m in self.metas}
        # meta id -> bucket start -> [mentions, news]
        self.buckets: dict[str, dict[int, list[int]]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))
        self.cursor = 0.0
        self.rows: list[dict[str, Any]] = []
        self.prev_status: dict[str, str] = {}
        self.as_of = 0.0
        self._coin_cache: dict[tuple[str | None, str | None], list[str]] = {}

    # ---------------- matching (also used by news tagging) ----------------
    def match_text(self, text: str) -> list[str]:
        low = (text or "").lower()
        return [m.id for m in self.metas if m.text_match(low)]

    def match_coin(self, name: str | None, symbol: str | None) -> list[str]:
        key = (name, symbol)
        hit = self._coin_cache.get(key)
        if hit is None:
            if len(self._coin_cache) > 200_000:
                self._coin_cache.clear()
            hit = self._coin_cache[key] = [m.id for m in self.metas if m.coin_match(name, symbol)]
        return hit

    # ---------------- mention counting ----------------
    def _count(self, rows: list[dict[str, Any]]) -> None:
        cut = time.time() - WINDOW_S
        for r in rows:
            ts = r["ts"] or r["ingested"]
            if ts < cut:
                continue
            b = int(ts // BUCKET_S * BUCKET_S)
            news = r["source"] in NEWS_SOURCES
            for mid in self.match_text(r["text"] or ""):
                cell = self.buckets[mid][b]
                cell[0] += 1
                if news:
                    cell[1] += 1

    async def scan_mentions(self) -> None:
        now = time.time()
        if not self.cursor:
            self.cursor = now - WINDOW_S
        while True:
            rows = await self.db.all("SELECT source, text, ts, ingested FROM social_events WHERE ingested > ? AND is_fixture=0 "
                                     "ORDER BY ingested LIMIT 5000", (self.cursor,))
            if not rows:
                break
            self._count(rows)
            self.cursor = rows[-1]["ingested"]
            if len(rows) < 5000:
                break
            await asyncio.sleep(0)
        cut = int((now - WINDOW_S) // BUCKET_S * BUCKET_S)
        for mid in list(self.buckets):
            for b in [b for b in self.buckets[mid] if b < cut]:
                del self.buckets[mid][b]

    def _mentions(self, mid: str, now: float) -> dict[str, Any]:
        bk = self.buckets.get(mid) or {}
        def total(lo: float, hi: float, idx: int = 0) -> int:
            # a bucket belongs to the window holding its midpoint; the current, partly elapsed bucket counts as "now"
            return sum(v[idx] for b, v in bk.items() if lo <= min(b + BUCKET_S / 2, now) < hi)
        m1 = total(now - 3600, now + 1)
        base = total(now - 7 * 3600, now - 3600) / 6
        spark_start = int((now - 6 * 3600) // BUCKET_S * BUCKET_S) + BUCKET_S
        spark = [(bk.get(spark_start + i * BUCKET_S) or [0, 0])[0] for i in range(36)]
        return {"m_1h": m1, "m_base_h": round(base, 1), "m_24h": total(now - 86400, now + 1),
                "news_1h": total(now - 3600, now + 1, 1), "spark": spark}

    # ---------------- the board ----------------
    async def compute(self) -> list[dict[str, Any]]:
        now = time.time()
        await self.scan_mentions()
        toks = await self.db.all(TOKEN_SUMMARY_SQL + " WHERE t.best_pair IS NOT NULL AND p.as_of > ?", (now - 1800,))
        coins: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for t in toks:
            for mid in self.match_coin(t["name"], t["symbol"]):
                coins[mid].append(t)
        launches: dict[str, list[float]] = defaultdict(list)
        for t in await self.db.all("SELECT name, symbol, COALESCE(launched_at, first_seen) ts FROM tokens WHERE COALESCE(launched_at, first_seen) > ?",
                                   (now - 7 * 3600,)):
            for mid in self.match_coin(t["name"], t["symbol"]):
                launches[mid].append(t["ts"])
        narr = await self.db.all("SELECT id, title, category, stage, strength, vel_5m, keywords_json, tickers_json FROM narratives "
                                 "WHERE last_seen > ? AND posts > 0 ORDER BY strength DESC LIMIT 300", (now - 6 * 3600,))
        narr_by: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for n in narr:
            blob = " ".join([n["title"] or "", *json.loads(n["keywords_json"] or "[]")]) + " " + \
                " ".join(f"${t}" for t in json.loads(n["tickers_json"] or "[]"))
            for mid in self.match_text(blob):
                if len(narr_by[mid]) < 6:
                    narr_by[mid].append({k: n[k] for k in ("id", "title", "category", "stage", "strength", "vel_5m")})
        total_vol = sum((t["vol_h1"] or 0) for t in toks) or 1.0
        out = []
        for m in self.metas:
            cs = coins.get(m.id, [])
            vol1 = sum((c["vol_h1"] or 0) for c in cs)
            vol24 = sum((c["vol_h24"] or 0) for c in cs)
            mcap = sum((c["market_cap"] or c["fdv"] or 0) for c in cs)
            wsum = sum((c["vol_h1"] or 0) for c in cs if c["chg_h1"] is not None)
            chg1 = sum((c["vol_h1"] or 0) * c["chg_h1"] for c in cs if c["chg_h1"] is not None) / wsum if wsum else None
            wsum24 = sum((c["market_cap"] or c["fdv"] or 0) for c in cs if c["chg_h24"] is not None)
            chg24 = (sum((c["market_cap"] or c["fdv"] or 0) * c["chg_h24"] for c in cs if c["chg_h24"] is not None) / wsum24
                     if wsum24 else None)
            ls = launches.get(m.id, [])
            l1 = sum(1 for x in ls if x > now - 3600)
            l_base = sum(1 for x in ls if x <= now - 3600) / 6
            men = self._mentions(m.id, now)
            social_accel = (men["m_1h"] + 1) / (men["m_base_h"] + 1)
            vol_accel = vol1 * 24 / vol24 if vol24 > 0 else (2.0 if vol1 else 0.0)
            launch_accel = (l1 + 1) / (l_base + 1)
            heat = 100 * (0.25 * _sat(math.log10(1 + men["m_1h"]) / 2.3)
                          + 0.15 * _sat((social_accel - 1) / 2)
                          + 0.20 * _sat(math.log10(1 + vol1) / 6.7)
                          + 0.15 * _sat((vol_accel - 1) / 2)
                          + 0.10 * _sat((chg1 or 0) / 40)
                          + 0.15 * _sat(math.log2(1 + l1) / 5) * min(1.0, launch_accel / 1.5))
            heat = round(heat, 1)
            if heat < 12:
                status = "quiet"
            elif heat >= 55 and (social_accel >= 1.2 or vol_accel >= 1.2):
                status = "hot"
            elif social_accel >= 1.6 or vol_accel >= 1.6 or launch_accel >= 2:
                status = "heating"
            elif social_accel < 0.7 and vol_accel < 0.8:
                status = "cooling"
            else:
                status = "active"
            leaders = sorted(cs, key=lambda c: -(c["vol_h1"] or 0))[:5]
            out.append({
                "id": m.id, "name": m.name, "family": m.family, "family_name": m.family_name, "emoji": m.emoji,
                "heat": heat, "status": status, "coins": len(cs), "mcap": round(mcap), "vol_h1": round(vol1), "vol_h24": round(vol24),
                "vol_share_h1": round(vol1 / total_vol * 100, 2), "chg_h1": None if chg1 is None else round(chg1, 1),
                "chg_h24": None if chg24 is None else round(chg24, 1), "launches_1h": l1, "launch_base_h": round(l_base, 1),
                "social_accel": round(social_accel, 2), "vol_accel": round(vol_accel, 2), **men,
                "leaders": [{k: c[k] for k in ("address", "chain", "symbol", "name", "image", "market_cap", "vol_h1", "chg_h1", "price_usd")}
                            for c in leaders],
                "narratives": narr_by.get(m.id, []),
            })
        out.sort(key=lambda r: -r["heat"])
        for i, r in enumerate(out):
            r["rank"] = i + 1
        return out

    async def alert_changes(self, rows: list[dict[str, Any]]) -> None:
        for r in rows:
            prev = self.prev_status.get(r["id"])
            self.prev_status[r["id"]] = r["status"]
            if not self.alerts or prev is None or prev in ("hot",) or r["status"] != "hot":
                continue
            lead = ", ".join(f"${c['symbol']}" for c in r["leaders"][:3] if c.get("symbol"))
            await self.alerts.send("info", f"{r['emoji']} Meta heating up: {r['name']}",
                                   f"{r['m_1h']} mentions in the last hour ({r['social_accel']}x baseline), {r['launches_1h']} launches, "
                                   f"1h volume {r['vol_accel']}x its 24h pace." + (f" Leaders: {lead}" if lead else ""),
                                   dedupe=f"meta:{r['id']}", ttl=3 * 3600)

    async def refresh(self) -> list[dict[str, Any]]:
        rows = await self.compute()
        self.rows, self.as_of = rows, time.time()
        await self.alert_changes(rows)
        await hub.publish("metas", self.compact())
        return rows

    def compact(self) -> dict[str, Any]:
        keep = ("id", "name", "family", "family_name", "emoji", "heat", "status", "coins", "mcap", "vol_h1", "vol_share_h1", "chg_h1",
                "chg_h24", "launches_1h", "m_1h", "news_1h", "social_accel", "vol_accel", "spark", "rank")
        return {"as_of": self.as_of, "metas": [{**{k: r[k] for k in keep}, "leaders": r["leaders"][:3],
                                                "narratives": r["narratives"][:2]} for r in self.rows]}

    async def loop(self, every: float = 20) -> None:
        while True:
            try:
                await self.refresh()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("meta board: %s", e)
            await asyncio.sleep(every)

    async def detail(self, mid: str) -> dict[str, Any] | None:
        m = self.by_id.get(mid)
        if not m:
            return None
        row = next((r for r in self.rows if r["id"] == mid), None)
        now = time.time()
        toks = await self.db.all(TOKEN_SUMMARY_SQL + " WHERE t.best_pair IS NOT NULL AND p.as_of > ?", (now - 1800,))
        coins = sorted((t for t in toks if mid in self.match_coin(t["name"], t["symbol"])), key=lambda c: -(c["vol_h1"] or 0))[:25]
        posts, news = [], []
        for r in await self.db.all("SELECT id, source, author_id, author_tier, text, url, ts FROM social_events WHERE ts > ? AND is_fixture=0 "
                                   "ORDER BY ts DESC LIMIT 4000", (now - 6 * 3600,)):
            if m.text_match((r["text"] or "").lower()):
                (news if r["source"] in NEWS_SOURCES else posts).append(r)
            if len(posts) >= 30 and len(news) >= 20:
                break
        return {"meta": {"id": m.id, "name": m.name, "family": m.family_name, "emoji": m.emoji, "keywords": m.keywords,
                         "phrases": m.phrases, "tickers": sorted(m.tickers)},
                "stats": row, "coins": coins, "posts": posts[:30], "news": news[:20]}
