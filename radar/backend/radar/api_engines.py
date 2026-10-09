"""Engines: one status / budget surface for everything your keys power (Helius, Claude, YouTube, Dune, Telegram),
the intel feed, YouTube buzz, saved Dune queries and on-demand on-chain scans."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import feed
from .app import S
from .ytbuzz import quota

router = APIRouter(prefix="/api")


async def load_budgets() -> None:
    b = await S.cfg.kv_get("engines:budgets") or {}
    if b.get("ai_daily_usd"):
        S.ai.daily_budget = float(b["ai_daily_usd"])
    if b.get("youtube_daily_units"):
        quota.cap = int(b["youtube_daily_units"])


async def engines_status() -> dict[str, Any]:
    conn = {cid: await S.connectors.configured(cid) for cid in ("helius", "youtube", "anthropic", "dune", "telegram_bot")}
    srcs = await S.db.one("SELECT COUNT(*) n, SUM(status='digested') d, SUM(rules_json NOT IN ('[]','')) r FROM playbook_sources") or {}
    wi = await S.db.one("SELECT COUNT(*) n, SUM(fresh) fresh, SUM(bot) bots FROM wallet_intel") or {}
    return {
        "helius": {**S.helius.snapshot(), "configured": conn["helius"], "intel": S.onchain.stats, "queue": len(S.onchain.pending),
                   "wallets_known": wi.get("n") or 0, "fresh_known": wi.get("fresh") or 0, "bots_known": wi.get("bots") or 0,
                   "backfill_calls_today": S.traders.helius_calls_today},
        "claude": {**S.ai.snapshot(), "configured": conn["anthropic"], "spent_usd": round(await S.ai.spent_today(), 4),
                   "labeled": S.narrator.stats["labeled"], "narrator": S.narrator.stats},
        "youtube": {"configured": conn["youtube"], "quota": quota.snapshot(), "buzz": S.ytbuzz.snapshot(),
                    "playbook": {"sources": srcs.get("n") or 0, "digested": srcs.get("d") or 0, "with_filters": srcs.get("r") or 0,
                                 "channels_followed": S.playbook.channels_followed}},
        "dune": {"configured": conn["dune"], "queries": await S.traders.dune_queries()},
        "telegram": {"configured": conn["telegram_bot"], **S.tgbot.snapshot()},
        "snipe": {"tracking": len(S.sniper.launches), "calls_24h": len(S.sniper.calls),
                  "with_intel": sum(1 for L in S.sniper.launches.values() if L.intel),
                  "with_ai": sum(1 for L in S.sniper.launches.values() if L.ai),
                  "with_yt": sum(1 for L in S.sniper.launches.values() if L.yt)},
        "counts": dict(feed.COUNTS), "as_of": time.time(),
    }


@router.get("/engines")
async def engines() -> dict[str, Any]:
    return await engines_status()


class BudgetBody(BaseModel):
    helius_daily_credits: int | None = None
    ai_daily_usd: float | None = None
    youtube_daily_units: int | None = None


@router.post("/engines/budget")
async def set_budget(b: BudgetBody) -> dict[str, Any]:
    cur = await S.cfg.kv_get("engines:budgets") or {}
    if b.helius_daily_credits is not None:
        await S.helius.set_daily(b.helius_daily_credits)
    if b.ai_daily_usd is not None:
        if not 0 <= b.ai_daily_usd <= 100:
            raise HTTPException(400, "AI budget must be between $0 and $100 a day")
        S.ai.daily_budget = cur["ai_daily_usd"] = float(b.ai_daily_usd)
    if b.youtube_daily_units is not None:
        quota.cap = cur["youtube_daily_units"] = max(0, min(10_000, int(b.youtube_daily_units)))
    await S.cfg.kv_set("engines:budgets", cur)
    return await engines_status()


@router.get("/intel")
async def intel(engine: str = "", limit: int = 100) -> list[dict[str, Any]]:
    return feed.recent(min(limit, 300), engine or None)


@router.get("/youtube/buzz")
async def youtube_buzz(hours: float = 48, limit: int = 60) -> dict[str, Any]:
    import json
    rows = await S.db.all("SELECT * FROM yt_videos WHERE published > ? ORDER BY published DESC LIMIT ?",
                          (time.time() - hours * 3600, min(limit, 300)))
    live = {(L.symbol or "").upper(): m for m, L in S.sniper.launches.items() if L.symbol}
    out = []
    for r in rows:
        tags, cas = json.loads(r.pop("tickers_json") or "[]"), json.loads(r.pop("cas_json") or "[]")
        out.append({**r, "tickers": tags, "contracts": cas, "url": f"https://www.youtube.com/watch?v={r['id']}",
                    "live": [c for c in cas if c in S.sniper.launches] + [live[t] for t in tags if t in live]})
    return {"videos": out, "quota": quota.snapshot(), "buzz": S.ytbuzz.snapshot()}


@router.post("/youtube/buzz/run")
async def youtube_buzz_run() -> dict[str, Any]:
    try:
        n = await S.ytbuzz.run_once()
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from e
    return {"new_videos": n}


class DuneBody(BaseModel):
    query_id: str
    label: str | None = None


@router.get("/dune/queries")
async def dune_queries() -> list[dict[str, Any]]:
    return await S.traders.dune_queries()


@router.post("/dune/queries")
async def dune_add(b: DuneBody) -> dict[str, Any]:
    try:
        return {"imported": await S.traders.import_dune(b.query_id, b.label), "queries": await S.traders.dune_queries()}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/dune/queries/{qid}/refresh")
async def dune_refresh(qid: int) -> dict[str, Any]:
    try:
        return {"imported": await S.traders.import_dune(str(qid))}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/dune/queries/{qid}")
async def dune_forget(qid: int) -> dict[str, Any]:
    await S.traders.forget_dune(qid)
    return {"ok": True}


@router.post("/snipe/{mint}/scan")
async def snipe_scan(mint: str) -> dict[str, Any]:
    """Run the on-chain insider / fresh-wallet scan for one live launch now (uses Helius credits)."""
    L = S.sniper.launches.get(mint)
    if L is None:
        raise HTTPException(404, "Not a launch Radar is scoring right now")
    if not S.helius.enabled:
        raise HTTPException(400, "Connect Helius on Connectors first")
    intel = await S.onchain.scan(L)
    await S.sniper._evaluate(L, time.time(), force=True)
    return {"intel": intel, "snipe": S.sniper.one(mint)}


@router.post("/engines/claude/run")
async def claude_run() -> dict[str, Any]:
    if not S.ai.enabled:
        raise HTTPException(400, "Connect Anthropic on Connectors first")
    return {"labeled": await S.narrator.run_once(), "stats": S.narrator.stats}
