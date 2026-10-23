"""Reconnecting WebSocket client base."""
from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any

import websockets

from ..health import Health

log = logging.getLogger("radar.stream")


class Stream:
    def __init__(self, url: str, health: Health):
        self.url = url
        self.health = health
        self.ws: Any = None
        self._stop = False

    async def on_open(self) -> None: ...
    async def on_message(self, msg: Any) -> None: ...

    async def send(self, obj: dict[str, Any]) -> None:
        if self.ws is not None:
            await self.ws.send(json.dumps(obj))

    async def run(self) -> None:
        backoff = 1.0
        while not self._stop:
            try:
                async with websockets.connect(self.url, ping_interval=20, ping_timeout=20,
                                              open_timeout=15, max_size=2**22) as ws:
                    self.ws = ws
                    self.health.connected = True
                    self.health.ok()
                    backoff = 1.0
                    await self.on_open()
                    async for raw in ws:
                        self.health.messages += 1
                        self.health.last_ok = __import__("time").time()
                        try:
                            msg = json.loads(raw)
                        except ValueError:
                            continue
                        try:
                            await self.on_message(msg)
                        except Exception:  # noqa: BLE001 - one bad message must not kill the stream
                            log.exception("%s: handler error", self.health.name)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                self.health.fail(f"{type(e).__name__}: {e}")
            finally:
                self.ws = None
                self.health.connected = False
            if self._stop:
                break
            await asyncio.sleep(backoff + random.random())
            backoff = min(backoff * 2, 60)

    def stop(self) -> None:
        self._stop = True
