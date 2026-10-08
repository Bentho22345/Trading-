"""More keyless connectors: GoPlus (EVM token safety), ForexFactory macro calendar, Solana public RPC (read-only
wallet holdings), Jupiter recent tokens."""
from __future__ import annotations

import json
import time
from typing import Any

from ..health import Health, register
from ..ratelimit import TokenBucket
from .http import RestClient

goplus_h = register(Health("goplus", "rest", "GoPlus token security for EVM chains (mintable, honeypot, holders, LP lock)"))
goplus_h.stale_after = 3600
ff_h = register(Health("ff_calendar", "rest", "ForexFactory weekly macro calendar (Fed, CPI, NFP… catalysts)"))
ff_h.stale_after = 6 * 3600
rpc_h = register(Health("solana_rpc", "rest", "Solana RPC: read-only wallet holdings"))
rpc_h.stale_after = 86400
jupr_h = register(Health("jupiter_recent", "rest", "Jupiter: newest tokens with organic score & audit flags"))
jupr_h.stale_after = 600

goplus_b, ff_b, rpc_b, jupr_b = TokenBucket(20, 2), TokenBucket(2, 1), TokenBucket(30, 3), TokenBucket(10, 2)
for h, b in ((goplus_h, goplus_b), (ff_h, ff_b), (rpc_h, rpc_b), (jupr_h, jupr_b)):
    h.headroom_fn = b.headroom

EVM_CHAIN_IDS = {"ethereum": "1", "bsc": "56", "base": "8453", "arbitrum": "42161", "polygon": "137", "avalanche": "43114"}
BURN = {"0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000"}
TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PAnBqCXEpPxuEb"]


