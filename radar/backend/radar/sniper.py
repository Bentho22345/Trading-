"""Snipe engine: scores every pump.fun launch in real time, from its first trade, and proves itself.

Runs entirely in memory on the PumpPortal stream (no DB read on the hot path), so a launch is scored and pushed to
the UI within milliseconds of each trade. Six detectors, all measured from real data Radar observes:

  alpha     Alpha entry — Top Traders (ranked from real P&L) or followed / smart wallets buying in the first minutes
  velocity  Curve velocity — SOL flowing into the bonding curve per minute, buyer acceleration, and the projected
            time to graduation (ETA) from the curve's actual trajectory
  organic   Organic flow — distinct buyers vs bundles: same-second multi-wallet buys, identical bot-sized buys,
            and how concentrated the buy volume is
  dev       Dev track record — every launch by this deployer that Radar saw in the last 30 days: how many
            graduated and how high they went; plus whether the dev is dumping right now
  meta      Meta match & clones — the name fits a meta that is hot right now, or copies a ticker that is trending
  social    Social spread — distinct authors / sources posting the contract or $ticker, and whether a VIP did

The first time a launch reaches SNIPE it is logged to `snipe_calls` with every input, then its real outcome is tracked
(peak, value 5m / 15m / 1h later, graduation, first appearance on public trending lists) for the Proof page.
Nothing here trades: Radar never holds keys.
"""
from __future__ import annotations

import asyncio
import json
import logging
import statistics
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from typing import Any

from . import snipe_metrics as sm
from .hub import hub
from .tracker import CURVE_END_SOL, CURVE_START_SOL, curve_progress

log = logging.getLogger("radar.sniper")

TRACK_S = 30 * 60          # keep scoring a launch for 30 minutes (longer once it is called)
CALL_TRACK_S = 24 * 3600   # follow a called coin's outcome for 24h
MIN_TRADES_FOR_CALL = 8
MIN_BUYERS_FOR_CALL = 5
MIN_AGE_FOR_CALL = 12.0
SNIPE_AT, WATCH_AT = 60.0, 35.0
COMMON_TICKERS = {"SOL", "USDC", "USDT", "BTC", "ETH", "PUMP", "MEME", "AI", "CTO", "DEV", "THE", "CAT", "DOG"}


@dataclass
class Launch:
    mint: str
    created: float
    symbol: str | None = None
    name: str | None = None
    deployer: str | None = None
    dev_buy_sol: float = 0.0
    dev_buy_pct: float | None = None
    dev_tokens: float = 0.0
    dev_sold_tokens: float = 0.0
    vsol: float | None = None
    mcap_sol: float | None = None
    peak_mcap_sol: float = 0.0
    graduated_at: float | None = None
    trades: deque = field(default_factory=lambda: deque(maxlen=1500))   # (ts, side, sol, tokens, trader, vsol)
    buyers: dict[str, float] = field(default_factory=dict)             # trader -> first buy ts
    buy_sol: dict[str, float] = field(default_factory=dict)            # trader -> SOL bought
    alpha: list[dict[str, Any]] = field(default_factory=list)
    meta: list[dict[str, Any]] = field(default_factory=list)
    clone_of: dict[str, Any] | None = None
    dev: dict[str, Any] | None = None
    result: dict[str, Any] = field(default_factory=dict)
    last_eval: float = 0.0
    last_pub: float = 0.0
    dirty: bool = True
    until: float = 0.0
    balances: dict[str, float] = field(default_factory=dict)          # wallet -> tokens held (from the trade stream)
    early: set[str] = field(default_factory=set)                       # bought in the first 5s (snipers)
    bundlers: set[str] = field(default_factory=set)                    # several wallets taking supply in the creation block
    pros: set[str] = field(default_factory=set)                        # buyers who are in the Top Traders pool
    metadata: dict[str, Any] = field(default_factory=dict)             # socials / description from the coin's metadata URI
    uri: str | None = None
    hits: dict[str, float] = field(default_factory=dict)               # strategy id -> first match ts
    block: set[str] = field(default_factory=set)                       # buyers in the first 2.5s
    observed_sol: float = 0.0                                          # net SOL seen trading (coverage check), kept incrementally
    early_frozen: dict[str, Any] | None = None                         # launch-window stats, fixed once the window has passed
    intel: dict[str, Any] | None = None                                # on-chain scan (Helius): fresh wallets, insider clusters, chain top-10
    ai: dict[str, Any] | None = None                                   # Claude's batch read: narrative, meme score, red flags
    yt: dict[str, Any] | None = None                                   # YouTube videos mentioning the coin (last 48h)
    x: dict[str, Any] | None = None                                    # the tweet this launch was spawned from (X Radar coin race)


def _slope(pts: list[tuple[float, float]]) -> float:
    """Least-squares slope (units per second)."""
    if len(pts) < 2:
        return 0.0
    n = len(pts)
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    den = sum((p[0] - mx) ** 2 for p in pts)
    return sum((p[0] - mx) * (p[1] - my) for p in pts) / den if den else 0.0


