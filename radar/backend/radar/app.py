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
from starlette.middleware.gzip import GZipMiddleware
from fastapi import Request, Response
from fastapi.responses import FileResponse, JSONResponse
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

SORTS = {"radar_score", "vol_m5", "vol_h1", "vol_h24", "liquidity_usd", "market_cap", "chg_m5", "chg_h1", "chg_h24",
         "first_seen", "launched_at", "holders", "buys_h1", "as_of"}
DISCLAIMER = "Signals are probabilistic. Most memecoins go to zero. Only risk money you can lose."


class State:
    db: DB
    tracker: Tracker
    connectors: ConnectorStore
    custom: CustomSources
    cfg: Any
    ai: Any
    alerts: Any
    social: Any
    smart: Any
    paper: Any
    signals: Any
    insights: Any
    telegram: Any
    discover: Any
    story: Any
    traders: Any
    metas: Any
    news: Any
    charts: Any
    sniper: Any
    playbook: Any
    metadata: Any


S = State()
STARTED = time.time()


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .ai import AI
    from .alerts import Alerts
    from .cfg import Config
    from .insights import Insights
    from .paper import Paper
    from .signals import SignalEngine
    from .smartmoney import SmartMoney
    from .social import sources as soc
    from .social.engine import SocialEngine

    S.db = DB(settings.db_path)
    await S.db.open()
    S.cfg = Config(S.db)
    await S.cfg.load()
    S.tracker = Tracker(S.db)
    S.connectors = ConnectorStore(S.db)
    S.custom = CustomSources(S.db)
    S.ai = AI(S.db)
    S.alerts = Alerts(S.db, S.connectors, S.cfg)
    S.social = SocialEngine(S.db, S.cfg, S.ai, S.alerts, S.tracker)
    S.smart = SmartMoney(S.db, S.cfg, S.tracker, S.alerts, S.connectors)
    S.paper = Paper(S.db, S.cfg)
    S.signals = SignalEngine(S.db, S.cfg, S.tracker, S.social, S.smart, S.paper, S.alerts, S.ai)
    S.insights = Insights(S.db, S.cfg, S.ai, S.alerts, S.social, S.paper, S.tracker)
    from .discover import Discover
    from .story import StoryEngine
    S.discover = Discover(S.db, S.tracker, S.social, S.signals, S.alerts)
    S.story = StoryEngine(S.db, S.ai, S.social, S.connectors, S.discover, S.cfg)
    S.tracker.hooks["new_token"].append(S.discover.check_launch)
    from .traders import Traders
    S.traders = Traders(S.db, S.tracker, S.connectors, S.alerts, S.cfg)
    S.smart.traders = S.traders
    S.traders.smart = S.smart        # top ranks drive Smart Money's top-trade flashes, pushes and cluster alerts
    S.tracker.hooks["trade"].append(S.traders.on_pump_trade)
    from .metas import MetaBoard
    from .newsintel import NewsIntel
    S.metas = MetaBoard(S.db, S.alerts)
    S.news = NewsIntel(S.metas, S.alerts, S.db)
    await S.news.load()
    S.tracker.news_enricher = S.news.enrich
    S.tracker.hooks["news"].append(S.news.on_fresh)
    from .charts import Charts
    from .sniper import Sniper
    S.charts = Charts(S.db, S.tracker)
    S.sniper = Sniper(S.db, S.tracker, S.alerts)
    S.sniper.traders, S.sniper.smart, S.sniper.metas = S.traders, S.smart, S.metas
    S.tracker.hooks["launch"].append(S.sniper.on_launch)
    S.tracker.hooks["trade"].insert(0, S.sniper.on_trade)        # first: the snipe board is the latency-critical consumer
    S.tracker.hooks["graduated"].append(S.sniper.on_graduated)
    S.tracker.hooks["trending_first"].append(S.sniper.on_trending_first)
    S.tracker.hooks["tokens"].append(S.sniper.on_tokens)
    await S.sniper.warm()
    from .metadata import MetadataFetcher
    from .playbook import Playbook

    async def on_metadata(mint: str, md: dict[str, Any]) -> None:
        if md.get("is_mayhem"):
            S.tracker.mayhem.add(mint)
            await S.db.exec("UPDATE tokens SET is_mayhem=1 WHERE address=?", (mint,))
        links = {k: md[k] for k in ("twitter", "telegram", "website") if md.get(k)}
        await S.db.exec("UPDATE tokens SET image=COALESCE(image, ?), links_json=COALESCE(links_json, ?) WHERE address=?",
                        (md.get("image"), json.dumps({"websites": [md["website"]] if md.get("website") else [],
                                                      "socials": [{"type": k, "url": v} for k, v in links.items() if k != "website"]})
                         if links else None, mint))
        await S.sniper.on_metadata(mint, md)
    S.metadata = MetadataFetcher(on_metadata)
    S.sniper.meta_fetch = S.metadata.submit
    S.playbook = Playbook(S.db, S.ai, S.connectors, S.sniper, S.alerts)
    S.sniper.on_hit = S.playbook.on_hit
    await S.playbook.load()

    async def load_pool() -> None:
        S.sniper.pool = {r["address"] for r in await S.db.all("SELECT address FROM traders")}
    await load_pool()

    async def on_change(cid: str, vals: dict[str, str]) -> None:
        if cid == "coingecko":
            S.tracker.market.set_coingecko_key(vals.get("api_key"))
        elif cid == "anthropic":
            S.ai.set_key(vals.get("api_key"), vals.get("workspace_id"))
        elif cid == "helius":
            S.tracker.extra.set_helius(vals.get("api_key"))
    S.connectors.listeners.append(on_change)
    for cid in ("coingecko", "anthropic", "helius"):
        await on_change(cid, await S.connectors.values(cid))

    S.tracker.hooks["social"].append(S.social.ingest)
    S.tracker.hooks["trade"] += [S.smart.on_trade, S.signals.rug_shield_trade, S.signals.on_trade]
    S.tracker.hooks["tokens"] += [S.signals.rug_shield_tokens, watch_rules, S.signals.on_tokens]
    S.tracker.hooks["safety"].append(S.signals.rug_shield_safety)
    S.custom.on_item = S.social.ingest
    vals = S.connectors.values
    S.telegram = soc.TelegramSource(S.social.ingest, lambda: vals("telegram_user"), S.cfg)
    bg: list[asyncio.Task] = []
    if os.environ.get("RADAR_DISABLE_INGEST") != "1":
        S.tracker.start()
        await S.custom.start_all()
        S.social.start()
        await S.smart.load()
        jobs = [S.sniper.eval_loop(), loop_lag_monitor(), S.metadata.run(), S.playbook.loop(), periodic(300, load_pool), S.sniper.outcome_loop(), S.sniper.flush_peaks_loop(), S.sniper.context_loop(), S.traders.compute_loop(), S.traders.harvest_gecko_loop(), S.traders.harvest_birdeye_loop(), S.traders.backfill_loop(),
                S.story.loop(), S.metas.loop(), periodic(60, S.news.refresh_symbols), S.signals.loop(), S.signals.rug_refresh_loop(),
                S.insights.brief_scheduler(), S.smart.helius_loop(),
                soc.XSource(S.social.ingest, S.cfg, lambda: vals("x"), S.db).run(),
                soc.RedditAPI(S.social.ingest, lambda: vals("reddit")).run(),
                soc.NeynarSource(S.social.ingest, lambda: vals("neynar")).run(),
                soc.YouTubeSource(S.social.ingest, lambda: vals("youtube")).run(),
                S.telegram.run(), periodic(600, S.smart.discover), periodic(60, S.signals.check_daily_loss)]
        if os.environ.get("RADAR_DISABLE_FIREHOSE") != "1":
            jobs += [soc.BlueskySource(S.social.ingest).run(), soc.FourChanBiz(S.social.ingest).run()]
        bg = [asyncio.create_task(j) for j in jobs]
    log.info("Memecoin Radar up")
    yield
    await S.tracker.stop()
    for t in [*bg, *S.social.tasks]:
        t.cancel()
    for t in S.custom.tasks.values():
        t.cancel()
    await S.db.close()


