"""On-chain intel (Helius): who are a launch's early buyers, really?

For a launch that is getting interesting, Radar looks up its earliest / biggest buyers on chain:

  fresh wallets   created in the last 24h (their first transaction is recent) — classic insider / bundle burners
  funding source  who sent each fresh wallet its first SOL; several buyers funded by the SAME wallet (or by the dev,
                  or by whoever funded the dev) form an insider cluster, however the buys were spread out in time
  bots            wallets firing dozens of transactions within minutes (sniper bots)
  chain top-10    the real top-10 holders from the chain (getTokenLargestAccounts), with the bonding curve's own
                  account removed — correct even when Radar subscribed to the coin late

Wallet lookups are cached for days (the same snipers and insiders show up launch after launch), so most scans cost a
handful of credits. Everything runs under the Helius daily budget; nothing here can sign or send a transaction.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter
from typing import Any

from . import feed
from .helius import BudgetExceeded, Helius, funding_source

log = logging.getLogger("radar.onchain")

SIG_LIMIT = 40                 # a wallet with fewer signatures than this: we can see its very first transaction
FRESH_S = 86400
SCAN_WALLETS = 14
CURVE_K = 30.0 * 1.073e9       # pump.fun virtual reserves product (SOL × tokens)


def curve_balance(vsol: float | None) -> float | None:
    """Tokens still in the bonding curve's own account: virtual tokens − 73M (279.9M virtual − 206.9M migration reserve)."""
    if not vsol:
        return None
    return CURVE_K / vsol - 73e6


def chain_top10(accounts: list[dict[str, Any]], vsol: float | None, graduated: bool) -> dict[str, Any] | None:
    amts = sorted((float(a.get("uiAmount") or 0) for a in accounts if a.get("uiAmount")), reverse=True)
    if not amts:
        return None
    dropped = None
    if not graduated:
        exp = curve_balance(vsol)
        if exp:
            i, best = min(enumerate(amts), key=lambda p: abs(p[1] - exp))
            if abs(best - exp) <= max(0.05 * exp, 5e6):
                dropped = amts.pop(i)
        if dropped is None and amts and amts[0] >= 2.0e8:   # the curve always holds ≥ the 206.9M migration reserve
            dropped = amts.pop(0)
    top = amts[:10]
    return {"chain_top10_pct": round(sum(top) / 1e9 * 100, 1), "chain_whales": sum(1 for a in amts if a >= 2e7),
            "curve_excluded": dropped is not None}


