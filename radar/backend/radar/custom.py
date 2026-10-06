"""User-added sources: any RSS/Atom feed, JSON API or WebSocket link, polled within its own budget."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import Any

import websockets

from . import secrets
from .adapters import feeds
from .db import DB
from .detect import detect
from .hub import hub

log = logging.getLogger("radar.custom")
TITLE_KEYS = ("title", "headline", "name", "text", "question", "description", "symbol", "message")
LINK_KEYS = ("url", "link", "href", "permalink")


def find_items(data: Any, path: str | None) -> list[Any]:
    if path:
        for part in path.split("."):
            data = data[int(part)] if isinstance(data, list) else (data or {}).get(part)
        return data if isinstance(data, list) else [data]
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list) and v:
                return v
        return [data]
    return []


def to_item(source_id: int, obj: Any) -> dict[str, Any]:
    title, link = None, None
    if isinstance(obj, dict):
        title = next((str(obj[k]) for k in TITLE_KEYS if obj.get(k)), None)
        link = next((str(obj[k]) for k in LINK_KEYS if isinstance(obj.get(k), str)), None)
    raw = json.dumps(obj, default=str, sort_keys=True)[:4000]
    return {"id": hashlib.sha1(f"{source_id}|{raw}".encode()).hexdigest()[:24], "source_id": source_id,
            "ts": time.time(), "title": (title or raw[:200])[:400], "link": link, "payload_json": raw}


class CustomSources:
    def __init__(self, db: DB) -> None:
        self.db = db
        self.tasks: dict[int, asyncio.Task] = {}

    async def add(self, name: str, url: str, kind: str | None, headers: dict[str, str] | None,
                  items_path: str | None, interval_s: float, subscribe: str | None) -> dict[str, Any]:
        if not kind or kind == "auto":
            kind, url = await feeds.discover(url)
        if kind not in ("rss", "json", "websocket"):
            raise ValueError("kind must be rss, json or websocket")
        interval_s = max(15.0, float(interval_s or 60))
        sid = await self.db.exec(
            "INSERT INTO custom_sources (name, kind, url, headers_enc, items_path, interval_s, created) VALUES (?,?,?,?,?,?,?)",
            (name or url, kind, url, secrets.encrypt({"headers": headers or {}, "subscribe": subscribe or ""}),
             items_path or None, interval_s, time.time()))
        self.start(sid)
        return await self.get(sid)

    async def get(self, sid: int) -> dict[str, Any]:
        r = await self.db.one("SELECT id,name,kind,url,items_path,interval_s,enabled,status,last_ok,last_msg,items,created "
                              "FROM custom_sources WHERE id=?", (sid,))
        if not r:
            raise KeyError(sid)
        return r

    async def list(self) -> list[dict[str, Any]]:
        return await self.db.all("SELECT id,name,kind,url,items_path,interval_s,enabled,status,last_ok,last_msg,items,created "
                                 "FROM custom_sources ORDER BY id")

    async def remove(self, sid: int) -> None:
        t = self.tasks.pop(sid, None)
        if t:
            t.cancel()
        await self.db.exec("DELETE FROM custom_sources WHERE id=?", (sid,))
        await self.db.exec("DELETE FROM custom_items WHERE source_id=?", (sid,))

    async def start_all(self) -> None:
        for r in await self.db.all("SELECT id FROM custom_sources WHERE enabled=1"):
            self.start(r["id"])

    def start(self, sid: int) -> None:
        if sid not in self.tasks:
            self.tasks[sid] = asyncio.create_task(self._run(sid))

    async def _status(self, sid: int, ok: bool, msg: str, n: int = 0) -> None:
        if ok:
            await self.db.exec("UPDATE custom_sources SET status='ok', last_ok=?, last_msg=?, items=items+? WHERE id=?",
                               (time.time(), msg, n, sid))
        else:
            await self.db.exec("UPDATE custom_sources SET status='error', last_msg=? WHERE id=?", (msg[:300], sid))

    async def _store(self, sid: int, name: str, items: list[dict[str, Any]]) -> int:
        new = 0
        for it in items:
            exists = await self.db.one("SELECT 1 FROM custom_items WHERE id=?", (it["id"],))
            if exists:
                continue
            await self.db.upsert("custom_items", it, "id")
            new += 1
            hits = detect(it["title"] or "")
            await hub.publish("custom", {**{k: it[k] for k in ("id", "ts", "title", "link")}, "source": name, "detected": hits})
        return new

    async def _run(self, sid: int) -> None:
        while True:
            try:
                src = await self.db.one("SELECT * FROM custom_sources WHERE id=?", (sid,))
                if not src or not src["enabled"]:
                    return
                cfg = secrets.decrypt(src["headers_enc"])
                if src["kind"] == "websocket":
                    await self._ws(src, cfg)
                else:
                    if src["kind"] == "rss":
                        rows = await feeds.fetch(src["url"], src["name"], cfg.get("headers"))
                        items = [{"id": r["id"], "source_id": sid, "ts": r["published"] or r["fetched"],
                                  "title": r["title"], "link": r["link"], "payload_json": None} for r in rows]
                    else:
                        r = await feeds.client().get(src["url"], headers=cfg.get("headers") or {})
                        r.raise_for_status()
                        items = [to_item(sid, o) for o in find_items(r.json(), src["items_path"])[:100]]
                    n = await self._store(sid, src["name"], items)
                    await self._status(sid, True, f"{len(items)} items, {n} new", n)
                    await asyncio.sleep(src["interval_s"])
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                await self._status(sid, False, f"{type(e).__name__}: {e}")
                await asyncio.sleep(60)

    async def _ws(self, src: dict[str, Any], cfg: dict[str, Any]) -> None:
        sid = src["id"]
        async with websockets.connect(src["url"], additional_headers=cfg.get("headers") or None, open_timeout=15) as ws:
            if cfg.get("subscribe"):
                await ws.send(cfg["subscribe"])
            await self._status(sid, True, "connected")
            async for raw in ws:
                try:
                    obj = json.loads(raw)
                except ValueError:
                    obj = {"text": str(raw)[:2000]}
                n = await self._store(sid, src["name"], [to_item(sid, o) for o in find_items(obj, src["items_path"])])
                if n:
                    await self._status(sid, True, "streaming", n)
        raise ConnectionError("stream closed")
