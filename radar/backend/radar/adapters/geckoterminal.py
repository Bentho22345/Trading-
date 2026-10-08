"""GeckoTerminal public API (no key, ~30 calls/min). Docs: https://apiguide.geckoterminal.com"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from ..config import settings
from ..health import Health, register
from ..ratelimit import TokenBucket
from .http import RestClient

health = register(Health("geckoterminal", "rest", "Trending pools, new pools, OHLCV candles"))
bucket = TokenBucket(settings.gecko_rpm, burst=5)
health.headroom_fn = bucket.headroom

TIMEFRAMES = {"1m": ("minute", 1), "5m": ("minute", 5), "15m": ("minute", 15),
              "1h": ("hour", 1), "4h": ("hour", 4), "1d": ("day", 1)}


def _ts(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _f(v: Any) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def parse_pools(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten a pools response (with include=base_token) into rows."""
    included = {i["id"]: i.get("attributes", {}) for i in payload.get("included", []) if i.get("type") == "token"}
    rows = []
    for p in payload.get("data", []):
        a = p.get("attributes", {})
        rel = p.get("relationships", {})
        base_id = ((rel.get("base_token") or {}).get("data") or {}).get("id", "")
        base = included.get(base_id, {})
        tx = a.get("transactions") or {}
        vol = a.get("volume_usd") or {}
        chg = a.get("price_change_percentage") or {}
        rows.append({
            "pool_address": a.get("address"),
            "token_address": base.get("address") or (base_id.split("_", 1)[1] if "_" in base_id else None),
            "name": base.get("name") or a.get("name"),
            "symbol": base.get("symbol"),
            "image": base.get("image_url") if base.get("image_url") not in (None, "missing.png") else None,
            "pool_name": a.get("name"),
            "dex": ((rel.get("dex") or {}).get("data") or {}).get("id"),
            "price_usd": _f(a.get("base_token_price_usd")),
            "fdv_usd": _f(a.get("fdv_usd")),
            "market_cap_usd": _f(a.get("market_cap_usd")),
            "liquidity_usd": _f(a.get("reserve_in_usd")),
            "vol_m5": _f(vol.get("m5")), "vol_h1": _f(vol.get("h1")), "vol_h24": _f(vol.get("h24")),
            "chg_m5": _f(chg.get("m5")), "chg_h1": _f(chg.get("h1")), "chg_h24": _f(chg.get("h24")),
            "buys_h1": (tx.get("h1") or {}).get("buys"), "sells_h1": (tx.get("h1") or {}).get("sells"),
            "buyers_h1": (tx.get("h1") or {}).get("buyers"), "sellers_h1": (tx.get("h1") or {}).get("sellers"),
            "pool_created_at": _ts(a.get("pool_created_at")),
        })
    return rows


def parse_ohlcv(payload: dict[str, Any]) -> list[dict[str, float]]:
    lst = (((payload or {}).get("data") or {}).get("attributes") or {}).get("ohlcv_list") or []
    candles = [{"time": int(r[0]), "open": r[1], "high": r[2], "low": r[3], "close": r[4], "volume": r[5]} for r in lst]
    return sorted(candles, key=lambda c: c["time"])


SOL_MINT = "So11111111111111111111111111111111111111112"


def parse_trades(payload: dict[str, Any], token: str) -> list[dict[str, Any]]:
    """Pool trades (last 24h, newest first) -> ledger trades for `token` against SOL. Non-SOL legs are skipped."""
    out = []
    for t in (payload or {}).get("data") or []:
        a = t.get("attributes") or {}
        frm, to = a.get("from_token_address"), a.get("to_token_address")
        if a.get("kind") == "buy" and frm == SOL_MINT and to == token:
            sol, tokens = _f(a.get("from_token_amount")), _f(a.get("to_token_amount"))
        elif a.get("kind") == "sell" and frm == token and to == SOL_MINT:
            sol, tokens = _f(a.get("to_token_amount")), _f(a.get("from_token_amount"))
        else:
            continue
        if not sol or not tokens or not a.get("tx_from_address"):
            continue
        out.append({"trader": a["tx_from_address"], "mint": token, "side": a["kind"], "sol": sol, "tokens": tokens,
                    "ts": _ts(a.get("block_timestamp")), "signature": a.get("tx_hash"),
                    "usd": _f(a.get("volume_in_usd")), "source": "geckoterminal"})
    return out


class GeckoTerminal:
    def __init__(self) -> None:
        self.http = RestClient(settings.geckoterminal_url, health, headers={"Accept": "application/json;version=20230302"})

    async def trending_pools(self, network: str = "solana") -> list[dict[str, Any]]:
        return parse_pools(await self.http.get(f"/networks/{network}/trending_pools", bucket,
                                               params={"include": "base_token", "page": 1}) or {})

    async def new_pools(self, network: str = "solana") -> list[dict[str, Any]]:
        return parse_pools(await self.http.get(f"/networks/{network}/new_pools", bucket,
                                               params={"include": "base_token", "page": 1}) or {})

    async def ohlcv(self, pool: str, tf: str = "5m", network: str = "solana", limit: int = 300) -> list[dict[str, float]]:
        unit, agg = TIMEFRAMES.get(tf, TIMEFRAMES["5m"])
        data = await self.http.get(f"/networks/{network}/pools/{pool}/ohlcv/{unit}", bucket,
                                   params={"aggregate": agg, "limit": limit, "currency": "usd"}, not_found_ok=True)
        return parse_ohlcv(data or {})

    async def trades(self, pool: str, token: str, network: str = "solana") -> list[dict[str, Any]]:
        data = await self.http.get(f"/networks/{network}/pools/{pool}/trades", bucket, not_found_ok=True)
        return parse_trades(data or {}, token)
