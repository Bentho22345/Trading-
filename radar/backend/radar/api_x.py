"""X Radar endpoints: the tweet-narrative board, coin races, graded callers, the roster, watcher events, budget."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .app import S

router = APIRouter(prefix="/api/x")


@router.get("/tweets")
async def tweets(hours: float = 12, limit: int = 60, min_score: float = 0, category: str = "", kind: str = "") -> list[dict[str, Any]]:
    return await S.xradar.board(min(hours, 72), min(limit, 300), min_score, category, kind)


@router.get("/races")
async def races(hours: float = 12) -> list[dict[str, Any]]:
    return await S.xradar.races(min(hours, 72))


@router.get("/callers")
async def callers(days: float = 7, min_calls: int = 1) -> list[dict[str, Any]]:
    return await S.xradar.callers(min(days, 60), max(1, min_calls))


@router.get("/status")
async def status() -> dict[str, Any]:
    return await S.xradar.status()


@router.get("/events")
async def events(limit: int = 50) -> list[dict[str, Any]]:
    return await S.xradar.events(min(limit, 300))


@router.get("/accounts")
async def accounts() -> list[dict[str, Any]]:
    return await S.xradar.accounts()


class AccountBody(BaseModel):
    handle: str
    category: str = "kol"
    tier: str = "B"
    replies: bool = False


@router.post("/accounts")
async def add_account(b: AccountBody) -> dict[str, Any]:
    try:
        return await S.xradar.add_account(b.handle, b.category, b.tier.upper(), b.replies)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/accounts/{handle}")
async def remove_account(handle: str) -> dict[str, Any]:
    await S.xradar.remove_account(handle)
    return {"ok": True}


class BudgetBody(BaseModel):
    daily_usd: float


@router.post("/budget")
async def budget(b: BudgetBody) -> dict[str, Any]:
    if not 0 <= b.daily_usd <= 500:
        raise HTTPException(400, "Budget must be between $0 and $500 a day")
    await S.cfg.kv_set("x:budget_usd", b.daily_usd)
    return await S.xradar.status()
