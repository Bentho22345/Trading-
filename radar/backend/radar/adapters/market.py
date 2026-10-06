"""Keyless market-context sources: Fear & Greed, DeFiLlama, Jupiter, CoinGecko trending, Polymarket, Kalshi."""
from __future__ import annotations

import time
from typing import Any

from ..health import Health, register
from ..ratelimit import TokenBucket
from .http import RestClient

fng_h = register(Health("feargreed", "rest", "Alternative.me Crypto Fear & Greed index"))
fng_h.stale_after = 7200
llama_h = register(Health("defillama", "rest", "Solana TVL and DEX volume trend"))
llama_h.stale_after = 1800
jup_h = register(Health("jupiter", "rest", "Jupiter price API (SOL token prices)"))
cg_h = register(Health("coingecko", "rest", "CoinGecko trending coins + meme category (public, keyless tier)"))
cg_h.stale_after = 900
poly_h = register(Health("polymarket", "rest", "Polymarket top markets by 24h volume (odds swings = news)"))
poly_h.stale_after = 600
kalshi_h = register(Health("kalshi", "rest", "Kalshi open markets (public market data)"))
kalshi_h.stale_after = 600

fng_b, llama_b, jup_b = TokenBucket(10, 2), TokenBucket(20, 3), TokenBucket(60, 5)
cg_b, poly_b, kalshi_b = TokenBucket(5, 2), TokenBucket(30, 3), TokenBucket(20, 3)  # CG keyless tier is strict
for h, b in ((fng_h, fng_b), (llama_h, llama_b), (jup_h, jup_b), (cg_h, cg_b), (poly_h, poly_b), (kalshi_h, kalshi_b)):
    h.headroom_fn = b.headroom

SOL_MINT = "So11111111111111111111111111111111111111112"


def _f(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class Market:
    def __init__(self, coingecko_key: str | None = None) -> None:
        self.fng = RestClient("https://api.alternative.me", fng_h)
        self.llama = RestClient("https://api.llama.fi", llama_h)
        self.jup = RestClient("https://lite-api.jup.ag", jup_h)
        self.poly = RestClient("https://gamma-api.polymarket.com", poly_h)
        self.kalshi = RestClient("https://api.elections.kalshi.com/trade-api/v2", kalshi_h)
        self.set_coingecko_key(coingecko_key)

    def set_coingecko_key(self, key: str | None) -> None:
        headers = {"x-cg-demo-api-key": key} if key else {}
        self.cg = RestClient("https://api.coingecko.com/api/v3", cg_h, headers=headers)
        cg_b.rate = (30 if key else 5) / 60

    async def fear_greed(self) -> dict[str, Any] | None:
        d = await self.fng.get("/fng/", fng_b, params={"limit": 2})
        rows = (d or {}).get("data") or []
        if not rows:
            return None
        cur = rows[0]
        return {"value": _f(cur.get("value")), "label": cur.get("value_classification"),
                "prev": _f(rows[1]["value"]) if len(rows) > 1 else None,
                "as_of": float(cur.get("timestamp") or time.time()), "source": "alternative.me"}

    async def solana_dex_volume(self) -> dict[str, Any] | None:
        d = await self.llama.get("/overview/dexs/solana", llama_b,
                                 params={"excludeTotalDataChart": "true", "excludeTotalDataChartBreakdown": "true"})
        if not d:
            return None
        return {"total24h": _f(d.get("total24h")), "change_1d": _f(d.get("change_1d")),
                "change_7d": _f(d.get("change_7d")), "as_of": time.time(), "source": "defillama"}

    async def prices(self, mints: list[str]) -> dict[str, float]:
        out: dict[str, float] = {}
        for i in range(0, len(mints), 50):
            d = await self.jup.get("/price/v3", jup_b, params={"ids": ",".join(mints[i:i + 50])}) or {}
            for k, v in d.items():
                p = _f((v or {}).get("usdPrice"))
                if p is not None:
                    out[k] = p
        return out

    async def coingecko_trending(self) -> list[dict[str, Any]]:
        d = await self.cg.get("/search/trending", cg_b) or {}
        out = []
        for i, c in enumerate(d.get("coins") or []):
            it = c.get("item") or {}
            data = it.get("data") or {}
            out.append({"rank": i + 1, "name": it.get("name"), "symbol": it.get("symbol"), "id": it.get("id"),
                        "image": it.get("small"), "market_cap_rank": it.get("market_cap_rank"),
                        "price_usd": _f(data.get("price")),
                        "chg_24h": _f((data.get("price_change_percentage_24h") or {}).get("usd"))})
        return out

    async def coingecko_meme_category(self) -> dict[str, Any] | None:
        d = await self.cg.get("/coins/categories", cg_b) or []
        for c in d:
            if c.get("id") == "meme-token":
                return {"market_cap": _f(c.get("market_cap")), "chg_24h": _f(c.get("market_cap_change_24h")),
                        "volume_24h": _f(c.get("volume_24h")), "as_of": time.time(), "source": "coingecko"}
        return None

    async def polymarket_top(self, limit: int = 25) -> list[dict[str, Any]]:
        d = await self.poly.get("/markets", poly_b, params={"active": "true", "closed": "false",
                                                            "order": "volume24hr", "ascending": "false",
                                                            "limit": limit}) or []
        out = []
        for m in d:
            out.append({"id": m.get("id"), "question": m.get("question"), "slug": m.get("slug"),
                        "volume_24h": _f(m.get("volume24hr")), "last_price": _f(m.get("lastTradePrice")),
                        "chg_1d": _f(m.get("oneDayPriceChange")), "chg_1h": _f(m.get("oneHourPriceChange")),
                        "url": f"https://polymarket.com/market/{m.get('slug')}" if m.get("slug") else None})
        return out

    async def kalshi_top(self, limit: int = 100) -> list[dict[str, Any]]:
        d = await self.kalshi.get("/markets", kalshi_b, params={"status": "open", "limit": limit}) or {}
        rows = []
        for m in d.get("markets") or []:
            rows.append({"ticker": m.get("ticker"), "title": m.get("title"),
                         "volume_24h": _f(m.get("volume_24h")), "last_price": _f(m.get("last_price")),
                         "prev_price": _f(m.get("previous_price"))})
        rows.sort(key=lambda r: r["volume_24h"] or 0, reverse=True)
        return rows[:25]
