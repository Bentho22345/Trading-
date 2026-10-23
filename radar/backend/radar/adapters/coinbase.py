"""Coinbase Exchange public ticker WebSocket (no key) for BTC/ETH/SOL regime prices."""
from __future__ import annotations

import time
from typing import Any, Awaitable, Callable

from ..config import settings
from ..health import Health, register
from .stream import Stream

health = register(Health("coinbase", "stream", "Live BTC/ETH/SOL prices (market regime)"))
health.stale_after = 60
PRODUCTS = ["BTC-USD", "ETH-USD", "SOL-USD"]


class Coinbase(Stream):
    def __init__(self, on_tick: Callable[[dict[str, Any]], Awaitable[None]]):
        super().__init__(settings.coinbase_ws, health)
        self.on_tick = on_tick
        self.last: dict[str, dict[str, Any]] = {}

    async def on_open(self) -> None:
        await self.send({"type": "subscribe", "product_ids": PRODUCTS, "channels": ["ticker"]})

    async def on_message(self, msg: Any) -> None:
        if not isinstance(msg, dict) or msg.get("type") != "ticker":
            return
        pid = msg.get("product_id")
        try:
            price = float(msg["price"])
            open24 = float(msg.get("open_24h") or 0)
        except (KeyError, TypeError, ValueError):
            return
        tick = {
            "symbol": pid.split("-")[0], "price": price,
            "chg_24h": round((price / open24 - 1) * 100, 2) if open24 else None,
            "as_of": time.time(), "source": "coinbase",
        }
        self.last[pid] = tick
        await self.on_tick(tick)
