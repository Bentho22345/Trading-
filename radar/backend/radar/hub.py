"""Fan-out of live events to every connected UI WebSocket."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("radar.hub")


class Hub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.viewing: dict[WebSocket, set[str]] = {}

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.add(ws)
        self.viewing[ws] = set()

    def disconnect(self, ws: WebSocket) -> None:
        self.clients.discard(ws)
        self.viewing.pop(ws, None)

    def viewed_tokens(self) -> set[str]:
        out: set[str] = set()
        for s in self.viewing.values():
            out |= s
        return out

    async def publish(self, channel: str, data: Any) -> None:
        if not self.clients:
            return
        msg = json.dumps({"ch": channel, "ts": time.time(), "data": data}, default=str)
        dead = []
        for ws in list(self.clients):
            try:
                await asyncio.wait_for(ws.send_text(msg), timeout=2)
            except Exception:  # noqa: BLE001 - a slow or closed client must not stall the feed
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


hub = Hub()