def _f(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_goplus(addr: str, r: dict[str, Any]) -> dict[str, Any]:
    risks = []
    def flag(k: str, name: str, level: str = "danger") -> None:
        if str(r.get(k)) == "1":
            risks.append({"name": name, "level": level, "description": f"GoPlus: {k}"})
    flag("is_mintable", "Mintable supply")
    flag("is_honeypot", "Honeypot (cannot sell)")
    flag("is_blacklisted", "Blacklist function")
    flag("hidden_owner", "Hidden owner")
    flag("can_take_back_ownership", "Owner can reclaim ownership")
    flag("owner_change_balance", "Owner can change balances")
    flag("selfdestruct", "Self-destruct")
    flag("is_proxy", "Upgradeable proxy", "warn")
    if str(r.get("is_open_source")) == "0":
        risks.append({"name": "Contract not verified", "level": "warn", "description": "GoPlus: is_open_source=0"})
    for k, n in (("buy_tax", "Buy tax"), ("sell_tax", "Sell tax")):
        t = _f(r.get(k))
        if t and t > 0.05:
            risks.append({"name": f"{n} {t * 100:.0f}%", "level": "danger" if t > 0.15 else "warn", "description": "GoPlus"})
    holders = [h for h in r.get("holders") or [] if str(h.get("is_contract")) != "1"]
    top10 = sum((_f(h.get("percent")) or 0) for h in holders[:10]) * 100 if holders else None
    lp = r.get("lp_holders") or []
    locked = sum((_f(h.get("percent")) or 0) for h in lp if str(h.get("is_locked")) == "1"
                 or (h.get("address") or "").lower() in BURN) * 100 if lp else None
    return {
        "token_address": addr, "as_of": time.time(), "source": "goplus",
        "score": None, "score_normalised": min(100, len([x for x in risks if x["level"] == "danger"]) * 30 + len(risks) * 5),
        "mint_authority": "mintable" if str(r.get("is_mintable")) == "1" else "",
        "freeze_authority": "honeypot/blacklist" if str(r.get("is_honeypot")) == "1" or str(r.get("is_blacklisted")) == "1" else "",
        "lp_locked_pct": locked, "top10_pct": round(top10, 2) if top10 is not None else None,
        "holders": int(r["holder_count"]) if str(r.get("holder_count") or "").isdigit() else None,
        "insiders_detected": None, "rugged": 1 if str(r.get("is_honeypot")) == "1" else 0, "creator": r.get("creator_address"),
        "risks_json": json.dumps(risks),
        "top_holders_json": json.dumps([{"address": h.get("address"), "pct": (_f(h.get("percent")) or 0) * 100} for h in holders[:20]]),
    }


class Extra:
    def __init__(self) -> None:
        self.goplus = RestClient("https://api.gopluslabs.io/api/v1", goplus_h)
        self.ff = RestClient("https://nfs.faireconomy.media", ff_h)
        self.jup = RestClient("https://lite-api.jup.ag", jupr_h)
        self.rpc_url = "https://api.mainnet-beta.solana.com"
        self.rpc = RestClient(self.rpc_url, rpc_h)

    def set_helius(self, key: str | None) -> None:
        url = f"https://mainnet.helius-rpc.com/?api-key={key}" if key else "https://api.mainnet-beta.solana.com"
        if url != self.rpc_url:
            self.rpc_url = url
            self.rpc = RestClient(url, rpc_h)

    async def evm_safety(self, chain: str, addr: str) -> dict[str, Any] | None:
        cid = EVM_CHAIN_IDS.get(chain)
        if not cid:
            return None
        d = await self.goplus.get(f"/token_security/{cid}", goplus_b, params={"contract_addresses": addr}) or {}
        res = (d.get("result") or {}).get(addr.lower())
        return parse_goplus(addr, res) if res else None

    async def calendar(self) -> list[dict[str, Any]]:
        rows = await self.ff.get("/ff_calendar_thisweek.json", ff_b) or []
        return [{"title": r.get("title"), "country": r.get("country"), "date": r.get("date"), "impact": r.get("impact"),
                 "forecast": r.get("forecast"), "previous": r.get("previous")} for r in rows
                if r.get("impact") in ("High", "Medium") and r.get("country") in ("USD", "ALL", "CNY", "EUR")]

    async def jupiter_recent(self) -> list[dict[str, Any]]:
        rows = await self.jup.get("/tokens/v2/recent", jupr_b) or []
        out = []
        for r in rows[:60]:
            audit = r.get("audit") or {}
            out.append({"token_address": r.get("id"), "name": r.get("name"), "symbol": r.get("symbol"), "icon": r.get("icon"),
                        "holders": r.get("holderCount"), "organic_score": r.get("organicScore"),
                        "mint_disabled": audit.get("mintAuthorityDisabled"), "freeze_disabled": audit.get("freezeAuthorityDisabled"),
                        "top_holders_pct": audit.get("topHoldersPercentage"), "liquidity_usd": r.get("liquidity"),
                        "mcap": r.get("mcap"), "created": (r.get("firstPool") or {}).get("createdAt")})
        return out

    async def sol_balance(self, owner: str) -> float | None:
        """Native SOL balance (lamports -> SOL) via getBalance. None when the RPC call fails."""
        await rpc_b.acquire()
        t0 = time.perf_counter()
        r = await self.rpc.client.post(self.rpc_url, json={"jsonrpc": "2.0", "id": 1, "method": "getBalance", "params": [owner]})
        if r.status_code >= 400:
            rpc_h.fail(f"HTTP {r.status_code}")
            return None
        rpc_h.ok((time.perf_counter() - t0) * 1000)
        lamports = ((r.json().get("result") or {}).get("value"))
        return lamports / 1e9 if isinstance(lamports, (int, float)) else None

    async def holdings(self, owner: str) -> list[dict[str, Any]]:
        out = []
        for prog in TOKEN_PROGRAMS:
            await rpc_b.acquire()
            t0 = time.perf_counter()
            r = await self.rpc.client.post(self.rpc_url, json={
                "jsonrpc": "2.0", "id": 1, "method": "getTokenAccountsByOwner",
                "params": [owner, {"programId": prog}, {"encoding": "jsonParsed"}]})
            if r.status_code >= 400:
                rpc_h.fail(f"HTTP {r.status_code}")
                continue
            rpc_h.ok((time.perf_counter() - t0) * 1000)
            for acc in ((r.json().get("result") or {}).get("value") or []):
                info = (((acc.get("account") or {}).get("data") or {}).get("parsed") or {}).get("info") or {}
                amt = (info.get("tokenAmount") or {}).get("uiAmount")
                if amt:
                    out.append({"mint": info.get("mint"), "amount": amt})
        return out