LAG = {"ms": 0.0, "max_ms": 0.0}


async def loop_lag_monitor() -> None:
    """How late the event loop wakes up: the single best 'is the server overloaded?' number (shown on /api/healthz)."""
    while True:
        t = time.perf_counter()
        await asyncio.sleep(0.5)
        lag = max(0.0, (time.perf_counter() - t - 0.5) * 1000)
        LAG["ms"] = round(lag * 0.3 + LAG["ms"] * 0.7, 1)
        LAG["max_ms"] = round(max(LAG["max_ms"] * 0.98, lag), 1)


async def periodic(seconds: float, fn) -> None:
    while True:
        await asyncio.sleep(seconds)
        try:
            await fn()
        except Exception as e:  # noqa: BLE001
            log.warning("periodic %s: %s", getattr(fn, "__name__", fn), e)


async def watch_rules(rows: list[dict[str, Any]]) -> None:
    """Per-token custom alert rules on the watchlist."""
    rules = {r["address"]: json.loads(r["rules_json"]) for r in await S.db.all(
        "SELECT address, rules_json FROM watchlist WHERE rules_json IS NOT NULL")}
    for t in rows:
        r = rules.get(t["address"])
        if not r:
            continue
        px, sym = t.get("price_usd"), t.get("symbol")
        checks = [("price_above", px, lambda v, x: v >= x, "price ≥"), ("price_below", px, lambda v, x: v <= x, "price ≤"),
                  ("chg_h1_above", t.get("chg_h1"), lambda v, x: v >= x, "1h change ≥"),
                  ("chg_h1_below", t.get("chg_h1"), lambda v, x: v <= x, "1h change ≤"),
                  ("liq_below", t.get("liquidity_usd"), lambda v, x: v <= x, "liquidity ≤"),
                  ("vol_h1_above", t.get("vol_h1"), lambda v, x: v >= x, "1h volume ≥")]
        for key, val, fn, label in checks:
            if r.get(key) not in (None, "") and val is not None and fn(val, float(r[key])):
                await S.alerts.send("info", f"🔔 {sym}: {label} {r[key]}", f"now {val}", token=t["address"],
                                    dedupe=f"rule:{t['address']}:{key}", ttl=3600)


