"""Per-adapter health: status, latency, errors, rate-limit headroom. Shown on /health."""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class Health:
    name: str
    kind: str  # "rest" | "stream"
    description: str = ""
    requests: int = 0
    errors: int = 0
    rate_limited: int = 0
    last_ok: float | None = None
    last_error: float | None = None
    last_error_msg: str | None = None
    connected: bool | None = None  # streams only
    messages: int = 0              # streams only
    latencies: deque = field(default_factory=lambda: deque(maxlen=200))
    headroom_fn: Callable[[], float] | None = None
    stale_after: float = 120.0

    def ok(self, latency_ms: float | None = None) -> None:
        self.requests += 1
        self.last_ok = time.time()
        if latency_ms is not None:
            self.latencies.append(latency_ms)

    def fail(self, msg: str, rate_limited: bool = False) -> None:
        self.requests += 1
        self.errors += 1
        self.last_error = time.time()
        self.last_error_msg = msg[:300]
        if rate_limited:
            self.rate_limited += 1

    def status(self) -> str:
        now = time.time()
        if self.kind == "stream":
            if not self.connected:
                return "down"
            if self.last_ok and now - self.last_ok > self.stale_after:
                return "stale"
            return "ok"
        if self.last_ok is None:
            return "down" if self.last_error else "pending"
        if self.last_error and self.last_error > self.last_ok:
            return "degraded"
        if now - self.last_ok > self.stale_after:
            return "stale"
        return "ok"

    def snapshot(self) -> dict[str, Any]:
        lat = sorted(self.latencies)
        p = lambda q: round(lat[min(len(lat) - 1, int(q * len(lat)))], 1) if lat else None  # noqa: E731
        return {
            "name": self.name,
            "kind": self.kind,
            "description": self.description,
            "status": self.status(),
            "requests": self.requests,
            "errors": self.errors,
            "rate_limited": self.rate_limited,
            "last_ok": self.last_ok,
            "last_error": self.last_error,
            "last_error_msg": self.last_error_msg,
            "connected": self.connected,
            "messages": self.messages,
            "latency_p50_ms": p(0.5),
            "latency_p95_ms": p(0.95),
            "headroom": round(self.headroom_fn(), 2) if self.headroom_fn else None,
        }


REGISTRY: dict[str, Health] = {}


def register(h: Health) -> Health:
    REGISTRY[h.name] = h
    return h
