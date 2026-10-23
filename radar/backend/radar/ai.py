"""Claude, in economy mode: every call defaults to Claude Haiku 5.5 ($0.10 / $0.50 per 1M tokens) at low effort, with
thinking off for structured extraction, batched (many launches per request) and cached in the database.

Spend is metered into api_usage (cost_usd) and capped by AI_DAILY_BUDGET_USD (default $1/day; typical use is cents).
Set RADAR_SMART_MODEL=claude-sonnet-5-5 if you want richer write-ups / Ask Radar answers and don't mind paying more.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Awaitable, Callable

import anthropic

from .db import DB
from .health import Health, register

log = logging.getLogger("radar.ai")
health = register(Health("anthropic", "rest", "Claude: narrative extraction, write-ups, brief, Ask Radar"))
health.stale_after = 6 * 3600

FAST_MODEL = os.environ.get("RADAR_FAST_MODEL", "claude-haiku-5-5")
SMART_MODEL = os.environ.get("RADAR_SMART_MODEL", "claude-haiku-5-5")
# $ per 1M tokens (input, output) — update if pricing changes
PRICES = {"claude-haiku-5-5": (0.10, 0.50), "claude-sonnet-5-5": (2.0, 10.0), "claude-opus-5-5": (4.0, 20.0)}

CLASSIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "tokenizable": {"type": "boolean"},
        "category": {"type": "string", "enum": ["politifi", "ai", "animal", "celebrity", "news", "sports", "gaming", "meme", "other"]},
        "title": {"type": "string"},
        "ticker_candidates": {"type": "array", "items": {"type": "string"}},
        "name_candidates": {"type": "array", "items": {"type": "string"}},
        "keywords": {"type": "array", "items": {"type": "string"}},
        "sentiment": {"type": "number"},
        "expected_life_hours": {"type": "number"},
        "is_breaking_news": {"type": "boolean"},
        "is_exchange_listing": {"type": "boolean"},
    },
    "required": ["tokenizable", "category", "title", "ticker_candidates", "name_candidates", "keywords",
                 "sentiment", "expected_life_hours", "is_breaking_news", "is_exchange_listing"],
    "additionalProperties": False,
}

CLASSIFY_SYSTEM = """You classify social posts and headlines for a memecoin trader.
Decide whether the post describes something likely to be turned into a memecoin within minutes/hours
(a viral moment, a phrase, an animal, a celebrity or politician moment, breaking news, an official token launch).
Give the most likely ticker candidates (UPPERCASE, 2-10 chars, no $) and token name candidates people would use,
3-8 lowercase keywords that identify the story, a category, sentiment from -1 to 1, the expected lifespan of the
narrative in hours (typical memecoin narratives last 24-72h), and flag breaking news or an exchange listing.
Be conservative: ordinary market commentary is not tokenizable."""


LABEL_SCHEMA = {
    "type": "object",
    "properties": {"coins": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "mint": {"type": "string"},
            "narrative": {"type": "string"},
            "category": {"type": "string", "enum": ["politifi", "ai", "animal", "celebrity", "news", "culture", "brainrot", "gaming",
                                                     "crypto", "community", "other"]},
            "meme_score": {"type": "integer"},
            "derivative": {"type": "boolean"},
            "red_flags": {"type": "array", "items": {"type": "string"}},
            "take": {"type": "string"},
        },
        "required": ["mint", "narrative", "category", "meme_score", "derivative", "red_flags", "take"],
        "additionalProperties": False}}},
    "required": ["coins"],
    "additionalProperties": False,
}

LABEL_SYSTEM = """You rate brand-new pump.fun memecoin launches for a risk-tolerant memecoin trader, from the name, ticker,
description and links only. One JSON line per coin. For each coin return:
- narrative: 2-5 words naming the meme / story it rides (e.g. "Elon dog tweet", "AI agent", "viral cat video")
- category
- meme_score 0-10: how strong and spreadable the meme is (catchy, funny, timely, ties to a live story or community) —
  most launches are 1-4; reserve 8-10 for genuinely strong, timely memes
- derivative: true if it is a low-effort copy of an existing / trending coin or a generic template
- red_flags: short phrases only for concrete problems (impersonates a real company or person's official token, promises
  returns, "presale", gibberish, offensive, scam wording); empty list if none
