"""Chart, flow and rug patterns read straight off a launch's live trade tape — what a trader eyeballs on the chart and
the bubble map, as numbers the brain can learn from.

Every trade Radar sees is (ts, side, sol, tokens, trader, vsol). On a pump.fun bonding curve the price moves with
vsol² (constant product), and `vsol − 30` is the SOL sitting in the curve: the coin's liquidity. So from the tape
alone we get:

  volume       SOL traded in the last minute vs the average minute before it (an influx = acceleration)
  liquidity    SOL in the curve now, and how much flowed in / drained out over the last 2 minutes
  holders      wallets holding now, new holders in the last minute, holders who just sold out
  chart shape  drawdown from the peak, a vertical last-minute candle, a staircase of higher lows, volatility
  rug tells    one sell dumping a big slice of the liquidity, the top-3 sellers being most of the selling, a streak
               of sells at the end of the tape, liquidity draining fast, wash trading (same wallet in and out)
  bubble map   coordinated buys (3+ wallets, same second, same size) and the share of supply they took; plus, once
               Helius has scanned the coin, funder-linked clusters and how much of the supply they hold
  dev          how much the dev still holds, sold, bought at launch, serial launcher with nothing graduated, fresh wallet

`rug_alarm()` turns the strongest tells into a plain reason for an instant exit / veto.
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Any

CURVE0 = 30.0
SUPPLY = 1e9


def _clip(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return lo if x < lo else hi if x > hi else x


def chart(L: Any, now: float) -> dict[str, float]:
    """Raw pattern numbers (not normalised) — cheap: only the last 5 minutes of the tape are walked."""
    tape = getattr(L, "trades", None) or ()
    recent: list[tuple] = []
    for t in reversed(tape):
        if t[0] < now - 300 or len(recent) >= 400:              # last 5 min, at most 400 trades: cheap on busy coins
            break
        recent.append(t)
    recent.reverse()
    m1 = [t for t in recent if t[0] >= now - 60]
    prev = [t for t in recent if t[0] < now - 60]
    vol1 = sum(t[2] or 0 for t in m1)
    prev_min = (now - 60 - recent[0][0]) / 60 if prev else 0
    vol_prev = sum(t[2] or 0 for t in prev) / max(1.0, prev_min) if prev else 0.0
    vs_now = getattr(L, "vsol", None) or CURVE0
    liq = max(0.0, vs_now - CURVE0)
    v2 = next((t[5] for t in recent if t[0] >= now - 120 and t[5]), None)
    liq_2m = max(0.0, (v2 or vs_now) - CURVE0)
    # price path from the curve (vsol²), bucketed per minute for the shape reads
    pts = [(t[0], t[5] * t[5]) for t in recent if t[5]]
    p_now = vs_now * vs_now
    peak = max((getattr(L, "peak_mcap_sol", 0) or 0), L.mcap_sol or 0)
    drawdown = 1 - (L.mcap_sol or 0) / peak if peak and L.mcap_sol else 0.0
    p_60 = next((p for ts, p in pts if ts >= now - 60), p_now)
    vertical = p_now / p_60 if p_60 else 1.0
    p_30 = next((p for ts, p in pts if ts >= now - 30), p_now)
    p_2m = next((p for ts, p in pts if ts >= now - 120), p_now)
    peak_60 = max((p for ts, p in pts if ts >= now - 60), default=p_now)
    net_30 = sum((t[2] or 0) * (1 if t[1] == "buy" else -1) for t in recent if t[0] >= now - 30)
    last_ts = recent[-1][0] if recent else (tape[-1][0] if tape else now - 300)
    mins: dict[int, float] = {}
    for ts, p in pts:                                           # one pass: the low of each of the last 5 minutes
        k = int((now - ts) // 60)
        if 0 <= k < 5 and (k not in mins or p < mins[k]):
            mins[k] = p
    lows = [mins[k] for k in sorted(mins, reverse=True)]
    stairs = sum(1 for a, b in zip(lows, lows[1:]) if b >= a) / (len(lows) - 1) if len(lows) >= 3 else 0.5
    rets = [math.log(b[1] / a[1]) for a, b in zip(pts[-60:], pts[-59:]) if a[1] > 0 and b[1] > 0]
    vola = math.sqrt(sum(r * r for r in rets) / len(rets)) if len(rets) >= 5 else 0.0
    # sell-side tells over the last 3 minutes
    s3 = [t for t in recent if t[0] >= now - 180 and t[1] == "sell"]
    sell_vol = sum(t[2] or 0 for t in s3)
    by_seller: dict[str, float] = defaultdict(float)
    for t in s3:
        by_seller[t[4]] += t[2] or 0
    top3_sell = sum(sorted(by_seller.values(), reverse=True)[:3]) / sell_vol if sell_vol > 0 else 0.0
    big_sell = max((t[2] or 0 for t in s3), default=0.0)
    streak = 0
    for t in reversed(recent):
        if t[1] != "sell":
            break
        streak += 1
    # holders: in, joining, leaving
    bal = getattr(L, "balances", None) or {}
    holders = sum(1 for b in bal.values() if b > 1)
    bmap = getattr(L, "buyers", None) or {}
    joined = r10 = prev = 0
    for ts in bmap.values():                                    # one pass: new holders this minute, apes in the last 10 s / before
        if ts >= now - 70:
            if ts >= now - 60:
                joined += 1
            if ts >= now - 10:
                r10 += 1
            else:
                prev += 1
    prev10 = prev / 6
    left = len({t[4] for t in s3 if bal.get(t[4], 0) <= 1})
    # wash trading: the same wallet buying and selling inside a minute
    seen: dict[str, list[tuple[float, str]]] = defaultdict(list)
    for t in recent[-250:]:
        seen[t[4]].append((t[0], t[1]))
    wash = sum(1 for w, ev in seen.items() if any(a[1] != b[1] and abs(a[0] - b[0]) <= 60 for a, b in zip(ev, ev[1:])))
    buys2 = [t for t in recent if t[0] >= now - 120 and t[1] == "buy"]
    avg_buy = sum(t[2] or 0 for t in buys2) / len(buys2) if buys2 else 0.0
    retail = sum(1 for t in buys2 if (t[2] or 0) < 0.5) / len(buys2) if buys2 else 0.0
    # bubble map from the tape: 3+ wallets buying the same size in the same second = one hand
    coord_wallets = getattr(L, "_coord", None)
    if coord_wallets is None:
        groups: dict[tuple[int, float], set[str]] = defaultdict(set)
        for i, t in enumerate(tape):                            # the launch window is where bundles show up
            if i >= 600:
                break
            if t[1] == "buy" and t[2]:
                groups[(int(t[0]), round(t[2], 2))].add(t[4])
        coord_wallets = {w for k, ws in groups.items() if len(ws) >= 3 for w in ws}
        created = getattr(L, "created", None)
        if created and now - created > 90:                      # the launch window is over: freeze it
            try:
                L._coord = coord_wallets
            except AttributeError:
                pass
    coord_hold = sum(bal.get(w, 0.0) for w in coord_wallets) / SUPPLY * 100
    # the apes: new buyers per 10 s now vs the minute before, the first 20 buyers cashing out, pros among the holders
    first = getattr(L, "_first20", None)
    if first is None:
        first = [w for w, _ in sorted(bmap.items(), key=lambda kv: kv[1])[:20]]
        if len(first) >= 20:
            try:
                L._first20 = first                              # the first 20 buyers never change: compute once
            except AttributeError:
                pass
    early_out = sum(1 for w in first if bal.get(w, 0.0) <= 1) / len(first) if len(first) >= 5 else 0.0
    vol5 = sum(t[2] or 0 for t in recent)
    hi_before = max((p for ts, p in pts if now - 180 <= ts < now - 30), default=None)
    pros = len(getattr(L, "pros", None) or ())
    it = getattr(L, "intel", None) or {}
    clusters = it.get("clusters") or []
    cl_hold = max((sum(bal.get(w, 0.0) for w in (c.get("wallets") or [])) for c in clusters), default=0.0) / SUPPLY * 100
    d = getattr(L, "dev", None) or {}
    dev_tok, dev_sold = getattr(L, "dev_tokens", 0) or 0, getattr(L, "dev_sold_tokens", 0) or 0
    dev = getattr(L, "deployer", None)
    dev_hold = bal.get(dev, 0.0) / SUPPLY * 100 if dev else 0.0
    return {
        "vol_1m": vol1, "vol_prev": vol_prev, "vol_accel": (vol1 + 0.2) / (vol_prev + 0.2), "liq": liq, "liq_2m": liq_2m,
        "liq_delta": liq - liq_2m, "liq_drain_pct": max(0.0, (liq_2m - liq) / liq_2m) if liq_2m > 1 else 0.0,
        "ret_30s": p_now / p_30 - 1 if p_30 else 0.0, "ret_2m": p_now / p_2m - 1 if p_2m else 0.0,
        "drop_60": max(0.0, 1 - p_now / peak_60) if peak_60 else 0.0, "net_30s": net_30, "quiet_s": max(0.0, now - last_ts),
        "ape_10s": r10, "ape_prev10": prev10, "early_out": early_out, "turnover": vol5 / max(1.0, liq),
        "breakout": 1.0 if hi_before and p_now >= hi_before and (vol1 + 0.2) / (vol_prev + 0.2) >= 1.5 else 0.0,
        "pro_share": pros / max(1, holders), "progress": liq / 85.0,
        "holders": holders, "joined_1m": joined, "left_3m": left, "drawdown": max(0.0, drawdown), "vertical": vertical,
        "stairs": stairs, "vola": vola, "top3_sell": top3_sell, "big_sell_liq": big_sell / max(1.0, liq), "sell_streak": streak,
        "sell_vol_3m": sell_vol, "wash": wash, "wallets_5m": len(seen), "avg_buy": avg_buy, "retail": retail,
        "coord_wallets": len(coord_wallets), "coord_hold": coord_hold, "clusters": len(clusters), "cluster_hold": cl_hold,
        "dev_hold": dev_hold, "dev_sold_frac": (dev_sold / dev_tok) if dev_tok else 0.0,
        "dev_buy_pct": getattr(L, "dev_buy_pct", None) or 0.0, "dev_launches": d.get("launches") or 0, "dev_grads": d.get("graduated") or 0,
        "dev_fresh": 1.0 if it.get("dev_fresh") else 0.0, "graduated": 1.0 if getattr(L, "graduated_at", None) else 0.0,
    }


def normalise(c: dict[str, float], age_s: float, mcap_usd: float | None) -> dict[str, float]:
    """Brain-ready features in [−1, 1] / [0, 1]. Age and market cap are bucketed so a linear model can learn
    'too early', 'sweet spot' and 'too late' separately instead of one straight line."""
    mc = mcap_usd or 0
    return {
        "vol_accel": _clip(math.log2(max(0.25, c["vol_accel"])) / 3, -1, 1),
        "vol_1m": _clip(math.log10(1 + c["vol_1m"]) / 2),
        "mom_30s": _clip(c["ret_30s"] / 0.3, -1, 1),
        "mom_2m": _clip(c["ret_2m"] / 0.6, -1, 1),
        "quiet": _clip((c["quiet_s"] - 20) / 120),
        "ape_wave": _clip(c["ape_10s"] / 4),
        "ape_accel": _clip(math.log2((c["ape_10s"] + 0.5) / (c["ape_prev10"] + 0.5)) / 2, -1, 1),
        # buyers drying up right at the highs after a run: the classic top
        "exhaustion": (1.0 if c["drop_60"] < 0.08 and c["ret_2m"] > 0.3 else 0.0)
        * _clip(-math.log2((c["ape_10s"] + 0.5) / (c["ape_prev10"] + 0.5)) / 2),
        "early_exit": c["early_out"],
        "turnover": _clip(c["turnover"] / 6),
        "breakout": c["breakout"],
        # a real dip that buyers are stepping back into (the "holds bids" entry), not a falling knife
        "dip_reclaim": 1.0 if 0.2 <= c["drawdown"] <= 0.5 and c["ret_30s"] > 0.03 and c["net_30s"] > 0 else 0.0,
        "near_grad": 1.0 if 0.75 <= c["progress"] < 1 and not c["graduated"] else 0.0,
        "pro_share": _clip(c["pro_share"] / 0.15),
        "liq": _clip(c["liq"] / 60),
        "liq_influx": _clip(c["liq_delta"] / 10, -1, 1),
        "liq_drain": _clip(c["liq_drain_pct"] / 0.4),
        "holders": _clip(math.log10(1 + c["holders"]) / 2.5),
        "holder_growth": _clip(c["joined_1m"] / 15),
        "holders_leaving": _clip(c["left_3m"] / 10),
        "drawdown": _clip(c["drawdown"] / 0.6),
        "vertical": _clip((c["vertical"] - 1.4) / 2),
        "staircase": c["stairs"],
        "volatility": _clip(c["vola"] / 0.15),
        "whale_sells": _clip((c["top3_sell"] - 0.4) / 0.5) if c["sell_vol_3m"] > 0.5 else 0.0,
        "dump_candle": _clip(c["big_sell_liq"] / 0.25),
        "sell_streak": _clip(c["sell_streak"] / 6),
        "wash": _clip(c["wash"] / max(4.0, c["wallets_5m"] * 0.3)),
        "retail": c["retail"],
        "whale_buys": _clip(c["avg_buy"] / 3),
        "coordinated": _clip(c["coord_hold"] / 20),
        "clusters": _clip(c["clusters"] / 3),
        "cluster_hold": _clip(c["cluster_hold"] / 20),
        "dev_hold": _clip(c["dev_hold"] / 15),
        "dev_dumping": _clip(c["dev_sold_frac"]),
        "dev_big_buy": _clip(c["dev_buy_pct"] / 20),
        "dev_serial": 1.0 if c["dev_launches"] >= 5 and not c["dev_grads"] else 0.4 if c["dev_launches"] >= 2 and not c["dev_grads"] else 0.0,
        "dev_fresh": c["dev_fresh"],
        "graduated": c["graduated"],
        "age_0_2m": 1.0 if age_s < 120 else 0.0, "age_2_5m": 1.0 if 120 <= age_s < 300 else 0.0,
        "age_5_15m": 1.0 if 300 <= age_s < 900 else 0.0, "age_15m": 1.0 if age_s >= 900 else 0.0,
        "mc_lt8k": 1.0 if 0 < mc < 8000 else 0.0, "mc_8_25k": 1.0 if 8000 <= mc < 25000 else 0.0,
        "mc_25_70k": 1.0 if 25000 <= mc < 70000 else 0.0, "mc_70k": 1.0 if mc >= 70000 else 0.0,
    }


def rug_alarm(c: dict[str, float]) -> str | None:
    """The tells that mean 'get out now' — checked on every tick while holding, and as a veto before buying."""
    if c["liq_drain_pct"] >= 0.35 and c["liq_2m"] >= 3:
        return f"liquidity drained {c['liq_drain_pct'] * 100:.0f}% in 2 min"
    if c["big_sell_liq"] >= 0.3 and c["liq"] >= 2:
        return f"one sell dumped {c['big_sell_liq'] * 100:.0f}% of the liquidity"
    if c["dev_sold_frac"] >= 0.5 and c["drawdown"] >= 0.3:
        return "dev dumped into a falling chart"
    if c["top3_sell"] >= 0.75 and c["sell_streak"] >= 5 and c["sell_vol_3m"] >= 3:
        return f"whales unloading ({c['sell_streak']} sells in a row)"
    if c["cluster_hold"] >= 30 or c["coord_hold"] >= 35:
        return f"one hand holds {max(c['cluster_hold'], c['coord_hold']):.0f}% (bubble map)"
    return None


def tags(f: dict[str, float], trigger: str) -> list[str]:
    """Readable buckets the brain keeps a win/loss record for — 'patterns' it can be discouraged (or encouraged) by."""
    t = [f"trigger:{trigger}"]
    t.append("age:<2m" if f.get("age_0_2m") else "age:2-5m" if f.get("age_2_5m") else "age:5-15m" if f.get("age_5_15m") else "age:15m+")
    t.append("mcap:<8k" if f.get("mc_lt8k") else "mcap:8-25k" if f.get("mc_8_25k") else "mcap:25-70k" if f.get("mc_25_70k")
             else "mcap:70k+" if f.get("mc_70k") else "mcap:?")
    h = f.get("holders", 0)
    t.append("holders:few" if h < 0.5 else "holders:some" if h < 0.7 else "holders:many")
    top10 = f.get("top10", 0)
    t.append("top10:<20%" if top10 < 0.33 else "top10:20-35%" if top10 < 0.58 else "top10:35%+")
    for key, name, cut in (("narrative", "narrative", 0.3), ("x_calls", "x-called", 0.4), ("copy", "copy-signal", 0.3),
                           ("vertical", "vertical-candle", 0.4), ("liq_drain", "liquidity-draining", 0.3),
                           ("vol_accel", "volume-surging", 0.33), ("staircase", "higher-lows", 0.75), ("dev_serial", "serial-dev", 0.5),
                           ("dev_fresh", "fresh-dev", 0.5), ("coordinated", "coordinated-buys", 0.25), ("cluster_hold", "clustered-holders", 0.25),
                           ("insiders", "insiders", 0.2), ("bundle", "bundlers", 0.3), ("snipers", "snipers-heavy", 0.5),
                           ("whale_buys", "whale-buyers", 0.5), ("drawdown", "off-the-highs", 0.5), ("tweet", "tweet-spawned", 0.3),
                           ("dev_hold", "dev-holding", 0.5), ("graduated", "graduated", 0.5), ("ape_wave", "ape-wave", 0.5),
                           ("exhaustion", "exhausted-top", 0.3), ("early_exit", "early-holders-out", 0.5), ("breakout", "breakout", 0.5),
                           ("dip_reclaim", "dip-reclaim", 0.5), ("near_grad", "near-graduation", 0.5), ("mom_30s", "momentum-up", 0.3)):
        if f.get(key, 0) >= cut:
            t.append(name)
    return t


TAG_TEXT = {
    "trigger:brain": "its own picks", "trigger:copy": "copy-trades", "trigger:explore": "exploration buys",
    "age:<2m": "coins under 2 min old", "age:2-5m": "coins 2-5 min old", "age:5-15m": "coins 5-15 min old", "age:15m+": "coins over 15 min old",
    "mcap:<8k": "market cap under $8k", "mcap:8-25k": "market cap $8-25k", "mcap:25-70k": "market cap $25-70k", "mcap:70k+": "market cap over $70k",
    "holders:few": "few holders", "holders:some": "a few dozen holders", "holders:many": "lots of holders",
    "top10:<20%": "top-10 under 20%", "top10:20-35%": "top-10 at 20-35%", "top10:35%+": "top-10 over 35%",
    "narrative": "a live narrative", "x-called": "calls from tracked X accounts", "copy-signal": "top wallets buying",
    "vertical-candle": "a vertical last-minute candle", "liquidity-draining": "liquidity draining", "volume-surging": "volume surging",
    "higher-lows": "a staircase of higher lows", "serial-dev": "serial-launcher devs", "fresh-dev": "brand-new dev wallets",
    "coordinated-buys": "coordinated buys (bubble map)", "clustered-holders": "funder-linked holder clusters", "insiders": "insiders holding",
    "bundlers": "bundlers holding", "snipers-heavy": "snipers holding a lot", "whale-buyers": "whale-sized buys",
    "off-the-highs": "charts already well off the highs", "tweet-spawned": "tweet-spawned coins", "dev-holding": "devs still holding a lot",
    "graduated": "graduated coins", "ape-wave": "ape waves (lots of new buyers)", "exhausted-top": "buying at an exhausted top",
    "early-holders-out": "coins whose first buyers already sold", "breakout": "breakouts above the recent high",
    "dip-reclaim": "dips that buyers stepped back into", "near-graduation": "coins about to graduate", "momentum-up": "coins already moving up",
}