def analyze(L: Launch, now: float, ctx: dict[str, Any]) -> dict[str, Any]:
    """Pure scoring of one launch. `ctx` carries the live context: social spread, ranked wallets, etc."""
    det: list[dict[str, Any]] = []
    flags: list[str] = []
    trades = list(L.trades)
    buys = [t for t in trades if t[1] == "buy" and t[4] != L.deployer]
    sells = [t for t in trades if t[1] == "sell"]
    age = max(0.0, now - L.created)

    # 1 · alpha entry -------------------------------------------------------------------------------------------
    pts = 0.0
    if L.alpha:
        ranks = sorted(a["rank"] for a in L.alpha if a.get("rank"))
        best = ranks[0] if ranks else None
        pts = (25 if best and best <= 100 else 18 if best and best <= 500 else 12 if best else 10) + 6 * (len(L.alpha) - 1)
        first = min(a["ts"] for a in L.alpha) - L.created
        who = ", ".join(f"#{a['rank']}" if a.get("rank") else (a.get("label") or "smart wallet") for a in L.alpha[:4])
        det.append({"key": "alpha", "label": "Alpha entry", "points": min(35.0, pts), "good": True,
                    "detail": f"{len(L.alpha)} top wallet{'s' if len(L.alpha) > 1 else ''} in ({who}); first {first:.0f}s after launch",
                    "value": len(L.alpha)})

    # 2 · curve velocity & graduation ETA ------------------------------------------------------------------------
    win = [t for t in trades if t[0] >= now - 120 and t[5]]
    vs = [(t[0], t[5]) for t in win]
    slope = _slope(vs) * 60 if len(vs) >= 4 else 0.0              # virtual SOL per minute
    net_flow = sum(t[2] or 0 for t in trades if t[0] >= now - 60 and t[1] == "buy") - \
        sum(t[2] or 0 for t in trades if t[0] >= now - 60 and t[1] == "sell")
    new_60 = sum(1 for ts in L.buyers.values() if ts >= now - 60)
    new_prev = sum(1 for ts in L.buyers.values() if now - 120 <= ts < now - 60)
    accel = (new_60 + 1) / (new_prev + 1)
    eta_min = None
    if L.vsol and slope > 0.05 and L.graduated_at is None:
        eta_min = max(0.0, (CURVE_END_SOL - L.vsol) / slope)
    vpts = 0.0
    if L.graduated_at:
        vpts = 20
    elif eta_min is not None:
        vpts = 30 if eta_min <= 5 else 22 if eta_min <= 10 else 14 if eta_min <= 20 else 6 if eta_min <= 45 else 0
    vpts += min(8.0, max(0.0, accel - 1) * 4) if new_60 >= 3 else 0
    if vpts or slope:
        det.append({"key": "velocity", "label": "Curve velocity", "points": round(vpts, 1), "good": vpts > 0,
                    "detail": ("graduated" if L.graduated_at else
                               f"+{slope:.1f} SOL/min into the curve · {new_60} new buyers/min (×{accel:.1f})"
                               + (f" · graduation in ~{eta_min:.0f} min" if eta_min is not None else "")),
                    "value": round(slope, 2), "eta_min": round(eta_min, 1) if eta_min is not None else None})

    # 3 · organic flow vs bundles ----------------------------------------------------------------------------------
    if L.early_frozen:      # the creation window is long gone: reuse its stats (old trades may have rolled off the buffer)
        early_wallets, early_supply, burst = L.early_frozen["wallets"], L.early_frozen["supply"], L.early_frozen["burst"]
    else:
        early = [t for t in buys if t[0] - L.created <= 2.5]
        early_wallets = {t[4] for t in early}
        by_sec = Counter(int(t[0]) for t in buys if t[0] - L.created <= 10)
        burst = max(by_sec.values()) if by_sec else 0
        early_supply = sum(t[3] or 0 for t in early) / 1e9 * 100           # % of the 1B supply taken in the first 2.5s
        if age >= 15:
            L.early_frozen = {"wallets": early_wallets, "supply": early_supply, "burst": burst}
    amounts = Counter(round(t[2] or 0, 3) for t in buys if t[2])
    same_amt = (amounts.most_common(1)[0][1] / len(buys)) if buys and amounts else 0.0
    vol_by = sorted(L.buy_sol.values(), reverse=True)
    tot = sum(vol_by) or 0.0
    top3 = sum(vol_by[:3]) / tot if tot else 0.0
    uniq_ratio = len(L.buyers) / max(1, len(buys))
    organic = 100.0
    # sniper bots in block 0 are normal on pump.fun; a *bundle* is several wallets taking a big slice of supply at once
    organic -= min(40.0, max(0.0, early_supply - 5) * 2) if len(early_wallets) >= 3 else 0
    organic -= min(25.0, max(0.0, same_amt - 0.25) * 60)            # identical buy sizes = bots
    organic -= min(25.0, max(0.0, top3 - 0.5) * 60)                 # three wallets hold most of the flow
    organic -= min(10.0, max(0.0, 0.5 - uniq_ratio) * 20)
    organic = max(0.0, organic)
    bundled = (len(early_wallets) >= 3 and early_supply >= 20) or (burst >= 6 and top3 > 0.6)
    if bundled:
        flags.append("bundled launch")
    if len(buys) >= 5:
        opts = -20.0 if bundled else (organic - 60) / 3                 # -20 … +13
        det.append({"key": "organic", "label": "Organic flow", "points": round(max(-20.0, min(15.0, opts)), 1),
                    "good": organic >= 60 and not bundled, "value": round(organic),
                    "detail": f"{len(L.buyers)} distinct buyers · top 3 = {top3 * 100:.0f}% of buys · "
                              f"{len(early_wallets)} wallets took {early_supply:.0f}% of supply in the first 2.5s" + (" · BUNDLED" if bundled else "")})

    # 4 · dev track record (+ live dev selling) ---------------------------------------------------------------------
    d = L.dev or {}
    dpts = 0.0
    parts = []
    if d.get("launches") is not None:
        n, g = d.get("launches") or 0, d.get("graduated") or 0
        if g:
            dpts += min(20.0, 12 + 4 * (g - 1))
            parts.append(f"{g}/{n} past coins graduated")
        elif n >= 5:
            dpts -= 12
            flags.append("serial launcher, nothing graduated")
            parts.append(f"{n} coins in 30d, none graduated")
        elif n:
            parts.append(f"{n} past coin{'s' if n > 1 else ''}, none graduated")
        else:
            parts.append("first coin Radar has seen from this dev")
        if d.get("best_peak_usd"):
            parts.append(f"best peak ${d['best_peak_usd']:,.0f}")
    if L.dev_tokens > 0:
        sold = L.dev_sold_tokens / L.dev_tokens
        if sold >= 0.5:
            dpts -= 20
            flags.append("dev dumped")
            parts.append(f"dev sold {sold * 100:.0f}% of their buy")
        elif sold > 0:
            parts.append(f"dev sold {sold * 100:.0f}%")
    if L.dev_buy_pct is not None and L.dev_buy_pct >= 15:
        dpts -= 6
        parts.append(f"dev bought {L.dev_buy_pct:.0f}% at launch")
    if parts:
        det.append({"key": "dev", "label": "Dev track record", "points": dpts, "good": dpts > 0, "detail": " · ".join(parts),
                    "value": d.get("graduated")})

    # 5 · meta match & clones -----------------------------------------------------------------------------------------
    mpts = 0.0
    mparts = []
    for m in L.meta[:2]:
        p = 12 if m.get("status") in ("hot", "heating") else 6 if m.get("status") == "active" else 2
        mpts = max(mpts, p)
        mparts.append(f"{m.get('emoji') or ''}{m['name']} ({m.get('status')})")
    if L.clone_of:
        mpts += 4
        mparts.append(f"copies trending ${L.clone_of['symbol']}")
    if mparts:
        det.append({"key": "meta", "label": "Meta match", "points": mpts, "good": mpts >= 6, "detail": " · ".join(mparts)})

    # 6 · social spread ---------------------------------------------------------------------------------------------------
    soc = ctx.get("social", {}).get(L.mint) or (ctx.get("cashtags", {}).get((L.symbol or "").upper())
                                                  if (L.symbol or "").upper() not in COMMON_TICKERS and len(L.symbol or "") >= 3 else None)
    if soc:
        a = soc["authors"]
        spts = (18 if a >= 6 else 12 if a >= 3 else 6) + (8 if soc.get("vip") else 0)
        det.append({"key": "social", "label": "Social spread", "points": float(spts), "good": True, "value": a,
                    "detail": f"{a} author{'s' if a > 1 else ''} on {', '.join(sorted(soc['sources'])[:3])}" + (" · VIP posted" if soc.get("vip") else "")})

    # 7 · on-chain intel: are the early buyers who they look like? ------------------------------------------------------
    it = L.intel or {}
    if it:
        ins = it.get("insiders") or []
        ihold = sum(L.balances.get(w, 0.0) for w in ins) / 1e9 * 100
        fresh = it.get("fresh") or []
        fhold = sum(L.balances.get(w, 0.0) for w in fresh) / 1e9 * 100
        opts, oparts = 0.0, []
        if ins:
            opts -= min(25.0, 4 + ihold * 1.2)
            oparts.append(f"{len(ins)} linked wallets (shared funder{', tied to dev' if any(c['link'] != 'shared funder' for c in it.get('clusters', [])) else ''}) hold {ihold:.0f}%")
            if ihold >= 25:
                flags.append("insider cluster")
        if it.get("fresh_pct") is not None:
            oparts.append(f"{it['fresh_pct']}% of {it['scanned']} early buyers are fresh wallets" + (f" (hold {fhold:.0f}%)" if fresh else ""))
            if it["fresh_pct"] >= 60 and fhold >= 10:
                opts -= 8
        if it.get("dev_fresh"):
            oparts.append("dev wallet is brand new")
        if it.get("bots"):
            oparts.append(f"{it['bots']} bot wallets")
        if it.get("chain_top10_pct") is not None:
            oparts.append(f"on-chain top 10 = {it['chain_top10_pct']:.0f}%")
        if not ins and (it.get("fresh_pct") or 0) < 35 and it.get("scanned", 0) >= 5:
            opts += 6
            oparts.insert(0, "early buyers look independent")
        det.append({"key": "onchain", "label": "On-chain intel", "points": round(opts, 1), "good": opts >= 0 and not ins,
                    "detail": " · ".join(oparts) or "scanned", "value": len(ins)})

    # 8 · buzz: YouTube videos + Claude's narrative read --------------------------------------------------------------------
    yt, ai = L.yt or {}, L.ai or {}
    bpts, bparts = 0.0, []
    if yt.get("videos"):
        bpts += min(12.0, yt["videos"] * 4 + yt.get("views", 0) / 2500)
        bparts.append(f"{yt['videos']} YouTube video{'s' if yt['videos'] > 1 else ''} · {yt.get('views', 0):,} views")
    if ai.get("meme_score") is not None:
        ms = float(ai["meme_score"])
        bpts += max(-4.0, min(10.0, (ms - 5) * 2.5))
        bparts.append(f"AI meme score {ms:.0f}/10" + (f" · {ai['narrative']}" if ai.get("narrative") else "") + (" · derivative" if ai.get("derivative") else ""))
    if bparts:
        det.append({"key": "buzz", "label": "Buzz & narrative", "points": round(bpts, 1), "good": bpts > 0, "detail": " · ".join(bparts)})

    # 9 · X narrative: launched off a tweet Radar is tracking ----------------------------------------------------------
    xr = L.x or {}
    if xr:
        xpts = min(22.0, xr.get("score", 0) / 4.5) + (6 if xr.get("rank") == 1 else 2 if (xr.get("rank") or 9) <= 3 else 0) \
            + {"S": 6, "A": 3}.get(xr.get("tier"), 0)
        det.append({"key": "x", "label": "X narrative", "points": round(xpts, 1), "good": True, "value": xr.get("rank"),
                    "detail": f"coin #{xr.get('rank')} off @{xr.get('handle')}'s tweet ({xr.get('delay_s', 0) // 60:.0f}m "
                              f"{xr.get('delay_s', 0) % 60:.0f}s after) · “{(xr.get('text') or '')[:80]}”"})

    score = max(0.0, min(100.0, sum(x["points"] for x in det)))
    hard = {"bundled launch", "dev dumped", "serial launcher, nothing graduated", "insider cluster"} & set(flags)
    enough = len(trades) >= MIN_TRADES_FOR_CALL and len(L.buyers) >= MIN_BUYERS_FOR_CALL and age >= MIN_AGE_FOR_CALL
    tier = "TRAP" if hard else "SNIPE" if score >= SNIPE_AT and enough else "WATCH" if score >= WATCH_AT else "PASS"
    sol_usd = ctx.get("sol_usd")
    res = {
        "mint": L.mint, "symbol": L.symbol, "name": L.name, "deployer": L.deployer, "created": L.created, "age_s": round(age),
        "score": round(score, 1), "tier": tier, "flags": flags, "detectors": det,
        "mcap_sol": L.mcap_sol, "mcap_usd": round(L.mcap_sol * sol_usd) if L.mcap_sol and sol_usd else None,
        "peak_mcap_usd": round(L.peak_mcap_sol * sol_usd) if L.peak_mcap_sol and sol_usd else None,
        "progress": 100.0 if L.graduated_at else curve_progress(L.vsol), "graduated_at": L.graduated_at,
        "eta_min": round(eta_min, 1) if eta_min is not None else None, "sol_per_min": round(slope, 2),
        "buys": len(buys), "sells": len(sells), "buyers": len(L.buyers), "net_sol_1m": round(net_flow, 2),
        "dev_buy_pct": L.dev_buy_pct, "organic": round(organic) if len(buys) >= 5 else None, "bundled": bundled,
        "early_supply_pct": round(early_supply, 1),
        "alpha": L.alpha[:6],
        # high score but not yet enough trades / buyers / age to call: shown as "confirming" instead of a call
        "confirming": tier == "WATCH" and score >= SNIPE_AT and not enough,
    }
    # trader-terminal metrics + the two-axis read (upside vs risk) + every strategy this launch matches right now
    mx = sm.compute(L, now, sol_usd, {"social": {"authors": soc["authors"], "engagement": soc.get("engagement", 0)} if soc else {},
                                      "yt": yt, "x": xr})
    mx["net_sol_1m"] = res["net_sol_1m"]
    up, risk, why_up, why_risk = sm.upside_risk(res, mx)
    res.update(metrics=mx, upside=up, risk=risk, why_up=why_up, why_risk=why_risk,
               scores={k: sm.appetite_score(up, risk, k) for k in sm.APPETITE},
               description=(L.metadata.get("description") or "")[:280] or None,
               links={k: L.metadata.get(k) for k in ("twitter", "telegram", "website") if L.metadata.get(k)},
               image=L.metadata.get("image"),
               intel=({k: it.get(k) for k in ("scanned", "fresh_pct", "bots", "chain_top10_pct", "dev_fresh", "clusters", "ts")}
                      | {"insiders": len(it.get("insiders") or []), "fresh": len(it.get("fresh") or [])}) if it else None,
               ai={k: ai.get(k) for k in ("narrative", "category", "meme_score", "derivative", "red_flags", "take")} if ai else None,
               yt=({"videos": yt.get("videos"), "views": yt.get("views"), "top": yt.get("top")}) if yt.get("videos") else None,
               x={k: xr.get(k) for k in ("handle", "tier", "score", "rank", "delay_s", "url", "text", "narrative")} if xr else None)
    row = flat(res)
    res["strategies"] = [st["id"] for st in ctx.get("strategies", []) if sm.matches(st["rules"], row, st.get("mode", "all"))]
    return res


