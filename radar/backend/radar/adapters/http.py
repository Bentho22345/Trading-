"""Shared REST plumbing: rate limit, retry with backoff, health accounting, usage log."""
from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Any

import httpx

from ..health import Health
from ..ratelimit import TokenBucket

log = logging.getLogger("radar.http")

USER_AGENT = "MemecoinRadar/0.1 (personal research terminal)"


class UpstreamError(Exception):
    pass


class RestClient:
    def __init__(self, base_url: str, health: Health, timeout: float = 10.0, headers: dict[str, str] | None = None):
        self.base_url = base_url.rstrip("/")
        self.health = health
        self.client = httpx.AsyncClient(
            timeout=timeout,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})},
        )
        self.on_request = None  # optional hook(name, path, status, latency_ms) for ApiUsage

    async def close(self) -> None:
        await self.client.aclose()

    async def get(self, path: str, bucket: TokenBucket, params: dict[str, Any] | None = None,
                  retries: int = 3, not_found_ok: bool = False) -> Any:
        url = f"{self.base_url}{path}"
        delay = 1.0
        for attempt in range(retries + 1):
            await bucket.acquire()
            t0 = time.perf_counter()
            try:
                r = await self.client.get(url, params=params)
            except httpx.HTTPError as e:
                self.health.fail(f"{type(e).__name__}: {e}")
                if attempt == retries:
                    raise UpstreamError(str(e)) from e
                await asyncio.sleep(delay + random.random() * 0.3)
                delay *= 2
                continue
            ms = (time.perf_counter() - t0) * 1000
            if self.on_request:
                self.on_request(self.health.name, path, r.status_code, ms)
            if r.status_code == 429:
                retry_after = float(r.headers.get("retry-after", 0) or 0) or delay * 5
                bucket.penalize(retry_after)
                self.health.fail("429 rate limited", rate_limited=True)
                log.warning("%s rate limited; backing off %.1fs", self.health.name, retry_after)
                if attempt == retries:
                    raise UpstreamError("rate limited")
                continue
            if r.status_code == 404 and not_found_ok:
                self.health.ok(ms)
                return None
            if r.status_code >= 500 or r.status_code >= 400:
                self.health.fail(f"HTTP {r.status_code}: {r.text[:120]}")
                if r.status_code < 500 or attempt == retries:
                    raise UpstreamError(f"HTTP {r.status_code}")
                await asyncio.sleep(delay + random.random() * 0.3)
                delay *= 2
                continue
            self.health.ok(ms)
            return r.json()
        raise UpstreamError("exhausted retries")