class OnChain:
    def __init__(self, db: Any, helius: Helius, sniper: Any, alerts: Any) -> None:
        self.db, self.helius, self.sniper, self.alerts = db, helius, sniper, alerts
        self.cache: dict[str, dict[str, Any]] = {}
        self.pending: dict[str, float] = {}        # mint -> priority
        self.scanned: dict[str, float] = {}        # mint -> last scan ts
        self.wake = asyncio.Event()
        self.stats = {"scans": 0, "wallets_looked_up": 0, "cache_hits": 0, "insider_coins": 0, "fresh_coins": 0}

    # ---------------- which launches get scanned ----------------
    def consider(self, L: Any) -> None:
        """Called after every evaluation: queue launches worth spending credits on (cheap, memory only)."""
        if not self.helius.enabled:
            return
        r = L.result or {}
        now = time.time()
        if len(L.buyers) < 6 or now - L.created < 15:
            return
        last = self.scanned.get(L.mint)
        tier = r.get("tier")
        pri = max((r.get("scores") or {}).get("degen", 0), r.get("upside", 0) * 0.8) + (25 if tier == "SNIPE" else 10 if tier == "WATCH" else 0)
        if last is None:
            if pri >= 22 or tier in ("SNIPE", "WATCH"):
                self.pending[L.mint] = max(pri, self.pending.get(L.mint, 0))
                self.wake.set()
        elif tier == "SNIPE" and now - last > 240 and not L.graduated_at:
            self.pending[L.mint] = pri                 # re-check a live call's holders every few minutes
            self.wake.set()

    async def run(self) -> None:
        while True:
            try:
                if not self.pending:
                    self.wake.clear()
                    try:
                        await asyncio.wait_for(self.wake.wait(), 30)
                    except asyncio.TimeoutError:
                        pass
                    continue
                mint = max(self.pending, key=self.pending.get)
                self.pending.pop(mint, None)
                L = self.sniper.launches.get(mint)
                if L is None:
                    continue
                if not self.helius.can("intel", 3):
                    self.pending[mint] = 0       # keep it; try again when the budget allows
                    await asyncio.sleep(20)
                    continue
                await self.scan(L)
            except asyncio.CancelledError:
                raise
            except BudgetExceeded:
                await asyncio.sleep(15)
            except Exception as e:  # noqa: BLE001
                log.warning("onchain scan: %s", e)
                await asyncio.sleep(2)
            if len(self.scanned) > 20000:
                cut = time.time() - 6 * 3600
                self.scanned = {k: v for k, v in self.scanned.items() if v > cut}

    # ---------------- wallet lookups ----------------
    async def wallet(self, w: str) -> dict[str, Any] | None:
        now = time.time()
        c = self.cache.get(w)
        if c and now - c["checked"] < (86400 if c.get("fresh") else 3 * 86400):
            self.stats["cache_hits"] += 1
            return c
        if c is None:
            row = await self.db.one("SELECT * FROM wallet_intel WHERE wallet=?", (w,))
            if row and now - row["checked"] < (86400 if row["fresh"] else 3 * 86400):
                self.cache[w] = dict(row)
                self.stats["cache_hits"] += 1
                return self.cache[w]
        sigs = await self.helius.rpc("getSignaturesForAddress", [w, {"limit": SIG_LIMIT}], "intel") or []
        self.stats["wallets_looked_up"] += 1
        times = [s.get("blockTime") for s in sigs if s.get("blockTime")]
        info: dict[str, Any] = {"wallet": w, "checked": now, "tx_count": len(sigs), "first_ts": None, "last_ts": max(times) if times else None,
                                "funder": None, "funded_sol": None, "fresh": 0, "bot": 0}
        if len(sigs) >= SIG_LIMIT and times and max(times) - min(times) < 900:
            info["bot"] = 1                              # 40 transactions inside 15 minutes
        if sigs and len(sigs) < SIG_LIMIT:
            first = sigs[-1]
            info["first_ts"] = first.get("blockTime")
            info["fresh"] = 1 if info["first_ts"] and now - info["first_ts"] < FRESH_S else 0
            try:
                tx = await self.helius.rpc("getTransaction", [first["signature"], {"encoding": "jsonParsed",
                                                                                   "maxSupportedTransactionVersion": 0}], "intel")
                if tx:
                    info["funder"], info["funded_sol"] = funding_source(tx, w)
            except BudgetExceeded:
                pass
        self.cache[w] = info
        if len(self.cache) > 50000:
            self.cache.clear()
        await self.db.upsert("wallet_intel", info, "wallet")
        return info

    # ---------------- one launch ----------------
    async def scan(self, L: Any) -> dict[str, Any]:
        now = time.time()
        self.scanned[L.mint] = now
        self.stats["scans"] += 1
        first = sorted((w for w in L.buyers if w != L.deployer), key=lambda w: L.buyers[w])[:10]
        big = sorted((w for w in L.buy_sol if w != L.deployer), key=lambda w: -L.buy_sol[w])[:6]
        wallets = list(dict.fromkeys(first + big))[:SCAN_WALLETS]
        infos: dict[str, dict[str, Any]] = {}
        dev = None
        try:
            if L.deployer:
                dev = await self.wallet(L.deployer)
            for w in wallets:
                i = await self.wallet(w)
                if i:
                    infos[w] = i
        except BudgetExceeded:
            pass
        holders = None
        try:
            res = await self.helius.rpc("getTokenLargestAccounts", [L.mint], "intel")
            holders = chain_top10((res or {}).get("value") or [], L.vsol, bool(L.graduated_at))
        except (BudgetExceeded, RuntimeError):
            pass
        if not infos and holders is None:
            return {}
        fresh = [w for w, i in infos.items() if i.get("fresh")]
        bots = [w for w, i in infos.items() if i.get("bot")]
        funders = Counter(i["funder"] for i in infos.values() if i.get("funder"))
        dev_funder = (dev or {}).get("funder")
        insiders: set[str] = set()
        clusters = []
        for f, n in funders.items():
            members = [w for w, i in infos.items() if i.get("funder") == f]
            linked = f == L.deployer or (dev_funder and f == dev_funder)
            if n >= 2 or linked:
                insiders |= set(members)
                clusters.append({"funder": f, "wallets": members, "n": len(members),
                                 "link": "dev" if f == L.deployer else "dev's funder" if linked else "shared funder"})
        if dev_funder and dev_funder in infos:
            insiders.add(dev_funder)
        intel = {"ts": now, "scanned": len(infos), "fresh": fresh, "fresh_pct": round(len(fresh) / len(infos) * 100) if infos else None,
                 "bots": len(bots), "insiders": sorted(insiders), "clusters": sorted(clusters, key=lambda c: -c["n"])[:5],
                 "dev_funder": dev_funder, "dev_fresh": bool((dev or {}).get("fresh")), **(holders or {})}
        prev = L.intel or {}
        L.intel = intel
        L.dirty = True
        self.sniper.dirty.add(L.mint)
        sym = L.symbol or L.mint[:6]
        if insiders and len(insiders) >= 3 and len(prev.get("insiders") or []) < 3:
            self.stats["insider_coins"] += 1
            hold = sum(L.balances.get(w, 0.0) for w in insiders) / 1e9 * 100
            await feed.push("helius", "insiders", f"🧬 {len(insiders)} linked wallets in ${sym}",
                            f"funded by the same source{' as the dev' if any(c['link'] != 'shared funder' for c in clusters) else ''} · "
                            f"holding {hold:.0f}% now", L.mint, symbol=L.symbol)
            if L.mint in self.sniper.calls and hold >= 12:
                await self.alerts.send("rug", f"🧬 Insider cluster in called coin {sym}",
                                       f"{len(insiders)} wallets share a funder and hold {hold:.0f}% of supply", token=L.mint,
                                       dedupe=f"insider:{L.mint}", ttl=6 * 3600)
        if intel["fresh_pct"] is not None and intel["fresh_pct"] >= 60 and len(fresh) >= 4 and not prev:
            self.stats["fresh_coins"] += 1
            await feed.push("helius", "fresh", f"🆕 ${sym}: {intel['fresh_pct']}% of early buyers are brand-new wallets",
                            f"{len(fresh)} of {len(infos)} wallets were created in the last 24h", L.mint, symbol=L.symbol)
        return intel
