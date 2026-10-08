"""Alert fan-out: UI (+ browser notification), Telegram bot, ntfy phone push, Discord webhook."""
from __future__ import annotations

import asyncio
import json
import os
import logging
import time
from typing import Any

import httpx

from .db import DB
from .hub import hub

log = logging.getLogger("radar.alerts")
PRIORITY = {"flash": "urgent", "rug": "urgent", "buy": "high", "exit": "high", "info": "default"}


class Alerts:
    def __init__(self, db: DB, connectors: Any, cfg: Any) -> None:
        self.db, self.connectors, self.cfg = db, connectors, cfg
        self.client = httpx.AsyncClient(timeout=6)
        self.recent: dict[str, float] = {}

    async def cooldown_until(self) -> float:
        return float(await self.cfg.kv_get("risk:cooldown_until", 0) or 0)

    async def send(self, kind: str, title: str, body: str = "", token: str | None = None,
                   dedupe: str | None = None, ttl: float = 900, extra: dict[str, Any] | None = None) -> dict[str, Any] | None:
        now = time.time()
        a_cfg = self.cfg.scoring.get("alerts", {})
        if kind == "buy" and not a_cfg.get("buy_signal", True):
            return None
        if kind == "buy" and a_cfg.get("cooldown_mutes_buy", True) and await self.cooldown_until() > now:
            return None
        key = dedupe or f"{kind}:{token}:{title}"
        if self.recent.get(key, 0) > now - ttl:
            return None
        self.recent[key] = now
        if len(self.recent) > 5000:
            self.recent = {k: v for k, v in self.recent.items() if v > now - 3600}
        row = {"ts": now, "kind": kind, "severity": PRIORITY.get(kind, "default"), "title": title, "body": body,
               "token_address": token, "dedupe": key}
        aid = await self.db.exec("INSERT INTO alerts (ts, kind, severity, title, body, token_address, dedupe) "
                                 "VALUES (?,?,?,?,?,?,?)", list(row.values()))
        msg = {"id": aid, **row, **(extra or {})}
        await hub.publish("alert", msg)
        delivered = {"ui": time.time()}
        text = f"{title}\n{body}".strip()
        if token:
            text += f"\nCA: {token}\nhttps://dexscreener.com/solana/{token}\nhttps://axiom.trade/t/{token}"
        results = await asyncio.gather(self._telegram(text), self._ntfy(title, body, token, kind), self._discord(text),
                                       return_exceptions=True)
        for name, r in zip(("telegram", "ntfy", "discord"), results):
            if r is True:
                delivered[name] = time.time()
            elif isinstance(r, Exception):
                delivered[name + "_error"] = str(r)[:200]
        await self.db.exec("UPDATE alerts SET delivered_json=? WHERE id=?", (json.dumps(delivered), aid))
        msg["delivered"] = delivered
        return msg

    async def _telegram(self, text: str) -> bool | None:
        v = await self.connectors.values("telegram_bot")
        if not v.get("bot_token") or not v.get("chat_id"):
            return None
        r = await self.client.post(f"{os.environ.get('TELEGRAM_API_URL', 'https://api.telegram.org')}/bot{v['bot_token']}/sendMessage",
                                   json={"chat_id": v["chat_id"], "text": text[:4000], "disable_web_page_preview": True})
        r.raise_for_status()
        return True

    async def _ntfy(self, title: str, body: str, token: str | None, kind: str) -> bool | None:
        v = await self.connectors.values("ntfy")
        if not v.get("topic"):
            return None
        server = (v.get("server") or "https://ntfy.sh").rstrip("/")
        headers = {"Title": title.encode("ascii", "ignore").decode()[:200] or "Radar",
                   "Priority": PRIORITY.get(kind, "default"), "Tags": kind}
        if token:
            headers["Click"] = f"https://dexscreener.com/solana/{token}"
        r = await self.client.post(f"{server}/{v['topic']}", content=(body or title).encode(), headers=headers)
        r.raise_for_status()
        return True

    async def _discord(self, text: str) -> bool | None:
        v = await self.connectors.values("discord")
        if not v.get("webhook_url"):
            return None
        r = await self.client.post(v["webhook_url"], json={"content": text[:1900]})
        r.raise_for_status()
        return True
