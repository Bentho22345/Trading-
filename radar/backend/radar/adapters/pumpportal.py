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
        self.base_url = settings.pumpportal_ws
        self.has_key = False
        self.trades_seen: list[float] = []               # recent trade arrivals (is the trade feed actually flowing?)
        self.trades_day = (0, 0)                          # (utc day, trades) — PumpPortal bills 0.01 SOL per 10,000 streamed

    def set_key(self, key: str | None) -> None:
        """Since May 2026 trade / account streams need a PumpPortal API key (new launches stay free). The key rides on
        the URL; changing it reconnects."""
        key = (key or "").strip()
        sep = "&" if "?" in self.base_url else "?"
        url = f"{self.base_url}{sep}api-key={key}" if key else self.base_url
        self.has_key = bool(key)
        if url != self.url:
            self.url = url
            if self.ws is not None:
                __import__("asyncio").get_running_loop().create_task(self.ws.close())

    def trade_rate(self, window: float = 90) -> int:
        cut = __import__("time").time() - window
        self.trades_seen = [t for t in self.trades_seen[-5000:] if t >= cut]
        return len(self.trades_seen)

    def est_cost_sol_today(self) -> float:
        return round(self.trades_day[1] / 10_000 * 0.01, 4)

    async def on_open(self) -> None:
        await self.send({"method": "subscribeNewToken"})
        await self.send({"method": "subscribeMigration"})
        if self.token_subs:
            await self.send({"method": "subscribeTokenTrade", "keys": sorted(self.token_subs)})
        await self._chunked("subscribeAccountTrade", self.account_subs)

    async def on_message(self, msg: Any) -> None:
        if not isinstance(msg, dict):
            return
        kind = classify(msg)
        if kind == "create":
            await self.on_create(msg)
        elif kind == "trade":
            now = __import__("time").time()
            self.trades_seen.append(now)
            day = int(now // 86400)
            self.trades_day = (day, (self.trades_day[1] if self.trades_day[0] == day else 0) + 1)
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
        await self._chunked("unsubscribeAccountTrade", drop)
        await self._chunked("subscribeAccountTrade", add)

    async def _chunked(self, method: str, keys: set[str], size: int = 100) -> None:
        """Up to ~1,200 followed wallets: send them in batches rather than one huge frame."""
        ks = sorted(keys)
        for i in range(0, len(ks), size):
            await self.send({"method": method, "keys": ks[i:i + size]})

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
