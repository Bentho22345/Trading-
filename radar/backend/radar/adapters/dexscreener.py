"""DexScreener public API (no key). Docs: https://docs.dexscreener.com/api/reference"""
from __future__ import annotations

import time
from typing import Any

from ..config import settings
from ..health import Health, register
from ..ratelimit import TokenBucket
from .http import RestClient

health = register(Health("dexscreener", "rest", "Pairs, price, volume, liquidity, txns, profiles, boosts"))
pairs_bucket = TokenBucket(settings.dex_pairs_rpm)
profiles_bucket = TokenBucket(settings.dex_profiles_rpm)
health.headroom_fn = pairs_bucket.headroom
BATCH = 30  # max token addresses per /tokens/v1 call


def _f(v: Any) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def parse_pair(p: dict[str, Any], as_of: float | None = None) -> dict[str, Any]:
    tx = p.get("txns") or {}
    vol = p.get("volume") or {}
    chg = p.get("priceChange") or {}
    created = p.get("pairCreatedAt")
    return {
        "pair_address": p.get("pairAddress"),
        "token_address": (p.get("baseToken") or {}).get("address"),
        "chain": p.get("chainId"),
        "dex": p.get("dexId"),
        "url": p.get("url"),
        "quote_symbol": (p.get("quoteToken") or {}).get("symbol"),
        "price_usd": _f(p.get("priceUsd")),
        "price_native": _f(p.get("priceNative")),
        "liquidity_usd": _f((p.get("liquidity") or {}).get("usd")),
        "fdv": _f(p.get("fdv")),
        "market_cap": _f(p.get("marketCap")),
        "vol_m5": _f(vol.get("m5")), "vol_h1": _f(vol.get("h1")),
        "vol_h6": _f(vol.get("h6")), "vol_h24": _f(vol.get("h24")),
        "buys_m5": (tx.get("m5") or {}).get("buys"), "sells_m5": (tx.get("m5") or {}).get("sells"),
        "buys_h1": (tx.get("h1") or {}).get("buys"), "sells_h1": (tx.get("h1") or {}).get("sells"),
        "buys_h24": (tx.get("h24") or {}).get("buys"), "sells_h24": (tx.get("h24") or {}).get("sells"),
        "chg_m5": _f(chg.get("m5")), "chg_h1": _f(chg.get("h1")),
        "chg_h6": _f(chg.get("h6")), "chg_h24": _f(chg.get("h24")),
        "pair_created_at": created / 1000 if created else None,
        "boosts_active": (p.get("boosts") or {}).get("active"),
        "as_of": as_of or time.time(),
    }


def token_meta(p: dict[str, Any]) -> dict[str, Any]:
    base = p.get("baseToken") or {}
    info = p.get("info") or {}
    links = {"websites": info.get("websites") or [], "socials": info.get("socials") or []}
    return {
        "address": base.get("address"),
        "chain": p.get("chainId"),
        "name": base.get("name"),
        "symbol": base.get("symbol"),
        "image": info.get("imageUrl"),
        "links": links if (links["websites"] or links["socials"]) else None,
    }


class DexScreener:
    def __init__(self) -> None:
        self.http = RestClient(settings.dexscreener_url, health)

    async def tokens(self, chain: str, addresses: list[str]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for i in range(0, len(addresses), BATCH):
            chunk = addresses[i:i + BATCH]
            data = await self.http.get(f"/tokens/v1/{chain}/{','.join(chunk)}", pairs_bucket)
            out.extend(data or [])
        return out

    async def token_pairs(self, chain: str, address: str) -> list[dict[str, Any]]:
        return await self.http.get(f"/token-pairs/v1/{chain}/{address}", pairs_bucket) or []

    async def search(self, q: str) -> list[dict[str, Any]]:
        data = await self.http.get("/latest/dex/search", pairs_bucket, params={"q": q})
        return (data or {}).get("pairs") or []

    async def profiles_latest(self) -> list[dict[str, Any]]:
        return await self.http.get("/token-profiles/latest/v1", profiles_bucket) or []

    async def boosts_latest(self) -> list[dict[str, Any]]:
        return await self.http.get("/token-boosts/latest/v1", profiles_bucket) or []

    async def boosts_top(self) -> list[dict[str, Any]]:
        return await self.http.get("/token-boosts/top/v1", profiles_bucket) or []
