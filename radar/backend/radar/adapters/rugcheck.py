"""RugCheck read API (no key). Docs: https://api.rugcheck.xyz/swagger/index.html"""
from __future__ import annotations

import json
import time
from typing import Any

from ..config import settings
from ..health import Health, register
from ..ratelimit import TokenBucket
from .http import RestClient

health = register(Health("rugcheck", "rest", "Risk score, mint/freeze authority, LP lock, holders, insiders"))
bucket = TokenBucket(settings.rugcheck_rpm, burst=3)
health.headroom_fn = bucket.headroom
health.stale_after = 900


def parse_report(mint: str, r: dict[str, Any], as_of: float | None = None) -> dict[str, Any]:
    token = r.get("token") or {}
    holders = r.get("topHolders") or []
    # exclude AMM / bonding-curve vaults from concentration: RugCheck marks known program owners in knownAccounts
    known = r.get("knownAccounts") or {}
    real = [h for h in holders if h.get("owner") not in known and h.get("address") not in known]
    top10 = sum(float(h.get("pct") or 0) for h in real[:10]) if real else None
    lp_pct = None
    for m in r.get("markets") or []:
        v = (m.get("lp") or {}).get("lpLockedPct")
        if v is not None:
            lp_pct = max(lp_pct or 0.0, float(v))
    if lp_pct is None and r.get("lpLockedPct") is not None:
        lp_pct = float(r["lpLockedPct"])
    return {
        "token_address": mint,
        "as_of": as_of or time.time(),
        "source": "rugcheck",
        "score": r.get("score"),
        "score_normalised": r.get("score_normalised"),
        "mint_authority": token.get("mintAuthority") or "",   # "" = revoked (null upstream)
        "freeze_authority": token.get("freezeAuthority") or "",
        "lp_locked_pct": lp_pct,
        "top10_pct": round(top10, 2) if top10 is not None else None,
        "holders": r.get("totalHolders"),
        "insiders_detected": r.get("graphInsidersDetected"),
        "rugged": 1 if r.get("rugged") else 0,
        "creator": r.get("creator"),
        "risks_json": json.dumps(r.get("risks") or []),
        "top_holders_json": json.dumps([
            {"address": h.get("owner") or h.get("address"), "pct": h.get("pct"), "insider": h.get("insider")}
            for h in real[:20]
        ]),
    }


class RugCheck:
    def __init__(self) -> None:
        self.http = RestClient(settings.rugcheck_url, health, timeout=20)

    async def report(self, mint: str) -> dict[str, Any] | None:
        data = await self.http.get(f"/tokens/{mint}/report", bucket, not_found_ok=True, retries=2)
        return parse_report(mint, data) if data else None