try:
    from fastapi.responses import ORJSONResponse as _JSON   # faster serialization for every API response
    import orjson  # noqa: F401
except ImportError:  # pragma: no cover
    _JSON = JSONResponse
app = FastAPI(title="Memecoin Radar", lifespan=lifespan, default_response_class=_JSON)
app.add_middleware(GZipMiddleware, minimum_size=800, compresslevel=5)   # JSON shrinks 5-10× on the wire
app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins), allow_methods=["*"], allow_headers=["*"],
                   allow_credentials=True)


@app.middleware("http")
async def auth_gate(request: Request, call_next):
    from . import auth
    if auth.needs_auth(request) and not auth.is_authed(dict(request.cookies)):
        return JSONResponse({"detail": "login required"}, status_code=401)
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    return resp


class LoginBody(BaseModel):
    password: str


@app.post("/api/login")
async def login(body: LoginBody, request: Request, response: Response) -> dict[str, Any]:
    from . import auth
    if not auth.password():
        return {"ok": True, "auth": False}
    ip = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "?")).split(",")[0].strip()
    if not auth.check_password(body.password, ip):
        raise HTTPException(401, "Wrong password (or too many attempts — wait a minute)")
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(auth.COOKIE, auth.session_token(), max_age=30 * 86400, httponly=True, secure=secure, samesite="lax")
    return {"ok": True, "auth": True}


@app.post("/api/logout")
async def logout(response: Response) -> dict[str, bool]:
    from . import auth
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


@app.get("/api/session")
async def session(request: Request) -> dict[str, bool]:
    from . import auth
    return {"auth_required": bool(auth.password()), "authed": auth.is_authed(dict(request.cookies))}


