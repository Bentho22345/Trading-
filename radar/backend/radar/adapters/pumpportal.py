"""PumpPortal real-time pump.fun data. Docs: https://pumpportal.fun/data-api/real-time

ONE connection; subscriptions are added to it. Never opens a second socket.
"""
from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from ..config import settings
from ..health import Health, register
from .stream import Stream

log = logging.getLogger("radar.pumpportal")
health = register(Health("pumpportal", "stream", "pump.fun launches, trades, migrations (WebSocket)"))
health.stale_after = 60

Handler = Callable[[dict[str, Any]], Awaitable[None]]


def classify(msg: dict[str, Any]) -> str:
    tx = msg.get("txType")
    if tx == "create":
        return "create"
    if tx in ("buy", "sell"):
        return "trade"
    if tx == "migrate" or (msg.get("pool") and "mint" in msg and "txType" not in msg and "signature" in msg):
        return "migrate"
    if "message" in msg or "errors" in msg:
        return "control"
    return "unknown"


class PumpPortal(Stream):
    def __init__(self, on_create: Handler, on_trade: Handler, on_migrate: Handler):
        super().__init__(settings.pumpportal_ws, health)
        self.on_create, self.on_trade, self.on_migrate = on_create, on_trade, on_migrate
        self.token_subs: set[str] = set()
        self.account_subs: set[str] = set()

    async def on_open(self) -> None:
        await self.send({"method": "subscribeNewToken"})
        await self.send({"method": "subscribeMigration"})
        if self.token_subs:
            await self.send({"method": "subscribeTokenTrade", "keys": sorted(self.token_subs)})
        if self.account_subs:
            await self.send({"method": "subscribeAccountTrade", "keys": sorted(self.account_subs)})

    async def on_message(self, msg: Any) -> None:
        if not isinstance(msg, dict):
            return
        kind = classify(msg)
        if kind == "create":
            await self.on_create(msg)
        elif kind == "trade":
            await self.on_trade(msg)
        elif kind == "migrate":
            await self.on_migrate(msg)
        elif kind == "control" and msg.get("errors"):
            log.warning("pumpportal: %s", msg)

    async def set_account_trades(self, wallets: set[str]) -> None:
        add, drop = wallets - self.account_subs, self.account_subs - wallets
        self.account_subs = set(wallets)
        if self.ws is None:
            return
        if drop:
            await self.send({"method": "unsubscribeAccountTrade", "keys": sorted(drop)})
        if add:
            await self.send({"method": "subscribeAccountTrade", "keys": sorted(add)})

    async def set_token_trades(self, mints: Any) -> None:
        """Diff-update trade subscriptions, capped by config."""
        mints = set(list(dict.fromkeys(mints))[: settings.max_trade_subscriptions])  # keep caller's priority order
        add, drop = mints - self.token_subs, self.token_subs - mints
        self.token_subs = mints
        if self.ws is None:
            return
        if drop:
            await self.send({"method": "unsubscribeTokenTrade", "keys": sorted(drop)})
        if add:
            await self.send({"method": "subscribeTokenTrade", "keys": sorted(add)})
