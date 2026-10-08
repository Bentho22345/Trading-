"""Claude: Haiku for high-volume post classification, Sonnet for write-ups, brief and Ask Radar.

Spend is metered into api_usage (cost_usd) and capped by AI_DAILY_BUDGET_USD.
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
SMART_MODEL = os.environ.get("RADAR_SMART_MODEL", "claude-sonnet-5-5")
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


class AI:
    def __init__(self, db: DB) -> None:
        self.db = db
        self.key: str | None = None
        self.client: anthropic.AsyncAnthropic | None = None
        self.daily_budget = float(os.environ.get("AI_DAILY_BUDGET_USD", "3"))

    def set_key(self, key: str | None) -> None:
        self.key = key or None
        self.client = anthropic.AsyncAnthropic(api_key=key) if key else None

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

    async def classify(self, text: str, source: str, author: str | None) -> dict[str, Any]:
        resp = await self._create(
            "classify", model=FAST_MODEL, max_tokens=1024,
            system=[{"type": "text", "text": CLASSIFY_SYSTEM, "cache_control": {"type": "ephemeral"}}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": CLASSIFY_SCHEMA}},
            messages=[{"role": "user", "content": f"Source: {source}\nAuthor: {author or 'unknown'}\nPost:\n{text[:2000]}"}],
        )
        return json.loads(self._text(resp))

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
                                      output_config={"effort": "medium"}, messages=messages)
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