def flat(res: dict[str, Any]) -> dict[str, Any]:
    """One flat dict of every metric a strategy rule can reference."""
    return {**{k: v for k, v in res.items() if not isinstance(v, (dict, list))}, **res.get("metrics", {}),
            "alpha": len(res.get("alpha") or []), "upside": res.get("upside"), "risk": res.get("risk")}


class Sniper:
    def __init__(self, db: Any, tracker: Any, alerts: Any) -> None:
        self.db, self.tracker, self.alerts = db, tracker, alerts
        self.traders: Any = None
        self.smart: Any = None
        self.metas: Any = None
        self.launches: dict[str, Launch] = {}
        self.calls: dict[str, dict[str, Any]] = {}           # mint -> outcome row being tracked
        self.dirty_calls: set[str] = set()
        self.dev_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self.ctx: dict[str, Any] = {"social": {}, "cashtags": {}}
        self.clones: dict[str, dict[str, Any]] = {}
        self.seen_launches = 0
        self.meta_fetch: Any = None                          # callable(mint, uri) wired by the app
        self.pool: set[str] = set()                          # every wallet in the Top Traders pool (pro traders)
        self.strategies: list[dict[str, Any]] = []           # active strategies (presets + custom + playbook consensus)
        self.hits: dict[tuple[str, str], dict[str, Any]] = {}
        self.dirty_hits: set[tuple[str, str]] = set()
        self.on_hit: Any = None
        self.hit_mints: set[str] = set()
        self.hits_by_mint: dict[str, list[tuple[str, str]]] = {}
        self.dirty: set[str] = set()
        self.stats = {"evals": 0, "eval_ms": 0.0, "batches": 0, "last_tick_ms": 0.0, "backlog": 0}
        self.onchain: Any = None                             # Helius intel: queues launches worth scanning
        self.ytbuzz: Any = None                              # YouTube buzz index (tickers / contracts / names in video titles)

    # ---------------- stream hooks (hot path: memory only) ----------------
    async def on_launch(self, row: dict[str, Any]) -> None:
        now = time.time()
        mint = row["address"]
        if row.get("is_mayhem"):
            return
        L = Launch(mint=mint, created=row.get("launched_at") or now, symbol=row.get("symbol"), name=row.get("name"),
                   deployer=row.get("deployer"), dev_buy_sol=float(row.get("initial_buy_sol") or 0),
                   dev_buy_pct=row.get("dev_initial_buy_pct"), dev_tokens=float(row.get("initial_buy_tokens") or 0),
                   vsol=row.get("vsol") or row.get("curve_sol"), mcap_sol=row.get("pump_mcap_sol"), until=now + TRACK_S)
        L.peak_mcap_sol = L.mcap_sol or 0.0
        L.uri = row.get("uri")
        if L.deployer and L.dev_tokens:
            L.balances[L.deployer] = L.dev_tokens
        if self.metas:
            for mid in self.metas.match_coin(L.name, L.symbol)[:3]:
                m = next((r for r in self.metas.rows if r["id"] == mid), None)
                if m:
                    L.meta.append({"id": mid, "name": m.get("name"), "emoji": m.get("emoji"), "status": m.get("status"), "heat": m.get("heat")})
        c = self.clones.get((L.symbol or "").upper())
        if c and c["address"] != mint:
            L.clone_of = c
        self.launches[mint] = L
        self.seen_launches += 1
        await self.db.exec("INSERT OR IGNORE INTO dev_launches (mint, deployer, symbol, name, ts, peak_mcap_sol) VALUES (?,?,?,?,?,?)",
                           (mint, L.deployer, L.symbol, L.name, L.created, L.mcap_sol))
        asyncio.get_running_loop().create_task(self._load_dev(L))
        if self.meta_fetch and L.uri:
            self.meta_fetch(L.mint, L.uri)
        await self._evaluate(L, now, force=True)

    async def on_metadata(self, mint: str, md: dict[str, Any]) -> None:
        L = self.launches.get(mint)
        if L is None:
            return
        if md.get("is_mayhem"):
            self.launches.pop(mint, None)
            await hub.publish("snipe_drop", {"mint": mint, "reason": "mayhem"})
            return
        L.metadata = md
        if self.metas and md.get("description"):
            for mid in self.metas.match_text(md["description"])[:2]:
                if not any(x["id"] == mid for x in L.meta):
                    m = next((r for r in self.metas.rows if r["id"] == mid), None)
                    if m:
                        L.meta.append({"id": mid, "name": m.get("name"), "emoji": m.get("emoji"), "status": m.get("status"), "heat": m.get("heat")})
        await self._evaluate(L, time.time(), force=True)

    async def on_trade(self, t: dict[str, Any]) -> None:
        mint = t.get("mint")
        L = self.launches.get(mint)
        call = self.calls.get(mint)
        if call and t.get("mcap_sol"):
            self._call_mark(call, t["mcap_sol"], t["ts"])
        if t.get("mcap_sol") and self.hit_mints and mint in self.hit_mints:
            self._hit_mark(mint, t["mcap_sol"], t["ts"])
        if L is None:
            return
        now = t["ts"]
        side, sol, tokens, trader = t.get("side"), float(t.get("sol") or 0), float(t.get("tokens") or 0), t.get("trader")
        vsol = t.get("vsol")
        L.trades.append((now, side, sol, tokens, trader, float(vsol) if vsol else None))
        if vsol:
            L.vsol = float(vsol)
        if t.get("mcap_sol"):
            L.mcap_sol = float(t["mcap_sol"])
            L.peak_mcap_sol = max(L.peak_mcap_sol, L.mcap_sol)
        if trader:
            L.balances[trader] = max(0.0, L.balances.get(trader, 0.0) + (tokens if side == "buy" else -tokens))
        if trader == L.deployer:
            if side == "sell":
                L.dev_sold_tokens += tokens
            elif side == "buy" and not L.dev_tokens:
                L.dev_tokens = tokens
        elif side == "buy" and trader:
            L.buyers.setdefault(trader, now)
            dt = now - L.created
            if dt <= 5:
                L.early.add(trader)
            if dt <= 2.5:   # creation-block cluster: counted as bundlers once 3+ wallets land there
                L.block.add(trader)
                if len(L.block) >= 3:
                    L.bundlers |= L.block
            if self.pool and trader in self.pool:
                L.pros.add(trader)
            L.buy_sol[trader] = L.buy_sol.get(trader, 0.0) + sol
            if trader not in {a["wallet"] for a in L.alpha}:
                hit = self._alpha(trader)
                if hit:
                    L.alpha.append({**hit, "wallet": trader, "ts": now, "sol": round(sol, 3)})
        L.observed_sol += sol if side == "buy" else -sol
        L.dirty = True
        self.dirty.add(mint)      # scored by eval_loop under a CPU budget — the stream never waits on scoring

    async def on_graduated(self, ev: dict[str, Any]) -> None:
        L = self.launches.get(ev["mint"])
        if L:
            L.graduated_at = ev["ts"]
            L.dirty = True
            await self._evaluate(L, ev["ts"], force=True)
        call = self.calls.get(ev["mint"])
        if call and not call.get("graduated_at"):
            call["graduated_at"] = ev["ts"]
            self.dirty_calls.add(ev["mint"])
        await self.db.exec("UPDATE dev_launches SET graduated_at=COALESCE(graduated_at, ?) WHERE mint=?", (ev["ts"], ev["mint"]))
        await self.db.exec("UPDATE strategy_hits SET graduated_at=COALESCE(graduated_at, ?) WHERE mint=?", (ev["ts"], ev["mint"]))

    async def on_trending_first(self, ev: dict[str, Any]) -> None:
        for a in ev["addresses"]:
            call = self.calls.get(a)
            if call and not call.get("first_trending_at"):
                call["first_trending_at"] = ev["ts"]
                self.dirty_calls.add(a)

    async def on_tokens(self, rows: list[dict[str, Any]]) -> None:
        """DexScreener refreshes keep tracking a called coin's value after it leaves the bonding curve."""
        sol = self.tracker.sol_usd
        if not sol:
            return
        for r in rows:
            call = self.calls.get(r.get("address"))
            mc = r.get("market_cap") or r.get("fdv")
            if call and mc:
                self._call_mark(call, mc / sol, r.get("as_of") or time.time())
            if mc and r.get("address") in self.hit_mints:
                self._hit_mark(r["address"], mc / sol, r.get("as_of") or time.time())

    def _alpha(self, wallet: str) -> dict[str, Any] | None:
        r = (self.traders.ranked.get(wallet) if self.traders else None)
        if r:
            return {"rank": r["rank"], "label": r.get("label")}
        if self.traders and wallet in self.traders.followed:
            return {"rank": None, "label": "followed"}
        w = (self.smart.tracked.get(wallet) if self.smart else None)
        if w:
            return {"rank": None, "label": w.get("label") or "smart wallet"}
        return None

    async def _evaluate(self, L: Launch, now: float, force: bool = False, publish: bool = True) -> bool:
        """Score one launch. Returns True when the UI should get the new row (eval_loop batches those)."""
        if not force and now - L.last_eval < 0.25:
            return False
        L.last_eval = now
        prev = L.result.get("tier")
        self.ctx["sol_usd"] = self.tracker.sol_usd
        self.ctx["strategies"] = self.strategies
        L.result = analyze(L, now, self.ctx)
        for sid in L.result.get("strategies", []):
            if sid not in L.hits and L.mcap_sol:
                L.hits[sid] = now
                await self._hit(L, sid, now)
        L.dirty = False
        if self.onchain is not None:
            self.onchain.consider(L)
        tier = L.result["tier"]
        if tier in ("SNIPE", "WATCH"):
            # keep its trades streaming past the 90s launch window
            self.tracker.launch_watch[L.mint] = max(self.tracker.launch_watch.get(L.mint, 0), now + (3600 if tier == "SNIPE" else 300))
            L.until = max(L.until, now + (6 * 3600 if tier == "SNIPE" else TRACK_S))
        if tier == "SNIPE" and L.mint not in self.calls:
            await self._call(L, now)
        if force or tier != prev or now - L.last_pub >= 0.5:
            L.last_pub = now
            if publish:
                await hub.publish("snipe", L.result)
            return True
        return False

    def _interval(self, L: Launch) -> float:
        """Busy coins are re-scored less often: their score barely moves trade to trade, and scoring cost grows with trades."""
        n = len(L.trades)
        return 0.3 if n < 150 else 0.8 if n < 600 else 1.5

    async def eval_loop(self) -> None:
        """Re-score dirty launches a few times a second within a CPU budget, and push all changes in ONE message."""
        budget = float(__import__("os").environ.get("SNIPE_EVAL_BUDGET_MS", "60")) / 1000
        while True:
            await asyncio.sleep(0.3)
            try:
                if not self.dirty:
                    continue
                t0 = time.perf_counter()
                now = time.time()
                order = sorted((m for m in self.dirty if m in self.launches),
                               key=lambda m: ({"SNIPE": 0, "WATCH": 1}.get(self.launches[m].result.get("tier"), 2), -self.launches[m].created))
                out = []
                for m in order:
                    L = self.launches[m]
                    if now - L.last_eval < self._interval(L):
                        continue
                    self.dirty.discard(m)
                    e0 = time.perf_counter()
                    if await self._evaluate(L, now, publish=False):
                        out.append(L.result)
                    self.stats["evals"] += 1
                    self.stats["eval_ms"] += (time.perf_counter() - e0) * 1000
                    if time.perf_counter() - t0 > budget:
                        break
                self.dirty &= set(self.launches)
                self.stats["backlog"] = len(self.dirty)
                if out:
                    self.stats["batches"] += 1
                    await hub.publish("snipe_batch", out)
                self.stats["last_tick_ms"] = round((time.perf_counter() - t0) * 1000, 1)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("snipe eval loop: %s", e)

    # ---------------- calls & proof ----------------
    async def _call(self, L: Launch, now: float) -> None:
        r = L.result
        sol = self.tracker.sol_usd
        tok = await self.db.one("SELECT image FROM tokens WHERE address=?", (L.mint,)) or {}
        call = {"mint": L.mint, "symbol": L.symbol, "name": L.name, "image": tok.get("image"), "launched_at": L.created,
                "call_ts": now, "score": r["score"], "tier": r["tier"],
                "detectors_json": json.dumps(r["detectors"]),
                "inputs_json": json.dumps({k: r[k] for k in ("age_s", "buys", "sells", "buyers", "net_sol_1m", "sol_per_min", "eta_min",
                                                             "organic", "bundled", "dev_buy_pct", "flags", "alpha")}),
                "mcap_sol_at_call": L.mcap_sol, "mcap_usd_at_call": round(L.mcap_sol * sol, 2) if L.mcap_sol and sol else None,
                "progress_at_call": r["progress"], "sol_usd_at_call": sol, "peak_mcap_sol": L.mcap_sol, "peak_ts": now,
                "last_mcap_sol": L.mcap_sol, "last_ts": now, "graduated_at": L.graduated_at, "updated": now}
        if not L.mcap_sol:
            return
        self.calls[L.mint] = call
        await self.db.upsert("snipe_calls", call, "mint")
        await hub.publish("snipe_call", {**r, "call_ts": now})
        top = max(r["detectors"], key=lambda x: x["points"], default=None)
        # delivery (Telegram / ntfy / Discord) runs off the hot path: the next trade must never wait on an HTTP call
        asyncio.get_running_loop().create_task(self.alerts.send("info", f"🎯 SNIPE {L.symbol or L.mint[:6]} · score {r['score']:.0f}",
                               f"{top['label']}: {top['detail']}" if top else "", token=L.mint, dedupe=f"snipe:{L.mint}", ttl=86400))

    async def _hit(self, L: Launch, sid: str, now: float) -> None:
        """First time a launch matches a strategy: log it with its metrics so the strategy gets graded on Proof."""
        h = {"strategy_id": sid, "mint": L.mint, "symbol": L.symbol, "ts": now, "mcap_sol": L.mcap_sol,
             "metrics_json": json.dumps(flat(L.result)), "peak_mcap_sol": L.mcap_sol, "peak_ts": now, "last_mcap_sol": L.mcap_sol,
             "graduated_at": L.graduated_at}
        self.hits[(sid, L.mint)] = h
        self.hit_mints.add(L.mint)
        self.hits_by_mint.setdefault(L.mint, []).append((sid, L.mint))
        self.tracker.launch_watch[L.mint] = max(self.tracker.launch_watch.get(L.mint, 0), now + 1800)
        L.until = max(L.until, now + 3600)
        await self.db.exec("INSERT OR IGNORE INTO strategy_hits (strategy_id, mint, symbol, ts, mcap_sol, metrics_json, peak_mcap_sol, "
                           "peak_ts, last_mcap_sol) VALUES (?,?,?,?,?,?,?,?,?)",
                           (sid, L.mint, L.symbol, now, L.mcap_sol, h["metrics_json"], L.mcap_sol, now, L.mcap_sol))
        if self.on_hit:
            asyncio.get_running_loop().create_task(self.on_hit(sid, L.result))

    def _hit_mark(self, mint: str, mcap_sol: float, ts: float) -> None:
        for key in self.hits_by_mint.get(mint, ()):
            h = self.hits.get(key)
            if h is None:
                continue
            h["last_mcap_sol"] = mcap_sol
            if mcap_sol > (h.get("peak_mcap_sol") or 0):
                h["peak_mcap_sol"], h["peak_ts"] = mcap_sol, ts
            self.dirty_hits.add(key)

    def _call_mark(self, call: dict[str, Any], mcap_sol: float, ts: float) -> None:
        call["last_mcap_sol"], call["last_ts"] = mcap_sol, ts
        if mcap_sol > (call.get("peak_mcap_sol") or 0):
            call["peak_mcap_sol"], call["peak_ts"] = mcap_sol, ts
        self.dirty_calls.add(call["mint"])

    async def outcome_loop(self) -> None:
        """Checkpoints (value 5m / 15m / 1h after the call), persistence, and eviction."""
        while True:
            await asyncio.sleep(5)
            try:
                now = time.time()
                for mint, c in list(self.calls.items()):
                    for col, dt in (("mcap_sol_5m", 300), ("mcap_sol_15m", 900), ("mcap_sol_1h", 3600)):
                        if c.get(col) is None and now - c["call_ts"] >= dt:
                            c[col] = c.get("last_mcap_sol")
                            self.dirty_calls.add(mint)
                    if now - c["call_ts"] > CALL_TRACK_S:
                        self.calls.pop(mint, None)
                    elif now - c["call_ts"] < 6 * 3600:   # keep its trades streaming for 6h so the outcome is exact
                        self.tracker.launch_watch[mint] = max(self.tracker.launch_watch.get(mint, 0), now + 60)
                for key, h in list(self.hits.items()):
                    for col, dt in (("mcap_sol_15m", 900), ("mcap_sol_1h", 3600)):
                        if h.get(col) is None and now - h["ts"] >= dt:
                            h[col] = h.get("last_mcap_sol")
                            self.dirty_hits.add(key)
                    if now - h["ts"] > CALL_TRACK_S:
                        self.hits.pop(key, None)
                self.hit_mints = {m for _, m in self.hits}
                self.hits_by_mint = {}
                for key in self.hits:
                    self.hits_by_mint.setdefault(key[1], []).append(key)
                if self.dirty_hits:
                    rows = [self.hits[k] for k in self.dirty_hits if k in self.hits]
                    self.dirty_hits.clear()
                    await self.db.many("UPDATE strategy_hits SET peak_mcap_sol=?, peak_ts=?, last_mcap_sol=?, mcap_sol_15m=?, mcap_sol_1h=? "
                                       "WHERE strategy_id=? AND mint=?",
                                       [(h.get("peak_mcap_sol"), h.get("peak_ts"), h.get("last_mcap_sol"), h.get("mcap_sol_15m"),
                                         h.get("mcap_sol_1h"), h["strategy_id"], h["mint"]) for h in rows])
                if self.dirty_calls:
                    rows = [self.calls[m] for m in self.dirty_calls if m in self.calls]
                    self.dirty_calls.clear()
                    await self.db.many(
                        "UPDATE snipe_calls SET peak_mcap_sol=?, peak_ts=?, last_mcap_sol=?, last_ts=?, mcap_sol_5m=?, mcap_sol_15m=?, "
                        "mcap_sol_1h=?, graduated_at=?, first_trending_at=?, updated=? WHERE mint=?",
                        [(c.get("peak_mcap_sol"), c.get("peak_ts"), c.get("last_mcap_sol"), c.get("last_ts"), c.get("mcap_sol_5m"),
                          c.get("mcap_sol_15m"), c.get("mcap_sol_1h"), c.get("graduated_at"), c.get("first_trending_at"), now, c["mint"])
                         for c in rows])
                stale = [m for m, L in self.launches.items() if L.until < now]
                if stale:
                    await self.db.many("UPDATE dev_launches SET peak_mcap_sol=MAX(COALESCE(peak_mcap_sol,0), ?), last_trade_ts=? WHERE mint=?",
                                       [(self.launches[m].peak_mcap_sol, self.launches[m].trades[-1][0] if self.launches[m].trades else None, m)
                                        for m in stale])
                    for m in stale:
                        self.launches.pop(m, None)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("snipe outcomes: %s", e)

    async def flush_peaks_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            try:
                rows = [(L.peak_mcap_sol, L.trades[-1][0] if L.trades else None, m) for m, L in self.launches.items() if L.peak_mcap_sol]
                await self.db.many("UPDATE dev_launches SET peak_mcap_sol=MAX(COALESCE(peak_mcap_sol,0), ?), last_trade_ts=? WHERE mint=?", rows)
                await self.db.exec("DELETE FROM dev_launches WHERE ts < ?", (time.time() - 30 * 86400,))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.debug("dev peaks: %s", e)

    # ---------------- slow context (off the hot path) ----------------
    async def _load_dev(self, L: Launch) -> None:
        if not L.deployer:
            return
        hit = self.dev_cache.get(L.deployer)
        if hit and time.time() - hit[0] < 120:
            L.dev = hit[1]
        else:
            r = await self.db.one("SELECT COUNT(*) n, SUM(graduated_at IS NOT NULL) g, MAX(peak_mcap_sol) best FROM dev_launches "
                                  "WHERE deployer=? AND mint != ? AND ts > ?", (L.deployer, L.mint, time.time() - 30 * 86400)) or {}
            sol = self.tracker.sol_usd
            d = {"launches": r.get("n") or 0, "graduated": r.get("g") or 0,
                 "best_peak_usd": round(r["best"] * sol) if r.get("best") and sol else None}
            self.dev_cache[L.deployer] = (time.time(), d)
            if len(self.dev_cache) > 20000:
                self.dev_cache.clear()
            L.dev = d
        await self._evaluate(L, time.time(), force=True)

    async def context_loop(self) -> None:
        """Every 15s: who is posting which contract / $ticker, and which tickers are trending (for clone detection)."""
        while True:
            try:
                now = time.time()
                social: dict[str, dict[str, Any]] = {}
                tags: dict[str, dict[str, Any]] = {}
                for r in await self.db.all("SELECT source, author_id, author_tier, cas_json, cashtags_json FROM social_events "
                                           "WHERE ingested > ? AND is_fixture=0 AND (cas_json NOT IN ('[]','') OR cashtags_json NOT IN ('[]',''))",
                                           (now - 1800,)):
                    for key, target in (("cas_json", social), ("cashtags_json", tags)):
                        try:
                            vals = json.loads(r[key] or "[]")
                        except ValueError:
                            continue
                        for v in vals:
                            k = v if key == "cas_json" else str(v).upper().lstrip("$")
                            e = target.setdefault(k, {"authors_set": set(), "sources": set(), "vip": False})
                            e["authors_set"].add(r["author_id"])
                            e["sources"].add(r["source"])
                            e["vip"] = e["vip"] or r["author_tier"] == "vip"
                for d in (social, tags):
                    for e in d.values():
                        e["authors"] = len(e.pop("authors_set"))
                self.ctx["social"], self.ctx["cashtags"] = social, tags
                clones: dict[str, dict[str, Any]] = {}
                for r in await self.db.all(
                        "SELECT t.address, UPPER(t.symbol) sym, p.vol_h1 FROM tokens t JOIN pairs p ON p.pair_address=t.best_pair "
                        "WHERE t.symbol IS NOT NULL AND p.vol_h1 > 50000 AND p.as_of > ? ORDER BY p.vol_h1 DESC LIMIT 300", (now - 3600,)):
                    if r["sym"] and r["sym"] not in clones and r["sym"] not in COMMON_TICKERS:
                        clones[r["sym"]] = {"address": r["address"], "symbol": r["sym"], "vol_h1": r["vol_h1"]}
                self.clones = clones
                if self.ytbuzz is not None:
                    for L in list(self.launches.values()):
                        y = self.ytbuzz.match(L.mint, L.symbol, L.name)
                        if (y or {}).get("videos") != (L.yt or {}).get("videos"):
                            L.yt = y
                            L.dirty = True
                            self.dirty.add(L.mint)
                for L in list(self.launches.values()):
                    if now - L.last_eval > 5:
                        self.dirty.add(L.mint)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("snipe context: %s", e)
            await asyncio.sleep(15)

    async def warm(self) -> None:
        """After a restart, rebuild the last 30 minutes of launches from the database."""
        now = time.time()
        toks = await self.db.all("SELECT address, symbol, name, deployer, launched_at, first_seen, dev_initial_buy_pct, curve_sol, "
                                 "pump_mcap_sol, graduated_at FROM tokens WHERE source='pumpportal' AND first_seen > ?", (now - TRACK_S,))
        for t in toks:
            L = Launch(mint=t["address"], created=t["launched_at"] or t["first_seen"], symbol=t["symbol"], name=t["name"],
                       deployer=t["deployer"], dev_buy_pct=t["dev_initial_buy_pct"], vsol=t["curve_sol"], mcap_sol=t["pump_mcap_sol"],
                       graduated_at=t["graduated_at"], until=(t["launched_at"] or t["first_seen"]) + TRACK_S)
            for r in await self.db.all("SELECT ts, side, sol, tokens, trader, mcap_sol FROM pump_trades WHERE mint=? ORDER BY ts", (L.mint,)):
                L.trades.append((r["ts"], r["side"], r["sol"] or 0, r["tokens"] or 0, r["trader"], None))
                L.observed_sol += (r["sol"] or 0) * (1 if r["side"] == "buy" else -1)
                if r["trader"] == L.deployer:
                    if r["side"] == "sell":
                        L.dev_sold_tokens += r["tokens"] or 0
                    elif not L.dev_tokens:
                        L.dev_tokens = r["tokens"] or 0
                elif r["side"] == "buy" and r["trader"]:
                    L.buyers.setdefault(r["trader"], r["ts"])
                    L.buy_sol[r["trader"]] = L.buy_sol.get(r["trader"], 0) + (r["sol"] or 0)
                if r["mcap_sol"]:
                    L.peak_mcap_sol = max(L.peak_mcap_sol, r["mcap_sol"])
            self.launches[L.mint] = L
            L.result = analyze(L, now, self.ctx)
        for c in await self.db.all("SELECT * FROM snipe_calls WHERE call_ts > ?", (now - CALL_TRACK_S,)):
            self.calls[c["mint"]] = dict(c)

    # ---------------- reads ----------------
    def board(self, min_score: float = 0, tiers: set[str] | None = None, max_age_min: float = 30, limit: int = 100,
              hide_bundled: bool = False, alpha_only: bool = False, proven_dev: bool = False, appetite: str = "",
              strategy: str = "", rules: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        """`appetite` (safe / balanced / degen) ranks by upside minus a risk penalty instead of the call tier, so a coin
        doesn't have to be perfect to make the board — it just has to be worth its risk at your appetite."""
        now = time.time()
        rows = []
        for L in self.launches.values():
            r = L.result
            if not r or r["score"] < min_score or now - L.created > max_age_min * 60:
                continue
            if tiers and r["tier"] not in tiers:
                continue
            if hide_bundled and r["bundled"]:
                continue
            if alpha_only and not r["alpha"]:
                continue
            if proven_dev and not ((L.dev or {}).get("graduated")):
                continue
            if strategy and strategy not in r.get("strategies", []):
                continue
            if rules and not sm.matches(rules, flat(r)):
                continue
            rows.append({**r, "age_s": round(now - L.created), "called": L.mint in self.calls})
        if appetite in sm.APPETITE:
            rows.sort(key=lambda r: (-(r.get("scores") or {}).get(appetite, 0), -r["created"]))
        else:
            order = {"SNIPE": 0, "WATCH": 1, "PASS": 2, "TRAP": 3}
            rows.sort(key=lambda r: (order.get(r["tier"], 9), -r["score"], -r["created"]))
        return {"rows": rows[:limit], "tracking": len(self.launches), "seen": self.seen_launches, "as_of": now,
                "matched": len(rows), "thresholds": {"snipe": SNIPE_AT, "watch": WATCH_AT}}

    def one(self, mint: str) -> dict[str, Any] | None:
        L = self.launches.get(mint)
        if not (L and L.result):
            return None
        it = L.intel or {}
        return {**L.result, "dev": L.dev, "meta": L.meta, "clone_of": L.clone_of, "yt_videos": (L.yt or {}).get("list"),
                "intel_detail": {"clusters": it.get("clusters"), "insiders": it.get("insiders"), "fresh": it.get("fresh"),
                                 "dev_funder": it.get("dev_funder")} if it else None}

    async def proof(self, hours: float = 24 * 7) -> dict[str, Any]:
        """Real outcomes of every call, against the base rate of all launches Radar saw in the same window."""
        now = time.time()
        since = now - hours * 3600
        calls = await self.db.all("SELECT * FROM snipe_calls WHERE call_ts > ? ORDER BY call_ts DESC", (since,))
        base = await self.db.one("SELECT COUNT(*) n, SUM(graduated_at IS NOT NULL) g FROM dev_launches WHERE ts > ?", (since,)) or {}

        def x(c: dict[str, Any], col: str) -> float | None:
            return c[col] / c["mcap_sol_at_call"] if c.get(col) and c.get("mcap_sol_at_call") else None

        rows = []
        for c in calls:
            rows.append({k: c[k] for k in ("mint", "symbol", "name", "image", "call_ts", "score", "mcap_usd_at_call", "progress_at_call",
                                           "graduated_at", "first_trending_at", "launched_at")} | {
                "detectors": json.loads(c["detectors_json"] or "[]"),
                "peak_x": x(c, "peak_mcap_sol"), "x_5m": x(c, "mcap_sol_5m"), "x_15m": x(c, "mcap_sol_15m"), "x_1h": x(c, "mcap_sol_1h"),
                "now_x": x(c, "last_mcap_sol"), "peak_after_s": (c["peak_ts"] - c["call_ts"]) if c.get("peak_ts") else None,
                "secs_after_launch": c["call_ts"] - c["launched_at"] if c.get("launched_at") else None,
                "lead_to_graduation_s": (c["graduated_at"] - c["call_ts"]) if c.get("graduated_at") and c["graduated_at"] > c["call_ts"] else None,
                "lead_to_trending_s": (c["first_trending_at"] - c["call_ts"]) if c.get("first_trending_at") else None,
            })
        n = len(rows)

        def pct(f) -> float | None:
            return round(sum(1 for r in rows if f(r)) / n * 100, 1) if n else None

        def med(vals: list[float]) -> float | None:
            v = [x for x in vals if x is not None]
            return round(statistics.median(v), 2) if v else None

        settled = [r for r in rows if r["x_1h"] is not None]
        stats = {
            "calls": n, "window_h": hours, "launches_seen": base.get("n") or 0,
            "base_graduation_pct": round((base.get("g") or 0) / base["n"] * 100, 2) if base.get("n") else None,
            "call_graduation_pct": pct(lambda r: r["graduated_at"] and r["graduated_at"] >= r["call_ts"] - 1),
            "hit_2x_pct": pct(lambda r: (r["peak_x"] or 0) >= 2), "hit_5x_pct": pct(lambda r: (r["peak_x"] or 0) >= 5),
            "hit_10x_pct": pct(lambda r: (r["peak_x"] or 0) >= 10),
            "median_peak_x": med([r["peak_x"] for r in rows]),
            "median_x_1h": med([r["x_1h"] for r in settled]), "settled_1h": len(settled),
            "up_after_1h_pct": round(sum(1 for r in settled if (r["x_1h"] or 0) > 1) / len(settled) * 100, 1) if settled else None,
            "median_secs_after_launch": med([r["secs_after_launch"] for r in rows]),
            "median_lead_to_graduation_min": med([r["lead_to_graduation_s"] / 60 for r in rows if r["lead_to_graduation_s"]]),
            "median_lead_to_trending_min": med([r["lead_to_trending_s"] / 60 for r in rows if r["lead_to_trending_s"] and r["lead_to_trending_s"] > 0]),
            "before_trending_pct": round(sum(1 for r in rows if r["first_trending_at"] and r["first_trending_at"] > r["call_ts"]) /
                                         max(1, sum(1 for r in rows if r["first_trending_at"])) * 100, 1)
            if any(r["first_trending_at"] for r in rows) else None,
        }
        by_det: dict[str, list[dict[str, Any]]] = {}
        for r in rows:
            for d in r["detectors"]:
                if d.get("points", 0) > 0:
                    by_det.setdefault(d["key"], []).append(r)
        stats["by_detector"] = {k: {"calls": len(v), "hit_2x_pct": round(sum(1 for r in v if (r["peak_x"] or 0) >= 2) / len(v) * 100, 1),
                                    "median_peak_x": med([r["peak_x"] for r in v])} for k, v in by_det.items()}
        return {"stats": stats, "calls": rows[:500], "as_of": now}