- take: one line, max 90 characters, what a trader should know
Judge the meme, not the price. Never invent facts about the coin."""


class AI:
    def __init__(self, db: DB) -> None:
        self.db = db
        self.key: str | None = None
        self.client: anthropic.AsyncAnthropic | None = None
        self.daily_budget = float(os.environ.get("AI_DAILY_BUDGET_USD", "1"))
        self.day = int(time.time() // 86400)
        self.today = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "by_path": {}}

    def set_key(self, key: str | None, workspace_id: str | None = None) -> None:
        self.key = key or None
        # an org-level key that isn't scoped to a workspace must send the workspace on every request
        headers = {"anthropic-workspace-id": workspace_id.strip()} if workspace_id and workspace_id.strip() else None
        self.client = anthropic.AsyncAnthropic(api_key=key, default_headers=headers) if key else None

    @property
    def enabled(self) -> bool:
        return self.client is not None

    async def spent_today(self) -> float:
        start = time.time() - (time.time() % 86400)
        row = await self.db.one("SELECT COALESCE(SUM(cost_usd),0) c FROM api_usage WHERE adapter='anthropic' AND ts>=?", (start,))
        return float(row["c"])

    async def _meter(self, model: str, usage: Any, ms: float, path: str) -> None:
        pin, pout = PRICES.get(model, (2.0, 10.0))
        inp = (usage.input_tokens or 0) + (getattr(usage, "cache_creation_input_tokens", 0) or 0) * 1.25 \
            + (getattr(usage, "cache_read_input_tokens", 0) or 0) * 0.1
        cost = (inp * pin + (usage.output_tokens or 0) * pout) / 1e6
        d = int(time.time() // 86400)
        if d != self.day:
            self.day, self.today = d, {"calls": 0, "input_tokens": 0, "output_tokens": 0, "by_path": {}}
        self.today["calls"] += 1
        self.today["input_tokens"] += int(inp)
        self.today["output_tokens"] += int(usage.output_tokens or 0)
        self.today["by_path"][path] = self.today["by_path"].get(path, 0) + 1
        await self.db.exec("INSERT INTO api_usage (ts, adapter, path, status, latency_ms, cost_usd) VALUES (?,?,?,?,?,?)",
                           (time.time(), "anthropic", path, 200, ms, cost))

    async def _create(self, path: str, **kw: Any) -> Any:
        if not self.client:
            raise RuntimeError("Anthropic key not connected")
        if await self.spent_today() >= self.daily_budget:
            raise RuntimeError(f"AI daily budget ${self.daily_budget:.2f} reached")
        t0 = time.perf_counter()
        try:
            resp = await self.client.messages.create(**kw)
        except anthropic.RateLimitError as e:
            health.fail(f"429 {e}", rate_limited=True)
            raise
        except anthropic.APIStatusError as e:
            health.fail(f"HTTP {e.status_code}: {e.message}"[:200])
            raise
        except anthropic.APIConnectionError as e:
            health.fail(f"connection: {e}")
            raise
        ms = (time.perf_counter() - t0) * 1000
        health.ok(ms)
        await self._meter(kw["model"], resp.usage, ms, path)
        if resp.stop_reason == "refusal":
            raise RuntimeError("model declined")
        return resp

    @staticmethod
    def _text(resp: Any) -> str:
        return "".join(b.text for b in resp.content if b.type == "text")

    def _economy(self, model: str) -> dict[str, Any]:
        """Thinking off for extraction on Haiku (allowed at low effort): no hidden reasoning tokens billed."""
        return {"thinking": {"type": "disabled"}} if model.startswith("claude-haiku") else {}

    async def json(self, path: str, system: str, user: str, schema: dict[str, Any], max_tokens: int = 1500) -> dict[str, Any]:
        """One structured extraction on the cheapest model: Haiku, low effort, no thinking, schema-constrained output."""
        resp = await self._create(path, model=FAST_MODEL, max_tokens=max_tokens,
                                  system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                                  output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
                                  messages=[{"role": "user", "content": user}], **self._economy(FAST_MODEL))
        if resp.stop_reason == "max_tokens":
            raise RuntimeError("output cut off")
        return json.loads(self._text(resp))

    async def classify(self, text: str, source: str, author: str | None) -> dict[str, Any]:
        return await self.json("classify", CLASSIFY_SYSTEM, f"Source: {source}\nAuthor: {author or 'unknown'}\nPost:\n{text[:1500]}",
                               CLASSIFY_SCHEMA, max_tokens=600)

    async def label_launches(self, coins: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Up to ~25 brand-new launches in ONE request (≈ $0.001): narrative, meme potential, copycat & red flags."""
        lines = [json.dumps({"mint": c["mint"], "name": (c.get("name") or "")[:40], "symbol": (c.get("symbol") or "")[:14],
                             "description": (c.get("description") or "")[:220], "x": c.get("twitter_kind"),
                             "socials": c.get("socials", 0), "hot_metas": c.get("metas", [])[:2]}, ensure_ascii=False) for c in coins]
        out = await self.json("label", LABEL_SYSTEM, "\n".join(lines), LABEL_SCHEMA, max_tokens=170 * len(coins) + 200)
        return out.get("coins") or []

    def snapshot(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "fast_model": FAST_MODEL, "smart_model": SMART_MODEL, "budget_usd": self.daily_budget,
                **self.today}

    async def write(self, system: str, prompt: str, path: str, max_tokens: int = 2000, effort: str = "low") -> str:
        resp = await self._create(path, model=SMART_MODEL, max_tokens=max_tokens,
                                  system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                                  output_config={"effort": effort},
                                  messages=[{"role": "user", "content": prompt}])
        return self._text(resp).strip()

    async def ask(self, question: str, history: list[dict[str, Any]], tools: list[dict[str, Any]],
                  run_tool: Callable[[str, dict[str, Any]], Awaitable[Any]], system: str) -> str:
        """Manual tool-use loop over the app's own data."""
        messages = [*history, {"role": "user", "content": question}]
        for _ in range(8):
            resp = await self._create("ask", model=SMART_MODEL, max_tokens=4000, tools=tools,
                                      system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                                      output_config={"effort": "low"}, messages=messages)
            messages.append({"role": "assistant", "content": resp.content})
            if resp.stop_reason != "tool_use":
                return self._text(resp).strip()
            results = []
            for b in resp.content:
                if b.type == "tool_use":
                    try:
                        out = await run_tool(b.name, dict(b.input))
                        results.append({"type": "tool_result", "tool_use_id": b.id,
                                        "content": json.dumps(out, default=str)[:30000]})
                    except Exception as e:  # noqa: BLE001 - report tool failures back to the model
                        results.append({"type": "tool_result", "tool_use_id": b.id, "content": str(e), "is_error": True})
            messages.append({"role": "user", "content": results})
        return "Stopped after 8 tool rounds."
