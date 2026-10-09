"""pump.fun coin metadata (the JSON at each launch's `uri`): description, image and the X / Telegram / website links
traders filter on. Fetched once per launch from the IPFS gateway the creator used, with a small worker pool so a slow
gateway never delays the stream. Also the last line of Mayhem Mode detection: any `mayhem` key in the metadata."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Awaitable, Callable

import httpx

from .adapters.http import USER_AGENT
from .health import Health, register

log = logging.getLogger("radar.metadata")
health = register(Health("coin_metadata", "rest", "pump.fun coin metadata (IPFS): socials, description, image"))
health.stale_after = 600
CID = re.compile(r"/ipfs/([A-Za-z0-9]+)")
GATEWAYS = ["https://ipfs.io/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://dweb.link/ipfs/"]


def _url(v: Any) -> str | None:
    v = str(v or "").strip()
    if not v:
        return None
    return v if v.startswith("http") else f"https://{v}" if "." in v and " " not in v else None


def parse(md: dict[str, Any]) -> dict[str, Any]:
    ext = md.get("extensions") if isinstance(md.get("extensions"), dict) else {}
    out = {"description": (md.get("description") or "").strip()[:600] or None, "image": md.get("image") or None,
           "twitter": _url(md.get("twitter") or ext.get("twitter")), "telegram": _url(md.get("telegram") or ext.get("telegram")),
           "website": _url(md.get("website") or ext.get("website"))}
    out["is_mayhem"] = any("mayhem" in str(k).lower() and v not in (None, False, 0, "", "false", "0") for k, v in md.items())
    return out


class MetadataFetcher:
    def __init__(self, on_done: Callable[[str, dict[str, Any]], Awaitable[None]], workers: int = 6) -> None:
        self.on_done = on_done
        self.q: asyncio.Queue[tuple[str, str]] = asyncio.Queue(maxsize=2000)
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(4.0, connect=2.5), headers={"User-Agent": USER_AGENT},
                                        follow_redirects=True)
        self.workers = workers

    def submit(self, mint: str, uri: str) -> None:
        try:
            self.q.put_nowait((mint, uri))
        except asyncio.QueueFull:
            pass   # under a launch storm, skip rather than fall behind

    async def _get(self, uri: str) -> dict[str, Any] | None:
        urls = [uri]
        m = CID.search(uri)
        if m:
            urls += [g + m.group(1) for g in GATEWAYS if not uri.startswith(g)]
        for u in urls[:3]:
            try:
                r = await self.client.get(u)
                if r.status_code == 200:
                    return r.json()
            except (httpx.HTTPError, json.JSONDecodeError, ValueError):
                continue
        return None

    async def worker(self) -> None:
        while True:
            mint, uri = await self.q.get()
            try:
                md = await self._get(uri)
                if md is None:
                    health.fail("metadata unavailable")
                    continue
                health.ok(0)
                await self.on_done(mint, parse(md))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.debug("metadata %s: %s", mint, e)

    async def run(self) -> None:
        await asyncio.gather(*(self.worker() for _ in range(self.workers)))
