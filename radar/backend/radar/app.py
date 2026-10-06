"""FastAPI app: REST + live WebSocket + static UI on one port."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .adapters.http import UpstreamError
from .config import settings
from .connectors import BY_ID, ConnectorStore
from .custom import CustomSources
from .db import DB
from .health import REGISTRY
from .hub import hub
from .tracker import TOKEN_SUMMARY_SQL, Tracker

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format='{"t":"%(asctime)s","lvl":"%(levelname)s","log":"%(name)s","msg":"%(message)s"}')
log = logging.getLogger("radar")

SORTS = {"vol_m5", "vol_h1", "vol_h24", "liquidity_usd", "market_cap", "chg_m5", "chg_h1", "chg_h24",
         "first_seen", "launched_at", "holders", "buys_h1", "as_of"}
DISCLAIMER = "Signals are probabilistic. Most memecoins go to zero. Only risk money you can lose."


class State:
    db: DB
    tracker: Tracker
    connectors: ConnectorStore
    custom: CustomSources


S = State()
STARTED = time.time()


@asynccontextmanager
async def lifespan(app: FastAPI):
    S.db = DB(settings.db_path)
    await S.db.open()
    S.tracker = Tracker(S.db)
    S.connectors = ConnectorStore(S.db)
    S.custom = CustomSources(S.db)

    async def on_change(cid: str, vals: dict[str, str]) -> None:
        if cid == "coingecko":
            S.tracker.market.set_coingecko_key(vals.get("api_key"))
    S.connectors.listeners.append(on_change)
    await on_change("coingecko", await S.connectors.values("coingecko"))

    if os.environ.get("RADAR_DISABLE_INGEST") != "1":
        S.tracker.start()
        await S.custom.start_all()
    log.info("Memecoin Radar up")
    yield
    await S.tracker.stop()
    for t in S.custom.tasks.values():
        t.cancel()
    await S.db.close()


app = FastAPI(title="Memecoin Radar", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins), allow_methods=["*"], allow_headers=["*"])


# ---------------- health ----------------
@app.get("/api/health")
async def health() -> dict[str, Any]:
    since = time.time() - 3600
    usage = {r["adapter"]: r for r in await S.db.all(
        "SELECT adapter, COUNT(*) n, SUM(status>=400) errors, AVG(latency_ms) avg_ms FROM api_usage WHERE ts>? GROUP BY adapter", (since,))}
    adapters = []
    for h in REGISTRY.values():
        snap = h.snapshot()
        snap["requests_1h"] = (usage.get(h.name) or {}).get("n")
        adapters.append(snap)
    counts = {t: (await S.db.one(f"SELECT COUNT(*) n FROM {t}"))["n"]
              for t in ("tokens", "pairs", "price_ticks", "pump_trades", "safety_reports", "news")}
    return {"now": time.time(), "uptime_s": time.time() - STARTED, "adapters": adapters, "db": counts,
            "ui_clients": len(hub.clients), "trade_subscriptions": len(S.tracker.pump.token_subs),
            "sol_usd": S.tracker.sol_usd}


# ---------------- dashboard data ----------------
@app.get("/api/tokens")
async def tokens(sort: str = "vol_h1", limit: int = 150, min_liq: float = 0) -> list[dict[str, Any]]:
    col = sort if sort in SORTS else "vol_h1"
    prefix = "s." if col == "holders" else ("t." if col in ("first_seen", "launched_at") else "p.")
    return await S.db.all(TOKEN_SUMMARY_SQL + f" WHERE t.best_pair IS NOT NULL AND COALESCE(p.liquidity_usd,0) >= ? "
                          f"ORDER BY {prefix}{col} DESC NULLS LAST LIMIT ?", (min_liq, min(limit, 500)))


@app.get("/api/launches")
async def launches(limit: int = 60) -> list[dict[str, Any]]:
    return await S.db.all(TOKEN_SUMMARY_SQL + " WHERE t.source='pumpportal' AND t.launched_at IS NOT NULL "
                          "ORDER BY t.first_seen DESC LIMIT ?", (min(limit, 300),))


@app.get("/api/graduated")
async def graduated(limit: int = 40) -> list[dict[str, Any]]:
    return await S.db.all(TOKEN_SUMMARY_SQL + " WHERE t.graduated_at IS NOT NULL ORDER BY t.graduated_at DESC LIMIT ?",
                          (min(limit, 200),))


@app.get("/api/trending")
async def trending() -> dict[str, Any]:
    rows = await S.db.all("SELECT source, list, rank, data_json, as_of FROM trending ORDER BY source, list, rank")
    out: dict[str, Any] = {}
    for r in rows:
        key = f"{r['source']}:{r['list']}"
        out.setdefault(key, {"source": r["source"], "list": r["list"], "as_of": r["as_of"], "rows": []})
        out[key]["rows"].append(json.loads(r["data_json"]))
    return out


@app.get("/api/market")
async def market() -> dict[str, Any]:
    return {r["key"]: {**json.loads(r["data_json"] or "{}"), "value": r["value"], "as_of": r["as_of"], "source": r["source"]}
            for r in await S.db.all("SELECT * FROM market")}


@app.get("/api/news")
async def news(limit: int = 80) -> list[dict[str, Any]]:
    from .detect import detect
    rows = await S.db.all("SELECT * FROM news ORDER BY COALESCE(published, fetched) DESC LIMIT ?", (min(limit, 300),))
    return [{**r, "detected": detect(r["title"])} for r in rows]


# ---------------- token detail ----------------
@app.get("/api/token/{address}")
async def token(address: str) -> dict[str, Any]:
    summary = await S.tracker.token_summary(address)
    if not summary:
        # unknown token: pull it in on demand (counts against the same budget)
        try:
            await S.tracker._ensure_token(address, "solana", None, None, None, "lookup")
            await S.tracker.refresh("solana", [address])
        except UpstreamError as e:
            raise HTTPException(502, f"DexScreener unavailable: {e}") from e
        summary = await S.tracker.token_summary(address)
    S.tracker.queue_rug(address)
    t = await S.db.one("SELECT links_json, uri, graduated_pool FROM tokens WHERE address=?", (address,)) or {}
    safety = await S.db.one("SELECT * FROM safety_reports WHERE token_address=?", (address,))
    if safety:
        safety["risks"] = json.loads(safety.pop("risks_json") or "[]")
        safety["top_holders"] = json.loads(safety.pop("top_holders_json") or "[]")
    return {
        "token": summary,
        "links": json.loads(t.get("links_json") or "null"),
        "pairs": await S.db.all("SELECT * FROM pairs WHERE token_address=? ORDER BY liquidity_usd DESC NULLS LAST LIMIT 10", (address,)),
        "safety": safety,
        "trades": await S.db.all("SELECT * FROM pump_trades WHERE mint=? ORDER BY ts DESC LIMIT 100", (address,)),
        "ticks": await S.db.all("SELECT ts, price_usd, market_cap, liquidity_usd, vol_h1 FROM price_ticks "
                                "WHERE token_address=? ORDER BY ts DESC LIMIT 500", (address,)),
        "watched": bool(await S.db.one("SELECT 1 FROM watchlist WHERE address=?", (address,))),
        "sol_usd": S.tracker.sol_usd,
        "disclaimer": DISCLAIMER,
    }


_ohlcv_cache: dict[tuple[str, str], tuple[float, list]] = {}


@app.get("/api/token/{address}/ohlcv")
async def ohlcv(address: str, tf: str = "5m") -> dict[str, Any]:
    tok = await S.db.one("SELECT best_pair, chain FROM tokens WHERE address=?", (address,))
    if not tok or not tok["best_pair"]:
        return {"candles": [], "pool": None, "as_of": None, "source": None}
    key = (tok["best_pair"], tf)
    hit = _ohlcv_cache.get(key)
    if hit and time.time() - hit[0] < 20:
        return {"candles": hit[1], "pool": key[0], "as_of": hit[0], "source": "geckoterminal"}
    try:
        candles = await S.tracker.gecko.ohlcv(tok["best_pair"], tf, network=tok["chain"] or "solana")
    except UpstreamError as e:
        if hit:
            return {"candles": hit[1], "pool": key[0], "as_of": hit[0], "source": "geckoterminal", "stale": True}
        raise HTTPException(502, f"GeckoTerminal unavailable: {e}") from e
    _ohlcv_cache[key] = (time.time(), candles)
    return {"candles": candles, "pool": key[0], "as_of": time.time(), "source": "geckoterminal"}


@app.post("/api/token/{address}/safety")
async def refresh_safety(address: str) -> dict[str, str]:
    await S.db.exec("UPDATE safety_reports SET as_of=0 WHERE token_address=?", (address,))
    S.tracker.queue_rug(address)
    return {"status": "queued"}


# ---------------- watchlist ----------------
@app.get("/api/watchlist")
async def watchlist() -> list[dict[str, Any]]:
    return await S.db.all(TOKEN_SUMMARY_SQL + " JOIN watchlist w ON w.address=t.address ORDER BY w.added DESC")


@app.post("/api/watchlist/{address}")
async def watch(address: str) -> dict[str, bool]:
    await S.tracker._ensure_token(address, "solana", None, None, None, "watchlist")
    await S.db.exec("INSERT OR IGNORE INTO watchlist (address, added) VALUES (?,?)", (address, time.time()))
    return {"watched": True}


@app.delete("/api/watchlist/{address}")
async def unwatch(address: str) -> dict[str, bool]:
    await S.db.exec("DELETE FROM watchlist WHERE address=?", (address,))
    return {"watched": False}


# ---------------- connectors ----------------
@app.get("/api/connectors")
async def connectors() -> dict[str, Any]:
    return {"connectors": await S.connectors.list(), "custom": await S.custom.list()}


class SaveBody(BaseModel):
    values: dict[str, str]


@app.post("/api/connectors/{cid}")
async def save_connector(cid: str, body: SaveBody) -> dict[str, Any]:
    if cid not in BY_ID:
        raise HTTPException(404, "unknown connector")
    try:
        await S.connectors.save(cid, body.values)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return await S.connectors.test(cid) if BY_ID[cid].test else {"status": "saved", "message": "Saved"}


@app.post("/api/connectors/{cid}/test")
async def test_connector(cid: str) -> dict[str, Any]:
    if cid not in BY_ID:
        raise HTTPException(404, "unknown connector")
    try:
        return await S.connectors.test(cid)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.delete("/api/connectors/{cid}")
async def delete_connector(cid: str) -> dict[str, str]:
    await S.connectors.remove(cid)
    return {"status": "removed"}


class SourceBody(BaseModel):
    url: str
    name: str | None = None
    kind: str | None = "auto"
    headers: dict[str, str] | None = None
    items_path: str | None = None
    interval_s: float = 60
    subscribe: str | None = None


@app.post("/api/sources")
async def add_source(body: SourceBody) -> dict[str, Any]:
    if not body.url.startswith(("http://", "https://", "ws://", "wss://")):
        raise HTTPException(400, "URL must start with http(s):// or ws(s)://")
    try:
        return await S.custom.add(body.name or "", body.url, body.kind, body.headers, body.items_path,
                                  body.interval_s, body.subscribe)
    except Exception as e:  # noqa: BLE001 - surface discovery/validation errors to the form
        raise HTTPException(400, f"{e}") from e


@app.delete("/api/sources/{sid}")
async def delete_source(sid: int) -> dict[str, str]:
    await S.custom.remove(sid)
    return {"status": "removed"}


@app.get("/api/sources/items")
async def source_items(source_id: int | None = None, limit: int = 100) -> list[dict[str, Any]]:
    if source_id:
        return await S.db.all("SELECT i.id, i.ts, i.title, i.link, s.name source FROM custom_items i JOIN custom_sources s "
                              "ON s.id=i.source_id WHERE i.source_id=? ORDER BY i.ts DESC LIMIT ?", (source_id, limit))
    return await S.db.all("SELECT i.id, i.ts, i.title, i.link, s.name source FROM custom_items i JOIN custom_sources s "
                          "ON s.id=i.source_id ORDER BY i.ts DESC LIMIT ?", (limit,))


# ---------------- live socket ----------------
@app.websocket("/ws")
async def ws(socket: WebSocket) -> None:
    await hub.connect(socket)
    try:
        while True:
            msg = json.loads(await socket.receive_text())
            if isinstance(msg.get("view"), list):
                hub.viewing[socket] = {str(a) for a in msg["view"][:20]}
                for a in hub.viewing[socket]:
                    S.tracker.queue_rug(a)
            elif msg.get("ping"):
                await socket.send_text(json.dumps({"ch": "pong", "ts": time.time()}))
    except (WebSocketDisconnect, ValueError, RuntimeError):
        pass
    finally:
        hub.disconnect(socket)


# ---------------- static UI ----------------
if settings.web_dir.exists():
    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def spa(path: str):
        if path.startswith(("api/", "ws")):
            raise HTTPException(404)
        base = settings.web_dir.resolve()
        for cand in (base / path, base / f"{path}.html", base / path / "index.html"):
            if cand.is_file() and base in cand.resolve().parents:
                return FileResponse(cand)
        return FileResponse(base / "index.html")
