"""Fan-out of live events to every connected UI WebSocket."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("radar.hub")

try:   # orjson serializes several times faster than json — this runs for every live event
    import orjson

    def dumps(o: Any) -> str:
        return orjson.dumps(o, default=str, option=orjson.OPT_NON_STR_KEYS).decode()
except ImportError:  # pragma: no cover
    def dumps(o: Any) -> str:
        return json.dumps(o, default=str, separators=(",", ":"))


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
        msg = dumps({"ch": channel, "ts": time.time(), "data": data})
        clients = list(self.clients)

        async def send(ws: WebSocket) -> WebSocket | None:
            try:
                await asyncio.wait_for(ws.send_text(msg), timeout=2)
                return None
            except Exception:  # noqa: BLE001 - a slow or closed client must not stall the feed
                return ws

        # every client in parallel: one slow phone can't delay everyone else's tick
        dead = [await send(clients[0])] if len(clients) == 1 else await asyncio.gather(*(send(ws) for ws in clients))
        for ws in dead:
            if ws is not None:
                self.disconnect(ws)


hub = Hub()
