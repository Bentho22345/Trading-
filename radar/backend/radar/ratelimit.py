"""Async token bucket. One per upstream endpoint family."""
from __future__ import annotations

import asyncio
import time


class TokenBucket:
    def __init__(self, per_minute: float, burst: float | None = None) -> None:
        self.rate = per_minute / 60.0
        self.capacity = burst if burst is not None else max(1.0, per_minute / 10.0)
        self.tokens = self.capacity
        self.updated = time.monotonic()
        self._lock = asyncio.Lock()
        self.paused_until = 0.0  # set when upstream answers 429

    def _refill(self) -> None:
        now = time.monotonic()
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
        self.updated = now

    def headroom(self) -> float:
        """Fraction of burst capacity currently available (0..1)."""
        self._refill()
        if time.monotonic() < self.paused_until:
            return 0.0
        return self.tokens / self.capacity

    def penalize(self, seconds: float) -> None:
        self.paused_until = max(self.paused_until, time.monotonic() + seconds)
        self.tokens = 0.0

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                if now < self.paused_until:
                    await asyncio.sleep(self.paused_until - now)
                    continue
                self._refill()
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                await asyncio.sleep((1 - self.tokens) / self.rate)
