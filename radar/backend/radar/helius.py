"""Helius: one metered client for every Helius call Radar makes, under ONE daily credit budget.

Credit prices follow Helius' published table (standard RPC = 1 credit, Enhanced Transactions = 100, DAS = 10). The
budget is split between the jobs that use it, and paced across the day so a busy hour can't burn the whole day:

  intel     insider / fresh-wallet / funding-cluster scans of promising launches + real on-chain top-10 holders
  smart     live swaps of followed & top wallets beyond pump.fun (cheap: signatures first, parse only new txs)
  backfill  1-year swap history of ranked wallets (Enhanced Transactions, the expensive one)

Default 30,000 credits/day ≈ 0.9M/month, inside the free plan's 1M. Raise it on the Engines page if you pay for more.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

import httpx

from .health import Health, register

log = logging.getLogger("radar.helius")
h_rpc = register(Health("helius_rpc", "rest", "Helius RPC: insider scans, on-chain holders, live wallet swaps"))
h_rpc.stale_after = 3600

COST = {"rpc": 1, "enhanced": 100, "das": 10}
SHARES = {"intel": 0.45, "smart": 0.30, "backfill": 0.25}
PLANS = {"free": 33_000, "developer": 330_000, "business": 3_300_000}


class BudgetExceeded(RuntimeError):
    pass


class Helius:
    def __init__(self, cfg: Any) -> None:
        self.cfg = cfg
        self.key: str | None = None
        self.client = httpx.AsyncClient(timeout=15)
        self.daily = int(os.environ.get("HELIUS_DAILY_CREDITS", "30000"))
        self.day = int(time.time() // 86400)
        self.spent: dict[str, int] = dict.fromkeys(SHARES, 0)
        self.calls: dict[str, int] = {}
        self.denied: dict[str, int] = dict.fromkeys(SHARES, 0)
        self.last_save = 0.0
        self.cooldown_until = 0.0

    async def load(self) -> None:
        b = await self.cfg.kv_get("helius:budget") or {}
        if b.get("daily"):
            self.daily = int(b["daily"])
        s = await self.cfg.kv_get("helius:spent") or {}
        if s.get("day") == self.day:
            self.spent.update({k: int(v) for k, v in (s.get("spent") or {}).items() if k in SHARES})

    async def set_daily(self, credits: int) -> None:
        self.daily = max(1000, int(credits))
        await self.cfg.kv_set("helius:budget", {"daily": self.daily})

    def set_key(self, key: str | None) -> None:
        self.key = key or None

    @property
    def enabled(self) -> bool:
        return bool(self.key)

    @property
    def rpc_url(self) -> str:
        return os.environ.get("HELIUS_RPC_URL") or f"https://mainnet.helius-rpc.com/?api-key={self.key}"

    @property
    def api_url(self) -> str:
        return os.environ.get("HELIUS_API_URL", "https://api.helius.xyz")

    def _roll(self) -> None:
        d = int(time.time() // 86400)
        if d != self.day:
            self.day, self.spent, self.calls, self.denied = d, dict.fromkeys(SHARES, 0), {}, dict.fromkeys(SHARES, 0)

    def total(self) -> int:
        return sum(self.spent.values())

    def can(self, kind: str, cost: int) -> bool:
        """Within the day's budget, within this job's share (unless the day is under pace), and on pace overall."""
        self._roll()
        if not self.key or time.time() < self.cooldown_until:
            return False
        tot = self.total()
        if tot + cost > self.daily:
            return False
        frac = (time.time() % 86400) / 86400
        on_pace = tot + cost <= self.daily * min(1.0, frac + 0.08)     # never more than ~2h ahead of an even spend
        if not on_pace:
            return False
        if self.spent.get(kind, 0) + cost <= self.daily * SHARES.get(kind, 0.2):
            return True
        return tot + cost <= self.daily * frac * 0.85                  # spare credits flow to whichever job wants them

    def _charge(self, kind: str, cost: int, label: str) -> None:
        self.spent[kind] = self.spent.get(kind, 0) + cost
        self.calls[label] = self.calls.get(label, 0) + 1
        if time.time() - self.last_save > 30:
            self.last_save = time.time()
            asyncio.get_running_loop().create_task(self.cfg.kv_set("helius:spent", {"day": self.day, "spent": self.spent}))

    def _check(self, kind: str, cost: int) -> None:
        if not self.can(kind, cost):
            self.denied[kind] = self.denied.get(kind, 0) + 1
            raise BudgetExceeded(kind)

    async def rpc(self, method: str, params: list[Any], kind: str) -> Any:
        self._check(kind, COST["rpc"])
        t0 = time.perf_counter()
        r = await self.client.post(self.rpc_url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        self._charge(kind, COST["rpc"], method)
        if r.status_code == 429:
            self.cooldown_until = time.time() + 20
            h_rpc.fail("429", rate_limited=True)
            raise BudgetExceeded("rate limited")
        r.raise_for_status()
        j = r.json()
        if j.get("error"):
            h_rpc.fail(str(j["error"])[:200])
            raise RuntimeError(f"helius {method}: {j['error']}")
        h_rpc.ok((time.perf_counter() - t0) * 1000)
        return j.get("result")

    async def enhanced(self, path: str, params: dict[str, Any], kind: str) -> Any:
        self._check(kind, COST["enhanced"])
        r = await self.client.get(f"{self.api_url}{path}", params={**params, "api-key": self.key})
        self._charge(kind, COST["enhanced"], "enhanced")
        if r.status_code == 429:
            self.cooldown_until = time.time() + 20
            raise BudgetExceeded("rate limited")
        r.raise_for_status()
        return r.json()

    def snapshot(self) -> dict[str, Any]:
        self._roll()
        frac = (time.time() % 86400) / 86400
        return {"connected": self.enabled, "daily": self.daily, "spent": self.total(), "by_job": dict(self.spent),
                "shares": {k: round(v * self.daily) for k, v in SHARES.items()}, "calls": dict(self.calls),
                "denied": dict(self.denied), "pace_limit": round(self.daily * min(1.0, frac + 0.08)),
                "resets_in_s": round(86400 - time.time() % 86400), "plans": PLANS,
                "month_estimate": self.daily * 30}


# ---------------- transaction parsing (jsonParsed getTransaction) ----------------
WSOL = "So11111111111111111111111111111111111111112"


def _keys(tx: dict[str, Any]) -> list[str]:
    keys = ((tx.get("transaction") or {}).get("message") or {}).get("accountKeys") or []
    out = [k.get("pubkey") if isinstance(k, dict) else k for k in keys]
    la = (tx.get("meta") or {}).get("loadedAddresses") or {}
    return out + list(la.get("writable") or []) + list(la.get("readonly") or [])


def wallet_swaps(tx: dict[str, Any], wallet: str) -> list[dict[str, Any]]:
    """Token legs of one transaction for `wallet`, from pre/post balances — works for any DEX, router or launchpad."""
    meta = tx.get("meta") or {}
    if meta.get("err") is not None:
        return []
    deltas: dict[str, float] = {}
    for side, rows in ((-1, meta.get("preTokenBalances") or []), (1, meta.get("postTokenBalances") or [])):
        for b in rows:
            if b.get("owner") != wallet or not b.get("mint"):
                continue
            amt = float(((b.get("uiTokenAmount") or {}).get("uiAmount")) or 0)
            deltas[b["mint"]] = deltas.get(b["mint"], 0.0) + side * amt
    keys = _keys(tx)
    sol = 0.0
    if wallet in keys:
        i = keys.index(wallet)
        pre, post = meta.get("preBalances") or [], meta.get("postBalances") or []
        if i < len(pre) and i < len(post):
            sol = (post[i] - pre[i]) / 1e9
            if i == 0:
                sol += (meta.get("fee") or 0) / 1e9     # the fee isn't part of the trade
    sol += deltas.pop(WSOL, 0.0)
    out = []
    for mint, d in deltas.items():
        if abs(d) <= 0:
            continue
        side = "buy" if d > 0 else "sell"
        out.append({"mint": mint, "side": side, "tokens": abs(d),
                    "sol": abs(sol) if (side == "buy" and sol < 0) or (side == "sell" and sol > 0) else None})
    return out


def funding_source(tx: dict[str, Any], wallet: str) -> tuple[str | None, float | None]:
    """Who sent `wallet` its first SOL: the source of a system transfer / createAccount into it (else the fee payer)."""
    msg = (tx.get("transaction") or {}).get("message") or {}
    ixs = list(msg.get("instructions") or [])
    for inner in (tx.get("meta") or {}).get("innerInstructions") or []:
        ixs += inner.get("instructions") or []
    for ix in ixs:
        p = ix.get("parsed") if isinstance(ix, dict) else None
        if not isinstance(p, dict) or ix.get("program") != "system":
            continue
        info = p.get("info") or {}
        dest = info.get("destination") or info.get("newAccount")
        if p.get("type") in ("transfer", "transferWithSeed", "createAccount", "createAccountWithSeed") and dest == wallet:
            src = info.get("source")
            if src and src != wallet:
                return src, float(info.get("lamports") or 0) / 1e9
    keys = _keys(tx)
    if keys and keys[0] != wallet:
        return keys[0], None
    return None, None
