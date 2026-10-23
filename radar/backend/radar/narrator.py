"""Claude reads the launches worth reading — in batches, on the cheapest model, never twice.

Every ~40s the launches that already show some life (upside, a WATCH / SNIPE tier, or a decent degen score) and
haven't been read yet go to Claude Haiku in ONE request: narrative, meme score 0-10, copycat flag, red flags and a
one-line take. ~25 coins cost about a tenth of a cent. Results are stored (ai_labels) and fed straight back into the
snipe score (Buzz & narrative detector, `ai_meme_score` / `ai_derivative` filters).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any

from . import feed
from .snipe_metrics import twitter_kind

log = logging.getLogger("radar.narrator")
BATCH = int(os.environ.get("AI_LABEL_BATCH", "25"))
EVERY = float(os.environ.get("AI_LABEL_EVERY", "40"))


class Narrator:
    def __init__(self, db: Any, ai: Any, sniper: Any) -> None:
        self.db, self.ai, self.sniper = db, ai, sniper
        self.done: set[str] = set()
        self.stats = {"labeled": 0, "batches": 0, "errors": 0, "last_error": None, "last_batch": None}

    def candidates(self) -> list[Any]:
        now = time.time()
        out = []
        for L in self.sniper.launches.values():
            if L.mint in self.done or L.ai or not (L.name or L.symbol) or now - L.created < 12:
                continue
            r = L.result or {}
            pri = max(r.get("upside", 0), (r.get("scores") or {}).get("degen", 0) + 5) + (20 if r.get("tier") in ("SNIPE", "WATCH") else 0)
            if pri >= 24 or len(L.buyers) >= 25:
                out.append((pri, L))
        out.sort(key=lambda p: -p[0])
        return [L for _, L in out[:BATCH]]

    async def warm(self) -> None:
        mints = list(self.sniper.launches)
        for i in range(0, len(mints), 400):
            chunk = mints[i:i + 400]
            for r in await self.db.all(f"SELECT mint, label_json FROM ai_labels WHERE mint IN ({','.join('?' * len(chunk))})", chunk):
                L = self.sniper.launches.get(r["mint"])
                if L:
                    L.ai = json.loads(r["label_json"])
                    self.done.add(r["mint"])

    async def run_once(self) -> int:
        if not self.ai.enabled or os.environ.get("AI_LABELS", "1") == "0":
            return 0
        batch = self.candidates()
        if not batch or (len(batch) < 5 and time.time() - (self.stats["last_batch"] or 0) < 180):
            return 0          # wait for a fuller batch: one request per ~5+ coins keeps the bill at cents per day
        coins = [{"mint": L.mint, "name": L.name, "symbol": L.symbol, "description": (L.metadata or {}).get("description"),
                  "twitter_kind": twitter_kind((L.metadata or {}).get("twitter")),
                  "socials": sum(1 for k in ("twitter", "telegram", "website") if (L.metadata or {}).get(k)),
                  "metas": [m.get("name") for m in L.meta]} for L in batch]
        for L in batch:
            self.done.add(L.mint)
        try:
            labels = await self.ai.label_launches(coins)
        except Exception as e:  # noqa: BLE001 - budget reached / API down: try these again later
            for L in batch:
                self.done.discard(L.mint)
            self.stats["errors"] += 1
            self.stats["last_error"] = str(e)[:200]
            return 0
        now = time.time()
        by = {x.get("mint"): x for x in labels}
        rows = []
        for L in batch:
            x = by.get(L.mint)
            if not x:
                continue
            x["meme_score"] = max(0, min(10, int(x.get("meme_score") or 0)))
            x["take"] = (x.get("take") or "")[:120]
            L.ai = {k: x.get(k) for k in ("narrative", "category", "meme_score", "derivative", "red_flags", "take")}
            L.dirty = True
            self.sniper.dirty.add(L.mint)
            rows.append((L.mint, now, json.dumps(L.ai)))
            if x["meme_score"] >= 8 and not x.get("red_flags"):
                await feed.push("claude", "strong_meme", f"✦ ${L.symbol or L.mint[:6]} · meme {x['meme_score']}/10 · {x.get('narrative')}",
                                x["take"], L.mint, symbol=L.symbol)
        if rows:
            await self.db.many("INSERT OR REPLACE INTO ai_labels (mint, ts, label_json) VALUES (?,?,?)", rows)
        self.stats["labeled"] += len(rows)
        self.stats["batches"] += 1
        self.stats["last_batch"] = now
        if len(self.done) > 50000:
            self.done = set(list(self.done)[-20000:])
        return len(rows)

    async def loop(self) -> None:
        await self.warm()
        while True:
            await asyncio.sleep(EVERY)
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("narrator: %s", e)
