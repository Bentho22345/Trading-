"""Top Traders: a pool of up to 5,000 real Solana wallets, ranked top 1,000 by realized + unrealized PnL quality.

Every number comes from trades Radar actually observed or fetched — nothing is estimated or invented:
  * PumpPortal: every pump.fun trade on the live stream (+ live account trades of the top wallets)
  * GeckoTerminal: recent trades of the hottest pools (keyless)
  * Birdeye top traders per token (key) — seeds candidates
  * Helius parsed SWAP history (key) — backfills up to 365 days per wallet, valued with daily SOL/USD candles (Coinbase)
  * Your imports: pasted wallet lists or a Dune query (key)
Per-wallet coverage (how far back Radar's data goes) is shown next to every stat.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import statistics
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from .adapters.http import USER_AGENT
from .adapters import geckoterminal as gt
from .health import Health, register
from .hub import hub
from .ratelimit import TokenBucket

log = logging.getLogger("radar.traders")
WSOL = "So11111111111111111111111111111111111111112"
STABLES = {"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"}
B58 = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b")
WINDOWS = {"7d": 7 * 86400, "30d": 30 * 86400, "1y": 365 * 86400}

gecko_trades_h = register(Health("gecko_trades", "rest", "GeckoTerminal pool trades → wallet discovery (keyless)"))
gecko_trades_h.stale_after = 900
helius_bf_h = register(Health("helius_backfill", "rest", "Helius 1-year swap backfill for ranked wallets"))
helius_bf_h.stale_after = 3600
birdeye_h = register(Health("birdeye_traders", "rest", "Birdeye top traders per token"))
birdeye_h.stale_after = 3600
solpx_h = register(Health("sol_history", "rest", "Daily SOL/USD history (Coinbase candles) for valuing old trades"))
solpx_h.stale_after = 2 * 86400
dune_h = register(Health("dune", "rest", "Dune query import of wallet lists"))
dune_h.stale_after = 30 * 86400


def parse_gecko_trades(payload: dict[str, Any], base_token: str) -> list[dict[str, Any]]:
    out = []
    for d in (payload or {}).get("data") or []:
        a = d.get("attributes") or {}
        wallet, kind = a.get("tx_from_address"), a.get("kind")
        if not wallet or kind not in ("buy", "sell"):
            continue
        try:
            amt = float(a["to_token_amount"] if kind == "buy" else a["from_token_amount"])
            usd = float(a.get("volume_in_usd") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        ts = gt._ts(a.get("block_timestamp")) or time.time()
        out.append({"id": f"gt:{a.get('tx_hash')}:{wallet}", "wallet": wallet, "mint": base_token, "ts": ts, "side": kind,
                    "token_amount": amt, "usd": usd, "sol": None, "source": "geckoterminal"})
    return out


def dune_label(row: dict[str, Any]) -> str:
    """'Dune · <name> · PnL $1.2M · WR 64%' from whatever label / profit / win-rate columns the query has."""
    name = next((str(row[k]) for k in ("label", "name", "trader_label", "owner_name", "trader", "ens") if row.get(k) and
                 not B58.fullmatch(str(row[k]))), "")
    parts = [name] if name else []

    def num(keys: tuple[str, ...]) -> float | None:
        for k, v in row.items():
            if any(x in k.lower() for x in keys) and isinstance(v, (int, float)):
                return float(v)
        return None
    pnl = num(("pnl", "profit", "realized"))
    if pnl is not None:
        parts.append(f"PnL ${pnl / 1e6:.1f}M" if abs(pnl) >= 1e6 else f"PnL ${pnl / 1e3:.0f}k" if abs(pnl) >= 1e3 else f"PnL ${pnl:.0f}")
    wr = num(("win_rate", "winrate", "win_pct"))
    if wr is not None:
        parts.append(f"WR {wr * 100 if wr <= 1 else wr:.0f}%")
    return ("Dune · " + " · ".join(parts)) if parts else "Dune"


def parse_helius_swaps(txs: list[dict[str, Any]], wallet: str) -> list[dict[str, Any]]:
    """Helius enhanced transactions (type=SWAP) → per-token buy/sell legs priced in SOL (WSOL counts as SOL)."""
    out = []
    for tx in txs:
        sig, ts = tx.get("signature"), float(tx.get("timestamp") or 0)
        sw = (tx.get("events") or {}).get("swap") or {}
        sol_in = sol_out = 0.0
        tok_in: dict[str, float] = {}
        tok_out: dict[str, float] = {}
        if sw:
            if (sw.get("nativeInput") or {}).get("account") == wallet:
                sol_in += float(sw["nativeInput"].get("amount") or 0) / 1e9
            if (sw.get("nativeOutput") or {}).get("account") == wallet:
                sol_out += float(sw["nativeOutput"].get("amount") or 0) / 1e9
            for leg, bucket in (("tokenInputs", tok_in), ("tokenOutputs", tok_out)):
                for t in sw.get(leg) or []:
                    if t.get("userAccount") not in (None, wallet):
                        continue
                    raw = t.get("rawTokenAmount") or {}
                    try:
                        amt = float(raw.get("tokenAmount") or 0) / (10 ** int(raw.get("decimals") or 0))
                    except (TypeError, ValueError):
                        continue
                    bucket[t.get("mint")] = bucket.get(t.get("mint"), 0) + amt
        else:  # fall back to raw transfers
            for t in tx.get("tokenTransfers") or []:
                amt = float(t.get("tokenAmount") or 0)
                if t.get("fromUserAccount") == wallet:
                    tok_in[t.get("mint")] = tok_in.get(t.get("mint"), 0) + amt
                elif t.get("toUserAccount") == wallet:
                    tok_out[t.get("mint")] = tok_out.get(t.get("mint"), 0) + amt
            for n in tx.get("nativeTransfers") or []:
                amt = float(n.get("amount") or 0) / 1e9
                if n.get("fromUserAccount") == wallet:
                    sol_in += amt
                elif n.get("toUserAccount") == wallet:
                    sol_out += amt
        sol_in += tok_in.pop(WSOL, 0)
        sol_out += tok_out.pop(WSOL, 0)
        usd_in = sum(v for k, v in tok_in.items() if k in STABLES)
        usd_out = sum(v for k, v in tok_out.items() if k in STABLES)
        for k in STABLES:
            tok_in.pop(k, None)
            tok_out.pop(k, None)
        # buy: SOL/USDC in, memecoin out — sell: memecoin in, SOL/USDC out
        if tok_out and (sol_in or usd_in) and not tok_in:
            for mint, amt in tok_out.items():
                out.append({"id": f"h:{sig}:{mint}", "wallet": wallet, "mint": mint, "ts": ts, "side": "buy",
                            "token_amount": amt, "sol": sol_in / len(tok_out), "usd": usd_in / len(tok_out) if usd_in else None,
                            "source": "helius"})
        elif tok_in and (sol_out or usd_out) and not tok_out:
            for mint, amt in tok_in.items():
                out.append({"id": f"h:{sig}:{mint}", "wallet": wallet, "mint": mint, "ts": ts, "side": "sell",
                            "token_amount": amt, "sol": sol_out / len(tok_in), "usd": usd_out / len(tok_in) if usd_out else None,
                            "source": "helius"})
    return out


def extract_addresses(text: str) -> list[tuple[str, str | None]]:
    """Wallets (+ optional label on the same line) from pasted text / CSV."""
    out, seen = [], set()
    for line in (text or "").splitlines():
        m = B58.search(line)
        if not m or m.group(0) in seen:
            continue
        seen.add(m.group(0))
        rest = (line[:m.start()] + " " + line[m.end():]).strip(" ,;\t|-")
        out.append((m.group(0), rest[:40] or None))
    return out


def compute_wallet(rows: list[dict[str, Any]], prices: dict[str, float]) -> dict[str, Any] | None:
    """rows: per-trade dicts for ONE wallet (ts-sorted). Average-cost PnL per token, only for tokens whose buys we saw."""
    per: dict[str, dict[str, Any]] = {}
    for r in rows:
        p = per.setdefault(r["mint"], {"bt": 0.0, "bu": 0.0, "st": 0.0, "su": 0.0, "n": 0, "fb": None, "fs": None, "sells": []})
        p["n"] += 1
        if r["side"] == "buy" and r["usd"] is not None:
            p["bt"] += r["token_amount"] or 0
            p["bu"] += r["usd"]
            p["fb"] = p["fb"] or r["ts"]
        elif r["side"] == "sell" and r["usd"] is not None:
            p["st"] += r["token_amount"] or 0
            p["su"] += r["usd"]
            p["fs"] = p["fs"] or r["ts"]
            p["sells"].append((r["ts"], r["token_amount"] or 0, r["usd"]))
    realized = unreal = invested = volume = 0.0
    wins = losses = 0
    rois, holds, daily = [], [], {}
    span = (rows[-1]["ts"] - rows[0]["ts"]) if rows else 0
    step = 3600 if span < 3 * 86400 else 86400          # hourly points for short histories, daily otherwise
    best = (None, -1e18, 0.0)
    for mint, p in per.items():
        volume += p["bu"] + p["su"]
        if p["bt"] <= 0 or p["bu"] <= 0:
            continue  # bought before Radar's coverage: no honest cost basis → excluded
        cost = p["bu"] / p["bt"]
        sold = min(p["st"], p["bt"])
        frac = sold / p["st"] if p["st"] else 0
        r_pnl = p["su"] * frac - cost * sold
        rem = p["bt"] - sold
        u_pnl = (prices[mint] - cost) * rem if rem > 0 and mint in prices else 0.0
        invested += p["bu"]
        realized += r_pnl
        unreal += u_pnl
        roi = (r_pnl + u_pnl) / p["bu"]
        rois.append(roi)
        if sold >= 0.9 * p["bt"]:
            wins += r_pnl > 0
            losses += r_pnl <= 0
        if p["fb"] and p["fs"]:
            holds.append(p["fs"] - p["fb"])
        if roi > best[1]:
            best = (mint, roi, r_pnl + u_pnl)
        for ts, amt, usd in p["sells"]:
            b = int(ts // step)
            daily[b] = daily.get(b, 0.0) + (usd - cost * amt) * (min(amt, p["bt"]) / amt if amt else 0)
    if not rois:
        return None
    acc, series = 0.0, []
    if daily:
        series.append([(min(daily) - 1) * step, 0.0])      # start the curve at zero
    for b in sorted(daily):
        acc += daily[b]
        series.append([b * step, round(acc, 2)])
    closed = wins + losses
    return {"realized_usd": round(realized, 2), "unrealized_usd": round(unreal, 2), "pnl_usd": round(realized + unreal, 2),
            "volume_usd": round(volume, 2), "invested_usd": round(invested, 2), "trades": sum(p["n"] for p in per.values()),
            "tokens": len(rois), "wins": wins, "losses": losses,
            "win_rate": round(wins / closed * 100, 1) if closed else None,
            "roi": round((realized + unreal) / invested * 100, 1) if invested else None,
            "median_roi": round(statistics.median(rois) * 100, 1), "best_roi": round(best[1] * 100, 1), "best_token": best[0],
            "best_pnl_usd": round(best[2], 2), "avg_hold_s": round(sum(holds) / len(holds), 0) if holds else None,
            "series": series[-60:], "closed": closed}


def score(s: dict[str, Any], last_trade: float, now: float) -> tuple[float | None, list[str]]:
    """Composite rank score. None = not eligible for the leaderboard (too little data, or bot-like)."""
    flags = []
    if s["tokens"] < 3 or s["trades"] < 5:
        return None, ["too few trades"]
    if s["trades"] / max(1, s["tokens"]) > 150 or (s["avg_hold_s"] is not None and s["avg_hold_s"] < 15 and s["tokens"] > 30):
        return None, ["bot-like (MEV/sniper pattern)"]
    pnl = s["pnl_usd"]
    pnl_c = math.copysign(math.log10(1 + abs(pnl)), pnl) * 10            # ±60 for ±$1M
    wr = (s["wins"] + 1) / (s["closed"] + 2) if s["closed"] is not None else 0.5   # Bayesian-smoothed win rate
    roi_c = max(-10, min(15, (s["median_roi"] or 0) / 10))
    cons = min(12, math.log2(1 + s["tokens"]) * 2)
    sc = pnl_c + wr * 30 + roi_c + cons
    if now - last_trade > 30 * 86400:
        sc *= 0.8
        flags.append("inactive 30d+")
    return round(sc, 2), flags


class Traders:
    def __init__(self, db: Any, tracker: Any, connectors: Any, alerts: Any, cfg: Any) -> None:
        self.db, self.tracker, self.connectors, self.alerts, self.cfg = db, tracker, connectors, alerts, cfg
        self.cap = 5000
        self.top_n = 1000
        self.live_n = 500
        self.min_usd_admit = 150.0
        self.ranked: dict[str, dict[str, Any]] = {}      # address -> {rank, score, label} for 30d
        self.followed: set[str] = set()
        self.extra_live: set[str] = set()                # SmartMoney contributes its KOL/smart wallets
        self.smart: Any = None
        self.client = httpx.AsyncClient(timeout=20, headers={"User-Agent": USER_AGENT})
        self.gecko_bucket = TokenBucket(float(__import__("os").environ.get("TRADER_GECKO_RPM", "6")), burst=1)
        self.helius_calls_today = 0
        self.helius: Any = None
        self.helius_day = int(time.time() // 86400)
        self.sol_days: dict[int, float] = {}
        self.known: set[str] | None = None              # every wallet in the pool, so most trades skip the DB entirely

    # ---------------- ingestion ----------------
    async def sol_usd_at(self, ts: float) -> float | None:
        day = int(ts // 86400)
        if day >= int(time.time() // 86400) - 1 and self.tracker.sol_usd:
            return self.tracker.sol_usd
        if day in self.sol_days:
            return self.sol_days[day]
        for d in (day - 1, day + 1, day - 2):
            if d in self.sol_days:
                return self.sol_days[d]
        return self.tracker.sol_usd

    async def record(self, trades: list[dict[str, Any]], admit: bool = True) -> int:
        n = 0
        now = time.time()
        for t in trades:
            if t.get("usd") is None and t.get("sol") is not None:
                px = await self.sol_usd_at(t["ts"])
                t["usd"] = t["sol"] * px if px else None
            if not t.get("wallet") or not t.get("mint") or t.get("usd") is None:
                continue
            if self.known is None:
                self.known = {r["address"] for r in await self.db.all("SELECT address FROM traders")}
            known = t["wallet"] in self.known
            if not known:
                if not admit or t["usd"] < self.min_usd_admit:
                    continue
                await self.db.exec("INSERT OR IGNORE INTO traders (address, sources_json, first_seen, last_active) VALUES (?,?,?,?)",
                                   (t["wallet"], json.dumps([t["source"]]), now, t["ts"]))
                self.known.add(t["wallet"])
            else:
                await self.db.exec("UPDATE traders SET last_active=MAX(COALESCE(last_active,0), ?), sources_json=CASE WHEN "
                                   "instr(COALESCE(sources_json,''), ?)=0 THEN json_insert(COALESCE(sources_json,'[]'), '$[#]', ?) "
                                   "ELSE sources_json END WHERE address=?", (t["ts"], f'"{t["source"]}"', t["source"], t["wallet"]))
            cur = await self.db.exec("INSERT OR IGNORE INTO trader_trades (id, wallet, mint, ts, side, token_amount, usd, sol, source) "
                                     "VALUES (?,?,?,?,?,?,?,?,?)", (t["id"], t["wallet"], t["mint"], t["ts"], t["side"],
                                                                     t.get("token_amount"), round(t["usd"], 4), t.get("sol"), t["source"]))
            n += 1
            r = self.ranked.get(t["wallet"])
            if (r or t["wallet"] in self.followed) and now - t["ts"] < 600 and cur:
                tok = await self.db.one("SELECT symbol, name, image FROM tokens WHERE address=?", (t["mint"],)) or {}
                ev = {"wallet": t["wallet"], "label": (r or {}).get("label"), "rank": (r or {}).get("rank"), "side": t["side"],
                      "mint": t["mint"], "symbol": tok.get("symbol"), "image": tok.get("image"), "usd": round(t["usd"], 2),
                      "ts": t["ts"], "followed": t["wallet"] in self.followed}
                await hub.publish("trader_trade", ev)
                if t["wallet"] in self.followed:
                    who = (r or {}).get("label") or f"{t['wallet'][:4]}…{t['wallet'][-4:]}"
                    await self.alerts.send("info", f"👁 {who} {'bought' if t['side'] == 'buy' else 'sold'} {tok.get('symbol') or t['mint'][:6]} "
                                                   f"(${t['usd']:,.0f})", f"Followed wallet {t['wallet']}", token=t["mint"],
                                           dedupe=f"follow:{t['id']}", ttl=3600)
        return n

    async def on_pump_trade(self, t: dict[str, Any]) -> None:
        if not t.get("trader") or t.get("sol") is None:
            return
        await self.record([{"id": f"pp:{t['signature']}", "wallet": t["trader"], "mint": t["mint"], "ts": t["ts"], "side": t["side"],
                            "token_amount": t.get("tokens"), "sol": t["sol"], "usd": None, "source": "pumpportal"}])

    async def harvest_gecko_loop(self) -> None:
        """Pull recent trades of the hottest Solana pools; every wallet trading ≥ $150 becomes a candidate."""
        i = 0
        while True:
            try:
                pools = await self.db.all(
                    "SELECT t.address mint, t.best_pair pool FROM tokens t JOIN pairs p ON p.pair_address=t.best_pair "
                    "WHERE t.chain='solana' AND p.as_of > ? ORDER BY p.vol_h1 DESC LIMIT 60", (time.time() - 1800,))
                if pools:
                    pick = pools[i % len(pools)]
                    i += 1
                    await self.gecko_bucket.acquire()
                    t0 = time.perf_counter()
                    d = await self.tracker.gecko.http.get(f"/networks/solana/pools/{pick['pool']}/trades", gt.bucket,
                                                          params={"trade_volume_in_usd_greater_than": 50}, not_found_ok=True)
                    gecko_trades_h.ok((time.perf_counter() - t0) * 1000)
                    if d:
                        await self.record(parse_gecko_trades(d, pick["mint"]))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                gecko_trades_h.fail(f"{type(e).__name__}: {e}")
            await asyncio.sleep(float(__import__("os").environ.get("TRADER_HARVEST_EVERY", "10")))

    async def harvest_birdeye_loop(self) -> None:
        """Birdeye (key): its own trader leaderboards (gainers by PnL, this week / today / yesterday) + each hot coin's top
        traders. These seed the pool; Radar then computes every stat itself from the trades (Helius backfill + live)."""
        while True:
            try:
                key = (await self.connectors.values("birdeye")).get("api_key")
                if key:
                    hdr = {"X-API-KEY": key, "x-chain": "solana"}
                    for btype in ("1W", "today", "yesterday"):
                        for page in range(10):                      # up to 100 wallets per period
                            r = await self.client.get("https://public-api.birdeye.so/trader/gainers-losers", headers=hdr,
                                                      params={"type": btype, "sort_by": "PnL", "sort_type": "desc", "offset": page * 10, "limit": 10})
                            if r.status_code >= 400:
                                birdeye_h.fail(f"gainers HTTP {r.status_code}")
                                break
                            birdeye_h.ok()
                            items = ((r.json().get("data") or {}).get("items")) or []
                            for it in items:
                                if it.get("address"):
                                    await self.add_candidate(it["address"], "birdeye_leaderboard")
                            if len(items) < 10:
                                break
                            await asyncio.sleep(1.2)
                    for tok in await self.db.all("SELECT t.address FROM tokens t JOIN pairs p ON p.pair_address=t.best_pair WHERE "
                                                 "t.chain='solana' AND p.as_of > ? ORDER BY p.vol_h24 DESC LIMIT 20", (time.time() - 3600,)):
                        r = await self.client.get("https://public-api.birdeye.so/defi/v2/tokens/top_traders", headers=hdr,
                                                  params={"address": tok["address"], "time_frame": "24h", "sort_type": "desc",
                                                          "sort_by": "volume", "offset": 0, "limit": 10})
                        if r.status_code >= 400:
                            birdeye_h.fail(f"top_traders HTTP {r.status_code}")
                            break
                        birdeye_h.ok()
                        for it in ((r.json().get("data") or {}).get("items") or []):
                            if it.get("owner") and "bot" not in (it.get("tags") or []):
                                await self.add_candidate(it["owner"], "birdeye")
                        await asyncio.sleep(1.2)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                birdeye_h.fail(f"{type(e).__name__}: {e}")
            await asyncio.sleep(3600)

    async def add_candidate(self, addr: str, source: str, label: str | None = None, pinned: bool = False) -> None:
        await self.db.exec("INSERT INTO traders (address, label, sources_json, first_seen, pinned) VALUES (?,?,?,?,?) ON CONFLICT(address) "
                           "DO UPDATE SET label=COALESCE(excluded.label, label), pinned=MAX(pinned, excluded.pinned), "
                           "sources_json=CASE WHEN instr(COALESCE(sources_json,''), ?)=0 THEN json_insert(COALESCE(sources_json,'[]'), '$[#]', ?) "
                           "ELSE sources_json END", (addr, label, json.dumps([source]), time.time(), 1 if pinned else 0,
                                                    f'"{source}"', source))
        if self.known is not None:
            self.known.add(addr)

    async def import_text(self, text: str, source: str = "import") -> int:
        rows = extract_addresses(text)
        for addr, label in rows:
            await self.add_candidate(addr, source, label, pinned=True)
        return len(rows)

    async def import_dune(self, query_id: str, label: str | None = None) -> int:
        """Pull a Dune query's latest saved results (cheap: reading results doesn't re-run the query). The query is
        remembered and re-pulled every 12h, so a 'top Solana memecoin traders' query keeps the pool fresh by itself."""
        m = re.search(r"(\d{3,})", str(query_id))
        if not m:
            raise ValueError("Paste a Dune query number or link, e.g. dune.com/queries/1234567")
        qid = int(m.group(1))
        key = (await self.connectors.values("dune")).get("api_key")
        if not key:
            raise ValueError("Add your Dune API key on Connectors first")
        base = __import__("os").environ.get("DUNE_API_URL", "https://api.dune.com")
        r = await self.client.get(f"{base}/api/v1/query/{qid}/results", params={"limit": 5000}, headers={"X-Dune-API-Key": key})
        saved = {q["id"]: q for q in await self.dune_queries()}
        q = saved.get(qid) or {"id": qid, "label": label, "added": time.time()}
        q["pulled"] = time.time()
        if r.status_code >= 400:
            dune_h.fail(f"HTTP {r.status_code}: {r.text[:120]}")
            q["error"] = f"HTTP {r.status_code}"
            saved[qid] = q
            await self.cfg.kv_set("dune:queries", list(saved.values()))
            raise ValueError(f"Dune: HTTP {r.status_code} — check the query id, and run it once on dune.com so it has results")
        dune_h.ok()
        res = r.json()
        rows = ((res.get("result") or {}).get("rows")) or []
        lines = []
        for row in rows:
            addr = next((str(v) for v in row.values() if isinstance(v, str) and B58.fullmatch(v)), None)
            if addr:
                lines.append(f"{addr} {dune_label(row)}".strip())
        n = await self.import_text("\n".join(lines), "dune")
        q.update({"rows": len(rows), "wallets": n, "error": None, "label": label or q.get("label"),
                  "columns": list(rows[0].keys())[:12] if rows else [], "executed_at": res.get("execution_ended_at")})
        saved[qid] = q
        await self.cfg.kv_set("dune:queries", list(saved.values()))
        await __import__("radar.feed", fromlist=["push"]).push("dune", "import", f"🔮 Dune query {qid}: {n} wallets in the pool",
                                                                 q.get("label") or "")
        return n

    async def dune_queries(self) -> list[dict[str, Any]]:
        return list(await self.cfg.kv_get("dune:queries", []) or [])

    async def forget_dune(self, qid: int) -> None:
        await self.cfg.kv_set("dune:queries", [q for q in await self.dune_queries() if q["id"] != qid])

    async def dune_loop(self) -> None:
        await asyncio.sleep(90)
        while True:
            try:
                for q in await self.dune_queries():
                    if time.time() - (q.get("pulled") or 0) > 12 * 3600:
                        try:
                            await self.import_dune(str(q["id"]))
                        except ValueError as e:
                            log.info("dune refresh %s: %s", q["id"], e)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                dune_h.fail(f"{type(e).__name__}: {e}")
            await asyncio.sleep(1800)

    # ---------------- Helius 1-year backfill ----------------
    async def load_sol_history(self) -> None:
        now = int(time.time())
        days: dict[int, float] = {}
        for start in (now - 365 * 86400, now - 200 * 86400):
            end = min(now, start + 299 * 86400)
            try:
                r = await self.client.get("https://api.exchange.coinbase.com/products/SOL-USD/candles",
                                          params={"granularity": 86400, "start": datetime.fromtimestamp(start, timezone.utc).isoformat(),
                                                  "end": datetime.fromtimestamp(end, timezone.utc).isoformat()})
                r.raise_for_status()
                solpx_h.ok()
                for c in r.json():
                    days[int(c[0] // 86400)] = float(c[4])
            except Exception as e:  # noqa: BLE001
                solpx_h.fail(f"{type(e).__name__}: {e}")
        if days:
            await self.db.many("INSERT OR REPLACE INTO sol_prices (day, usd) VALUES (?,?)", list(days.items()))
        self.sol_days = {r["day"]: r["usd"] for r in await self.db.all("SELECT day, usd FROM sol_prices")}

    async def backfill_loop(self) -> None:
        await self.load_sol_history()
        last_px = time.time()
        while True:
            try:
                if time.time() - last_px > 86400:
                    await self.load_sol_history()
                    last_px = time.time()
                hl = self.helius
                day = int(time.time() // 86400)
                if day != self.helius_day:
                    self.helius_day, self.helius_calls_today = day, 0
                if hl is None or not hl.enabled or not hl.can("backfill", 100):
                    helius_bf_h.last_error_msg = ("add a Helius key to backfill 1-year history" if hl is None or not hl.enabled
                                                  else "waiting for Helius budget (Engines page)")
                    await asyncio.sleep(60)
                    continue
                w = await self.db.one(
                    "SELECT t.address, t.backfill_cursor FROM traders t LEFT JOIN trader_stats s ON s.address=t.address AND s.win='30d' "
                    "WHERE t.backfill_done=0 ORDER BY t.pinned DESC, t.followed DESC, COALESCE(s.rank, 1e9), t.last_active DESC LIMIT 1")
                if not w:
                    await asyncio.sleep(120)
                    continue
                params = {"type": "SWAP", "limit": 100}
                if w["backfill_cursor"]:
                    params["before"] = w["backfill_cursor"]
                t0 = time.perf_counter()
                try:
                    txs = await hl.enhanced(f"/v0/addresses/{w['address']}/transactions", params, "backfill")
                except __import__("radar.helius", fromlist=["BudgetExceeded"]).BudgetExceeded:
                    helius_bf_h.fail("Helius rate limit / budget", rate_limited=True)
                    await asyncio.sleep(30)
                    continue
                self.helius_calls_today += 1
                helius_bf_h.ok((time.perf_counter() - t0) * 1000)
                legs = parse_helius_swaps(txs, w["address"])
                await self.record(legs, admit=False)
                oldest = min((float(t.get("timestamp") or time.time()) for t in txs), default=None)
                done = not txs or (oldest is not None and oldest < time.time() - 365 * 86400)
                await self.db.exec("UPDATE traders SET backfill_cursor=?, backfill_oldest=MIN(COALESCE(backfill_oldest, 9e18), ?), "
                                   "backfill_done=? WHERE address=?", (txs[-1]["signature"] if txs else w["backfill_cursor"],
                                                                     oldest or time.time(), 1 if done else 0, w["address"]))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                helius_bf_h.fail(f"{type(e).__name__}: {e}")
                await asyncio.sleep(10)
            await asyncio.sleep(0.4)

    # ---------------- stats / ranking ----------------
    async def compute(self) -> dict[str, int]:
        now = time.time()
        prices = {r["address"]: r["price_usd"] for r in await self.db.all(
            "SELECT t.address, p.price_usd FROM tokens t JOIN pairs p ON p.pair_address=t.best_pair WHERE p.as_of > ? AND p.price_usd > 0",
            (now - 3600,))}
        labels = {r["address"]: r for r in await self.db.all("SELECT address, label, flags, followed FROM traders")}
        counts = {}
        for win, span in WINDOWS.items():
            since = now - span
            rows = await self.db.all("SELECT wallet, mint, ts, side, token_amount, usd FROM trader_trades WHERE ts > ? ORDER BY wallet, ts",
                                     (since,))
            by: dict[str, list] = {}
            for r in rows:
                by.setdefault(r["wallet"], []).append(r)
            results = []
            for addr, trs in by.items():
                s = compute_wallet(trs, prices)
                if not s:
                    continue
                last = trs[-1]["ts"]
                sc, flags = score(s, last, now)
                results.append((addr, s, sc, flags, trs[0]["ts"], last))
            results.sort(key=lambda x: -(x[2] if x[2] is not None else -1e9))
            await self.db.exec("DELETE FROM trader_stats WHERE win=?", (win,))
            batch = []
            rank = 0
            for addr, s, sc, flags, first, last in results:
                rk = None
                if sc is not None and rank < self.top_n:
                    rank += 1
                    rk = rank
                batch.append((addr, win, s["realized_usd"], s["unrealized_usd"], s["pnl_usd"], s["volume_usd"], s["invested_usd"],
                              s["trades"], s["tokens"], s["wins"], s["losses"], s["win_rate"], s["roi"], s["median_roi"], s["best_roi"],
                              s["best_token"], s["best_pnl_usd"], s["avg_hold_s"], sc, rk, first, last, json.dumps(s["series"]),
                              json.dumps(flags), now))
            await self.db.many("INSERT INTO trader_stats (address, win, realized_usd, unrealized_usd, pnl_usd, volume_usd, invested_usd, trades, "
                               "tokens, wins, losses, win_rate, roi, median_roi, best_roi, best_token, best_pnl_usd, avg_hold_s, score, rank, "
                               "coverage_from, last_trade, series_json, flags, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                               batch)
            counts[win] = rank
        self.ranked = {r["address"]: {"rank": r["rank"], "score": r["score"], "label": (labels.get(r["address"]) or {}).get("label")}
                       for r in await self.db.all("SELECT address, rank, score FROM trader_stats WHERE win='30d' AND rank IS NOT NULL")}
        self.followed = {a for a, r in labels.items() if r["followed"]}
        if self.smart is not None:
            rows = await self.db.all("SELECT address, rank, roi FROM trader_stats WHERE win='30d' AND rank IS NOT NULL ORDER BY rank LIMIT ?",
                                     (self.live_n,))
            self.smart.also_follow = {r["address"]: {"rank": r["rank"], "period": "30d", "roi": (r["roi"] or 0) / 100 if r["roi"] is not None else None}
                                      for r in rows}
        await self.refresh_live()
        await hub.publish("traders_ranked", {"as_of": now, "counts": counts})
        return counts

    async def refresh_live(self) -> None:
        top = sorted(self.ranked, key=lambda a: self.ranked[a]["rank"])[: self.live_n]
        await self.tracker.pump.set_account_trades(set(top) | self.followed | self.extra_live)

    async def prune(self) -> int:
        """Keep the pool at ≤ 5,000: pinned + followed + ranked first, then the most active."""
        total = (await self.db.one("SELECT COUNT(*) n FROM traders"))["n"]
        if total <= self.cap:
            return 0
        keep = await self.db.all(
            "SELECT t.address FROM traders t LEFT JOIN trader_stats s ON s.address=t.address AND s.win='30d' "
            "LEFT JOIN (SELECT wallet, SUM(usd) v FROM trader_trades GROUP BY wallet) tv ON tv.wallet=t.address "
            "ORDER BY t.pinned DESC, t.followed DESC, (s.rank IS NOT NULL) DESC, COALESCE(s.score, -1) DESC, COALESCE(tv.v, 0) DESC LIMIT ?",
            (self.cap,))
        await self.db.exec("CREATE TEMP TABLE IF NOT EXISTS keep_wallets (address TEXT PRIMARY KEY)")
        await self.db.exec("DELETE FROM keep_wallets")
        await self.db.many("INSERT INTO keep_wallets VALUES (?)", [(r["address"],) for r in keep])
        await self.db.exec("DELETE FROM trader_trades WHERE wallet NOT IN (SELECT address FROM keep_wallets)")
        await self.db.exec("DELETE FROM trader_stats WHERE address NOT IN (SELECT address FROM keep_wallets)")
        await self.db.exec("DELETE FROM traders WHERE address NOT IN (SELECT address FROM keep_wallets)")
        self.known = None   # reload the in-memory set on next use
        return total - self.cap

    async def compute_loop(self) -> None:
        every = float(__import__("os").environ.get("TRADER_COMPUTE_EVERY", "180"))
        await asyncio.sleep(min(20, every))
        while True:
            try:
                await self.prune()
                await self.compute()
                await self.db.exec("DELETE FROM trader_trades WHERE ts < ?", (time.time() - 370 * 86400,))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("trader compute: %s", e)
            await asyncio.sleep(every)

    # ---------------- read models ----------------
    async def leaderboard(self, win: str = "30d", sort: str = "rank", limit: int = 100, offset: int = 0, q: str = "",
                          followed_only: bool = False, min_tokens: int = 0) -> dict[str, Any]:
        order = {"rank": "s.rank ASC", "pnl": "s.pnl_usd DESC", "roi": "s.roi DESC", "win_rate": "s.win_rate DESC",
                 "volume": "s.volume_usd DESC", "recent": "s.last_trade DESC"}.get(sort, "s.rank ASC")
        where, args = ["s.win=?", "s.rank IS NOT NULL"], [win if win in WINDOWS else "30d"]
        if q:
            where.append("(t.address LIKE ? OR t.label LIKE ?)")
            args += [f"%{q}%", f"%{q}%"]
        if followed_only:
            where.append("t.followed=1")
        if min_tokens:
            where.append("s.tokens >= ?")
            args.append(min_tokens)
        rows = await self.db.all(f"SELECT s.*, t.label, t.followed, t.sources_json, t.backfill_oldest, t.backfill_done, tk.symbol best_symbol "
                                 f"FROM trader_stats s JOIN traders t ON t.address=s.address LEFT JOIN tokens tk ON tk.address=s.best_token "
                                 f"WHERE {' AND '.join(where)} ORDER BY {order} NULLS LAST LIMIT ? OFFSET ?", [*args, min(limit, 500), offset])
        total = await self.db.one(f"SELECT COUNT(*) n FROM trader_stats s JOIN traders t ON t.address=s.address WHERE {' AND '.join(where)}", args)
        pool = await self.db.one("SELECT COUNT(*) n FROM traders")
        for r in rows:
            r["series"] = json.loads(r.pop("series_json") or "[]")
            r["sources"] = json.loads(r.pop("sources_json") or "[]")
            r["flags"] = json.loads(r.pop("flags") or "[]")
        return {"rows": rows, "total": total["n"], "pool": pool["n"], "cap": self.cap, "top_n": self.top_n, "win": win}

    async def summary(self) -> dict[str, Any]:
        now = time.time()
        pool = (await self.db.one("SELECT COUNT(*) n FROM traders"))["n"]
        ranked = (await self.db.one("SELECT COUNT(*) n FROM trader_stats WHERE win='30d' AND rank IS NOT NULL"))["n"]
        ranked_set = "(SELECT address FROM trader_stats WHERE win='30d' AND rank IS NOT NULL)"
        act = await self.db.one(f"SELECT COUNT(*) n, COALESCE(SUM(usd),0) v, COUNT(DISTINCT wallet) w FROM trader_trades WHERE ts > ? AND wallet IN {ranked_set}",
                                (now - 86400,))
        last_hour = (await self.db.one(f"SELECT COUNT(*) n FROM trader_trades WHERE ts > ? AND wallet IN {ranked_set}", (now - 3600,)))["n"]
        flows = {}
        for key, span in (("1h", 3600), ("24h", 86400)):
            flows[key] = await self.db.all(
                f"SELECT tt.mint, SUM(CASE WHEN side='buy' THEN usd ELSE -usd END) net, SUM(CASE WHEN side='buy' THEN usd ELSE 0 END) bought, "
                f"COUNT(DISTINCT CASE WHEN side='buy' THEN wallet END) buyers, COUNT(DISTINCT CASE WHEN side='sell' THEN wallet END) sellers, "
                f"tk.symbol, tk.name, tk.image, p.price_usd, p.chg_h1, p.market_cap, p.liquidity_usd FROM trader_trades tt "
                f"LEFT JOIN tokens tk ON tk.address=tt.mint LEFT JOIN pairs p ON p.pair_address=tk.best_pair "
                f"WHERE tt.ts > ? AND tt.wallet IN {ranked_set} GROUP BY tt.mint HAVING buyers >= 1 ORDER BY buyers DESC, net DESC LIMIT 12",
                (now - span,))
        recent = await self.db.all(
            f"SELECT tt.wallet, tt.mint, tt.ts, tt.side, tt.usd, s.rank, t.label, tk.symbol, tk.image FROM trader_trades tt "
            f"JOIN trader_stats s ON s.address=tt.wallet AND s.win='30d' AND s.rank IS NOT NULL JOIN traders t ON t.address=tt.wallet "
            f"LEFT JOIN tokens tk ON tk.address=tt.mint ORDER BY tt.ts DESC LIMIT 40")
        top = (await self.leaderboard("30d", limit=10))["rows"]
        pnl_total = await self.db.one("SELECT COALESCE(SUM(pnl_usd),0) p FROM trader_stats WHERE win='30d' AND rank IS NOT NULL")
        return {"as_of": now, "pool": pool, "cap": self.cap, "ranked": ranked, "top_n": self.top_n, "trades_24h": act["n"],
                "volume_24h": act["v"], "active_24h": act["w"], "trades_1h": last_hour, "pnl_30d_total": pnl_total["p"],
                "flows": flows, "recent": recent, "top": top, "live_followed": min(len(self.ranked), self.live_n)}

    async def wallet(self, addr: str) -> dict[str, Any]:
        t = await self.db.one("SELECT * FROM traders WHERE address=?", (addr,))
        stats = {r["win"]: {**r, "series": json.loads(r.pop("series_json") or "[]"), "flags": json.loads(r.pop("flags") or "[]")}
                 for r in await self.db.all("SELECT * FROM trader_stats WHERE address=?", (addr,))}
        positions = await self.db.all(
            "SELECT tt.mint, tk.symbol, tk.name, tk.image, p.price_usd, p.chg_h1, SUM(CASE WHEN side='buy' THEN token_amount ELSE 0 END) bt, "
            "SUM(CASE WHEN side='buy' THEN usd ELSE 0 END) bu, SUM(CASE WHEN side='sell' THEN token_amount ELSE 0 END) st, "
            "SUM(CASE WHEN side='sell' THEN usd ELSE 0 END) su, MIN(tt.ts) first, MAX(tt.ts) last, COUNT(*) n FROM trader_trades tt "
            "LEFT JOIN tokens tk ON tk.address=tt.mint LEFT JOIN pairs p ON p.pair_address=tk.best_pair WHERE tt.wallet=? "
            "GROUP BY tt.mint ORDER BY last DESC LIMIT 200", (addr,))
        for p in positions:
            cost = p["bu"] / p["bt"] if p["bt"] else None
            sold = min(p["st"], p["bt"]) if p["bt"] else 0
            p["realized_usd"] = round(p["su"] * (sold / p["st"]) - cost * sold, 2) if cost and p["st"] else None
            rem = (p["bt"] or 0) - sold
            p["holding_tokens"] = rem if p["bt"] else None
            p["unrealized_usd"] = round((p["price_usd"] - cost) * rem, 2) if cost and p["price_usd"] and rem > 0 else None
            p["roi"] = round(((p["realized_usd"] or 0) + (p["unrealized_usd"] or 0)) / p["bu"] * 100, 1) if p["bu"] else None
            p["cost_basis_known"] = bool(p["bt"])
        trades = await self.db.all("SELECT tt.*, tk.symbol FROM trader_trades tt LEFT JOIN tokens tk ON tk.address=tt.mint WHERE tt.wallet=? "
                                   "ORDER BY tt.ts DESC LIMIT 200", (addr,))
        if t:
            t["sources"] = json.loads(t.pop("sources_json") or "[]")
        return {"trader": t, "stats": stats, "positions": positions, "trades": trades}

    async def follow(self, addr: str, on: bool, label: str | None = None) -> None:
        await self.add_candidate(addr, "follow", label)
        await self.db.exec("UPDATE traders SET followed=?, label=COALESCE(?, label) WHERE address=?", (1 if on else 0, label, addr))
        (self.followed.add if on else self.followed.discard)(addr)
        await self.refresh_live()

    async def smart_input(self, mint: str) -> dict[str, Any]:
        r = await self.db.one("SELECT COUNT(DISTINCT tt.wallet) n FROM trader_trades tt JOIN trader_stats s ON s.address=tt.wallet "
                              "AND s.win='30d' AND s.rank <= 1000 WHERE tt.mint=? AND tt.side='buy' AND tt.ts > ?", (mint, time.time() - 3600))
        return {"tracking": bool(self.ranked), "smart_buyers": r["n"] if r else 0}