@app.get("/api/healthz")
async def healthz() -> dict[str, Any]:
    """Unauthenticated liveness probe for Render / Docker. Exposes only load / pipeline counters (no coins, keys or data),
    so a slow or empty deployment can be diagnosed from one URL."""
    out: dict[str, Any] = {"ok": True, "uptime_s": round(time.time() - STARTED), "loop_lag_ms": LAG["ms"], "loop_lag_max_ms": LAG["max_ms"]}
    try:
        import resource
        out["rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
    except Exception:  # noqa: BLE001
        pass
    sn = getattr(S, "sniper", None)
    if sn is not None:
        st = sn.stats
        out["snipe"] = {"tracking": len(sn.launches), "seen": sn.seen_launches, "backlog": st["backlog"], "evals": st["evals"],
                        "avg_eval_ms": round(st["eval_ms"] / st["evals"], 2) if st["evals"] else None, "last_tick_ms": st["last_tick_ms"]}
    tr = getattr(S, "tracker", None)
    if tr is not None:
        out["pumpportal"] = {"connected": tr.pump.ws is not None, "trade_subs": len(tr.pump.token_subs),
                             "account_subs": len(tr.pump.account_subs)}
        out["sol_usd_known"] = tr.sol_usd is not None
    out["ws_clients"] = len(hub.clients)
    hs = REGISTRY.values() if isinstance(REGISTRY, dict) else REGISTRY
    out["sources"] = {st: sorted(h.name for h in hs if h.status() == st) for st in ("ok", "degraded", "stale", "down", "pending")}
    return out


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
async def tokens(sort: str = "vol_h1", limit: int = 200, min_liq: float = 0, q: str = "", chain: str = "",
                 min_mcap: float = 0, max_mcap: float = 0, min_vol_h1: float = 0, max_age_min: float = 0,
                 min_age_min: float = 0, safe_only: bool = False, graduated_only: bool = False, hide_boosted: bool = False,
                 verdict: str = "", max_stale_s: float = 0) -> list[dict[str, Any]]:
    col = sort if sort in SORTS else "vol_h1"
    prefix = "s." if col == "holders" else ("t." if col in ("first_seen", "launched_at") else "p.")
    where, args = ["t.best_pair IS NOT NULL", "COALESCE(p.liquidity_usd,0) >= ?", "COALESCE(t.is_mayhem,0)=0"], [min_liq]
    now = time.time()
    if q:
        where.append("(t.symbol LIKE ? OR t.name LIKE ? OR t.address = ?)")
        args += [f"%{q.lstrip('$')}%", f"%{q}%", q]
    if chain:
        where.append("t.chain = ?")
        args.append(chain)
    if min_mcap:
        where.append("COALESCE(p.market_cap, p.fdv, 0) >= ?")
        args.append(min_mcap)
    if max_mcap:
        where.append("COALESCE(p.market_cap, p.fdv, 0) <= ?")
        args.append(max_mcap)
    if min_vol_h1:
        where.append("COALESCE(p.vol_h1,0) >= ?")
        args.append(min_vol_h1)
    age = "COALESCE(t.launched_at, p.pair_created_at, t.first_seen)"
    if max_age_min:
        where.append(f"{age} >= ?")
        args.append(now - max_age_min * 60)
    if min_age_min:
        where.append(f"{age} <= ?")
        args.append(now - min_age_min * 60)
    if safe_only:
        where.append("s.as_of IS NOT NULL AND COALESCE(s.mint_authority,'')='' AND COALESCE(s.freeze_authority,'')='' AND COALESCE(s.rugged,0)=0")
    if graduated_only:
        where.append("t.graduated_at IS NOT NULL")
    if hide_boosted:
        where.append("COALESCE(t.boost_amount,0) = 0")
    if max_stale_s:
        where.append("p.as_of >= ?")
        args.append(now - max_stale_s)
    sql = TOKEN_SUMMARY_SQL.replace("FROM tokens t", ", (SELECT verdict FROM signals sg WHERE sg.token_address=t.address ORDER BY sg.ts DESC LIMIT 1) AS verdict, "
                                    "(SELECT score FROM signals sg WHERE sg.token_address=t.address ORDER BY sg.ts DESC LIMIT 1) AS radar_score FROM tokens t")
    if verdict:
        sql = f"SELECT * FROM ({sql} WHERE {' AND '.join(where)}) WHERE verdict = ? ORDER BY {col if col not in ('holders',) else 'holders'} DESC NULLS LAST LIMIT ?"
        return await S.db.all(sql, [*args, verdict.upper(), min(limit, 1000)])
    return await S.db.all(sql + f" WHERE {' AND '.join(where)} ORDER BY {prefix}{col} DESC NULLS LAST LIMIT ?", [*args, min(limit, 1000)])


@app.get("/api/launches")
async def launches(limit: int = 60) -> list[dict[str, Any]]:
    return await S.db.all(TOKEN_SUMMARY_SQL + " WHERE t.source='pumpportal' AND t.launched_at IS NOT NULL AND COALESCE(t.is_mayhem,0)=0 "
                          "ORDER BY t.first_seen DESC LIMIT ?", (min(limit, 300),))


@app.get("/api/graduated")
async def graduated(limit: int = 40) -> list[dict[str, Any]]:
    return await S.db.all(TOKEN_SUMMARY_SQL + " WHERE t.graduated_at IS NOT NULL AND COALESCE(t.is_mayhem,0)=0 ORDER BY t.graduated_at DESC LIMIT ?",
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
        "rules": json.loads((await S.db.one("SELECT rules_json FROM watchlist WHERE address=?", (address,)) or {}).get("rules_json") or "null"),
        "signals": await S.db.all("SELECT id, ts, verdict, score, confidence, risk_grade, subscores_json, vetoes_json, reasons_json, plan_json, "
                                  "writeup, category FROM signals WHERE token_address=? ORDER BY ts DESC LIMIT 20", (address,)),
        "narrative": await S.social.narrative_for_token(address),
        "social": await token_social(address, (summary or {}).get("symbol")),
        "smart_trades": await S.db.all("SELECT wt.*, w.label, w.kind, w.score FROM wallet_trades wt JOIN wallets w ON w.address=wt.wallet "
                                       "WHERE wt.mint=? ORDER BY wt.ts DESC LIMIT 200", (address,)),
        "flash": await S.db.all("SELECT * FROM flash_events WHERE token_address=? ORDER BY id DESC LIMIT 5", (address,)),
        "sol_usd": S.tracker.sol_usd,
        "disclaimer": DISCLAIMER,
    }


async def token_social(address: str, symbol: str | None) -> list[dict[str, Any]]:
    """Social timeline for the chart overlay: posts with the CA, the $ticker, or in the linked narrative."""
    args: list[Any] = [f"%{address}%"]
    cond = "cas_json LIKE ?"
    if symbol and len(symbol) >= 3:
        cond += " OR cashtags_json LIKE ?"
        args.append(f'%"{symbol.upper()}"%')
    cond += " OR narrative_id IN (SELECT narrative_id FROM narrative_tokens WHERE token_address=? AND match_score >= 0.7)"
    args.append(address)
    return await S.db.all(f"SELECT id, source, author_id, author_tier, text, url, ts, engagement FROM social_events WHERE ({cond}) "
                          "AND ts > ? ORDER BY ts DESC LIMIT 200", [*args, time.time() - 3 * 86400])


@app.get("/api/token/{address}/ohlcv")
async def ohlcv(address: str, tf: str = "5m") -> dict[str, Any]:
    try:
        return await S.charts.ohlcv(address, tf)
    except UpstreamError as e:
        raise HTTPException(502, f"GeckoTerminal unavailable: {e}") from e


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


class WatchBody(BaseModel):
    rules: dict[str, Any] | None = None
    note: str | None = None


@app.put("/api/watchlist/{address}")
async def watch_rules_set(address: str, body: WatchBody) -> dict[str, Any]:
    await S.tracker._ensure_token(address, "solana", None, None, None, "watchlist")
    await S.db.exec("INSERT INTO watchlist (address, added, note, rules_json) VALUES (?,?,?,?) ON CONFLICT(address) DO UPDATE SET "
                    "rules_json=excluded.rules_json, note=COALESCE(excluded.note, note)",
                    (address, time.time(), body.note, json.dumps(body.rules) if body.rules else None))
    return {"watched": True, "rules": body.rules}


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


from .api2 import router as _router2  # noqa: E402
from .api_news import router as _router_news  # noqa: E402

app.include_router(_router2)
app.include_router(_router_news)


# ---------------- live socket ----------------
@app.websocket("/ws")
async def ws(socket: WebSocket) -> None:
    from . import auth
    if not auth.is_authed(dict(socket.cookies)):
        await socket.close(code=4401)
        return
    await hub.connect(socket)
    try:
        while True:
            msg = json.loads(await socket.receive_text())
            if isinstance(msg.get("view"), list):
                hub.viewing[socket] = {str(a) for a in msg["view"][:20]}
                for a in hub.viewing[socket]:
                    S.tracker.queue_rug(a)
                S.tracker.subs_kick.set()
            elif msg.get("ping"):
                await socket.send_text(json.dumps({"ch": "pong", "ts": time.time()}))
    except (WebSocketDisconnect, ValueError, RuntimeError):
        pass
    finally:
        hub.disconnect(socket)


# ---------------- static UI ----------------
if settings.web_dir.exists():
    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def spa(path: str, request: Request):
        if path.startswith(("api/", "ws")):
            raise HTTPException(404)
        base = settings.web_dir.resolve()
        for cand in (base / path, base / f"{path}.html", base / path / "index.html"):
            if cand.is_file() and base in cand.resolve().parents:
                return _static(cand, path, request)
        return _static(base / "index.html", "index.html", request)


_GZ: dict[str, tuple[float, bytes, bytes]] = {}
_TYPES = {".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8", ".json": "application/json",
          ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon"}


def _static(f, path: str, request: Request) -> Response:
    """Static UI with long-lived caching for content-hashed assets and in-memory pre-compressed text files."""
    import gzip
    suffix = f.suffix.lower()
    immutable = path.startswith("_next/static/") or "/media/" in path
    headers = {"Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache"}
    if suffix not in (".js", ".css", ".html", ".json", ".svg", ".txt"):
        return FileResponse(f, headers=headers)
    mtime = f.stat().st_mtime
    hit = _GZ.get(str(f))
    if not hit or hit[0] != mtime:
        raw = f.read_bytes()
        hit = _GZ[str(f)] = (mtime, raw, gzip.compress(raw, 7))
    headers["Vary"] = "Accept-Encoding"
    if "gzip" in request.headers.get("accept-encoding", ""):
        headers["Content-Encoding"] = "gzip"
        return Response(hit[2], media_type=_TYPES.get(suffix), headers=headers)
    return Response(hit[1], media_type=_TYPES.get(suffix), headers=headers)
