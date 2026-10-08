"""Radar Score v1: pure functions, so every signal can be recomputed from its logged inputs (backtests)."""
from __future__ import annotations

import time
from typing import Any

GRADES = [(85, "A"), (70, "B"), (55, "C"), (40, "D"), (25, "E"), (-1, "F")]
CONF_RANK = {"low": 0, "medium": 1, "high": 2}


def _clamp(x: float, lo: float = 0, hi: float = 100) -> float:
    return max(lo, min(hi, x))


# price-driver thresholds; defaults keep older configs and DB overrides working
DRIVER_DEFAULTS = {
    "liq_mcap_good": 0.10, "liq_mcap_thin": 0.03, "liq_removed_bad_pct": 20,
    "max_holder_bad_pct": 5, "top10_rise_bad_pts": 5,
    "mentions_good_per_h": 30, "mention_accel_good": 2.0, "social_blend": 0.25,
    "dev_selling_now_penalty": 20, "serial_launcher_7d": 5, "serial_launcher_penalty": 15,
    "graduation_window_h": 6,
    "vol_accel_good": 2.0, "net_sol_good": 20, "whale_buy_sol": 5, "whale_sells_bad": 2,
    "churn_bad_trades_per_wallet": 6, "churn_min_trades": 30, "extended_h1_pct": 300,
    "negative_news_penalty": 30, "negative_sentiment": -0.3,
}


def _drv(c: dict[str, Any]) -> dict[str, Any]:
    return {**DRIVER_DEFAULTS, **(c.get("drivers") or {})}


def momentum_score(t: dict[str, Any], ticks: list[dict[str, Any]], c: dict[str, Any], why: list[str],
                   flow: dict[str, Any] | None = None, drivers: dict[str, Any] | None = None) -> float | None:
    if t.get("price_usd") is None:
        return None
    m = c["momentum"]
    mcap = t.get("market_cap") or t.get("fdv")
    parts = []
    if mcap and t.get("vol_h24") is not None:
        r = t["vol_h24"] / mcap
        parts.append(_clamp(r / m["vol_mcap_good"] * 100))
        if r >= m["vol_mcap_good"]:
            why.append(f"24h volume is {r * 100:.0f}% of market cap")
    b, s = t.get("buys_m5") or 0, t.get("sells_m5") or 0
    if b + s:
        ratio = b / max(1, s)
        parts.append(_clamp((ratio - 0.6) / (m["buy_sell_good"] - 0.6) * 100))
        parts.append(_clamp((b + s) / m["min_txns_5m"] * 100))
        if ratio >= m["buy_sell_good"]:
            why.append(f"buyers outnumber sellers {ratio:.1f}:1 in the last 5m ({b + s} txns)")
        elif ratio < 0.8:
            why.append(f"sellers dominate the last 5m ({b} buys / {s} sells)")
    if t.get("liquidity_usd") is not None:
        parts.append(_clamp(t["liquidity_usd"] / m["liquidity_good_usd"] * 100))
    # price structure + liquidity growth from our own stored ticks (oldest -> newest)
    pts = [x for x in ticks if x.get("price_usd")]
    if len(pts) >= 6:
        third = len(pts) // 3
        lows = [min(p["price_usd"] for p in pts[i * third:(i + 1) * third]) for i in range(3)]
        if lows[0] < lows[1] < lows[2]:
            parts.append(100)
            why.append("higher lows across the last ticks (not a single spike)")
        elif lows[2] < lows[0]:
            parts.append(10)
            why.append("making lower lows")
        else:
            parts.append(50)
        liq0, liq1 = pts[0].get("liquidity_usd"), pts[-1].get("liquidity_usd")
        if liq0 and liq1:
            g = (liq1 / liq0 - 1) * 100
            parts.append(_clamp(50 + g * 2))
    flow = flow or {}
    ub = flow.get("unique_buyers_5m")
    if ub:
        parts.append(_clamp(ub / 5 / m.get("unique_buyers_per_min_good", 10) * 100))
        if ub / 5 >= m.get("unique_buyers_per_min_good", 10):
            why.append(f"{ub / 5:.0f} unique buyers/min (many small buyers)")
    hg = flow.get("holder_growth_pct_1h")
    if hg is not None:
        parts.append(_clamp(50 + hg * 2))
        if hg >= 20:
            why.append(f"holders up {hg:.0f}% in the last hour")
        elif hg < 0:
            why.append(f"holder count shrinking ({hg:.0f}% in 1h)")
    d, k = drivers or {}, _drv(c)
    lm = d.get("liq_mcap_ratio")
    if lm is not None:
        parts.append(_clamp(lm / k["liq_mcap_good"] * 100))
        if lm >= k["liq_mcap_good"]:
            why.append(f"deep liquidity ({lm * 100:.0f}% of market cap)")
    accs = [x for x in (d.get("vol_accel_5m"), d.get("vol_accel_1h")) if x is not None]
    if accs:
        acc = max(accs)
        parts.append(_clamp((acc - 0.5) / (k["vol_accel_good"] - 0.5) * 100))
        if acc >= k["vol_accel_good"]:
            why.append(f"volume accelerating ({acc:.1f}x its recent pace)")
    bs1 = d.get("buy_sell_1h")
    if bs1 is not None:
        parts.append(_clamp((bs1 - 0.6) / (m["buy_sell_good"] - 0.6) * 100))
    net = d.get("net_sol_15m")
    if net is not None and d.get("trades_15m"):
        parts.append(_clamp(50 + net / k["net_sol_good"] * 50))
        if net >= k["net_sol_good"] / 2:
            why.append(f"net {net:+.1f} SOL of buying in 15m")
        elif net <= -k["net_sol_good"] / 2:
            why.append(f"net {net:+.1f} SOL of selling in 15m")
    if d.get("whale_buys_15m"):
        why.append(f"{d['whale_buys_15m']} whale buy(s) of {k['whale_buy_sol']}+ SOL in 15m")
    return sum(parts) / len(parts) if parts else None


def safety_score(t: dict[str, Any], s: dict[str, Any] | None, c: dict[str, Any], why: list[str],
                 flow: dict[str, Any] | None = None, drivers: dict[str, Any] | None = None) -> float | None:
    if not s:
        return None
    k = c["safety"]
    score = 100.0
    if s.get("mint_authority"):
        score = 0
    if s.get("freeze_authority"):
        score = 0
    lp = s.get("lp_locked_pct")
    if lp is not None and lp < k["lp_locked_good_pct"]:
        score -= (k["lp_locked_good_pct"] - lp) * 0.6
        why.append(f"only {lp:.0f}% of LP locked/burned")
    t10 = s.get("top10_pct")
    if t10 is not None and t10 > k["top10_good_pct"]:
        score -= (t10 - k["top10_good_pct"]) * 2
        why.append(f"top-10 holders own {t10:.1f}%")
    ins = s.get("insiders_detected") or 0
    if ins >= k["insiders_bad"]:
        score -= 25
        why.append(f"{ins} insider wallets detected")
    rn = s.get("score_normalised")
    if rn is not None:
        score -= float(rn) * 0.4
    flow = flow or {}
    if (flow.get("dev_initial_buy_pct") or 0) > k.get("dev_buy_bad_pct", 10):
        score -= 15
        why.append(f"dev bought {flow['dev_initial_buy_pct']:.1f}% of supply at launch")
    if (flow.get("dev_sold_pct") or 0) >= k.get("dev_sold_bad_pct", 50):
        score -= 20
        why.append(f"dev has sold {flow['dev_sold_pct']:.0f}% of their tokens")
    if (flow.get("sniper_supply_pct") or 0) >= k.get("sniper_bad_pct", 15):
        score -= 25
        why.append(f"{flow['sniper_supply_pct']:.0f}% of supply sniped/bundled in the first 5s by {flow.get('sniper_wallets')} wallets")
    if t.get("boost_amount"):
        score -= k["boost_penalty"]
        why.append(f"paid DexScreener boosts active ({t['boost_amount']}), often exit liquidity")
    d, kd = drivers or {}, _drv(c)
    lm = d.get("liq_mcap_ratio")
    if lm is not None and lm < kd["liq_mcap_thin"]:
        score -= 15
        why.append(f"thin liquidity: only {lm * 100:.1f}% of market cap, easy to move either way")
    lr = d.get("liq_removed_pct_1h")
    if lr is not None and lr >= kd["liq_removed_bad_pct"]:
        score -= 30
        why.append(f"{lr:.0f}% of pool liquidity withdrawn in the last hour (beyond the price move)")
    mh = d.get("max_holder_pct")
    if mh is not None and mh > kd["max_holder_bad_pct"]:
        score -= (mh - kd["max_holder_bad_pct"]) * 2
        why.append(f"one wallet holds {mh:.1f}% of supply")
    tc = d.get("top10_chg_pts_1h")
    if tc is not None and tc >= kd["top10_rise_bad_pts"]:
        score -= 10
        why.append(f"supply concentrating: top-10 share up {tc:.1f} pts in 1h")
    if d.get("dev_sells_15m"):
        score -= kd["dev_selling_now_penalty"]
        why.append(f"dev wallet sold in the last 15m ({d['dev_sells_15m']} sells, {d.get('dev_sold_sol_15m') or 0:.2f} SOL)")
    if (d.get("whale_sells_15m") or 0) >= kd["whale_sells_bad"]:
        score -= 10
        why.append(f"{d['whale_sells_15m']} whale sells of {kd['whale_buy_sol']}+ SOL in 15m")
    tpw = d.get("trades_per_wallet_15m")
    if tpw is not None and tpw >= kd["churn_bad_trades_per_wallet"] and (d.get("trades_15m") or 0) >= kd["churn_min_trades"]:
        score -= 15
        why.append(f"likely wash/bot trading: {tpw:.1f} trades per wallet in 15m")
    h1 = d.get("chg_h1")
    if h1 is not None and h1 >= kd["extended_h1_pct"]:
        score -= 10
        why.append(f"already up {h1:.0f}% in 1h: late entries are exit liquidity")
    if d.get("negative_news"):
        score -= kd["negative_news_penalty"]
        why.append(f"negative headline: \"{d['negative_news'][:90]}\"")
    dl = d.get("deployer_launches_7d")
    if dl is not None and dl >= kd["serial_launcher_7d"]:
        score -= kd["serial_launcher_penalty"]
        why.append(f"serial launcher: deployer created {dl} tokens in 7 days")
    return _clamp(score)


def social_volume_score(d: dict[str, Any] | None, c: dict[str, Any], why: list[str]) -> float | None:
    """Posts naming this token's CA or $TICKER: volume this hour, and acceleration vs the hour before."""
    d = d or {}
    m = d.get("mentions_1h")
    if m is None or (not m and not d.get("mentions_prev_1h")):
        return None
    k = _drv(c)
    vol = _clamp(m / k["mentions_good_per_h"] * 100)
    prev = d.get("mentions_prev_1h") or 0
    accel = m / prev if prev else (k["mention_accel_good"] if m >= 3 else 1.0)
    acc = _clamp(50 + (accel - 1) / (k["mention_accel_good"] - 1) * 50)
    if m >= 3 and accel >= k["mention_accel_good"]:
        why.append(f"social volume accelerating: {m:.0f} posts on this token in 1h ({accel:.1f}x the prior hour, "
                   f"{d.get('mention_authors_1h') or 0} authors)")
    elif prev >= 3 and accel < 0.5:
        why.append(f"social volume fading ({m:.0f} posts vs {prev:.0f} the hour before)")
    return 0.6 * vol + 0.4 * acc


def narrative_score(n: dict[str, Any] | None, c: dict[str, Any], why: list[str],
                    drivers: dict[str, Any] | None = None) -> float | None:
    soc = social_volume_score(drivers, c, why)
    nar = _narrative_only(n, c, why)
    if nar is None or soc is None:
        return nar if soc is None else soc
    if n and n.get("is_likely_fake"):
        return nar
    b = _drv(c)["social_blend"]
    return _clamp((1 - b) * nar + b * soc, -40, 100)


def _narrative_only(n: dict[str, Any] | None, c: dict[str, Any], why: list[str]) -> float | None:
    if not n:
        return None
    k = c["narrative"]
    if n.get("is_likely_fake"):
        why.append(f"likely a copycat of the '{n.get('title')}' narrative")
        return 0
    stage = k["stage_scores"].get(n.get("stage") or "birth", 50)
    vel = _clamp((n.get("vel_5m") or 0) / k["velocity_good_per_min"] * 100)
    spread = _clamp(len(n.get("sources") or []) / k["cross_platform_good"] * 100)
    reach = _clamp(n.get("reach_score") or 0)
    bot_pen = (n.get("bot_share") or 0) * 50
    sent = n.get("sentiment")
    if sent is not None and sent <= _drv(c)["negative_sentiment"]:
        bot_pen += 15
        why.append(f"narrative sentiment is negative ({sent:+.2f})")
    why.append(f"linked narrative '{n.get('title')}' is in {(n.get('stage') or 'birth').upper()} "
               f"({n.get('vel_5m') or 0:.1f} mentions/min across {len(n.get('sources') or [])} sources)")
    return _clamp(0.4 * stage + 0.3 * vel + 0.2 * spread + 0.1 * reach - bot_pen, -40, 100)


def catalyst_score(t: dict[str, Any], n: dict[str, Any] | None, c: dict[str, Any], why: list[str],
                   drivers: dict[str, Any] | None = None) -> float | None:
    k = c["catalyst"]
    best = None
    d, kd = drivers or {}, _drv(c)
    # token-specific listing events: these name this coin, so they outrank narrative-level flags of equal weight
    listings = []
    if d.get("cex_listing"):
        listings.append((k.get("cex_listing", 80), f"exchange listing: \"{d['cex_listing'][:90]}\""))
    if d.get("coingecko_trending_rank"):
        listings.append((k.get("coingecko_trending", 45), f"#{d['coingecko_trending_rank']} on CoinGecko trending"))
    g = d.get("graduated_h_ago")
    if g is not None and g <= kd["graduation_window_h"]:
        listings.append((k.get("graduation", 40), f"graduated from pump.fun to a DEX pool {g:.1f}h ago"))
    if d.get("kol_calls_1h"):
        listings.append((k.get("kol_call", 35), f"{d['kol_calls_1h']} KOL(s) posted the contract address in the last hour"))
    for pts, msg in listings:
        why.append(msg)
    if listings:
        best = max(p for p, _ in listings)
    if n:
        msg, pts = "", None
        if n.get("vip_ca_match"):
            pts, msg = k["vip_ca"], "contract address posted by a VIP/official account"
        elif n.get("vip_mention"):
            pts, msg = k["vip_mention"], "a VIP account is talking about this narrative"
        elif n.get("exchange_listing"):
            pts, msg = k["exchange_listing"], "exchange-listing news"
        elif n.get("breaking_news"):
            pts, msg = k["breaking_news"], "breaking-news catalyst"
        if msg:
            why.append(msg)
            best = max(best or 0, pts)
    if best is None and t.get("boost_amount"):
        best = k["paid_promo"]
    return best


def smart_money_score(sm: dict[str, Any] | None, c: dict[str, Any], why: list[str]) -> float | None:
    if not sm or not sm.get("tracking"):
        return None
    k = c["smart_money"]
    n = sm.get("smart_buyers", 0)
    score = _clamp(n / k["full_credit_wallets"] * 100)
    if n:
        why.append(f"{n} tracked profitable wallet(s) bought in the last hour")
    if sm.get("kol_selling"):
        score -= k["kol_sell_penalty"]
        why.append("a KOL is selling while posting about it (shill-and-dump)")
    return _clamp(score)


def regime_multiplier(r: dict[str, Any] | None, c: dict[str, Any], why: list[str]) -> float:
    if not r:
        return 1.0
    k = c["regime"]
    off = []
    if r.get("btc_chg_24h") is not None and r["btc_chg_24h"] <= k["btc_down_24h_pct"]:
        off.append(f"BTC {r['btc_chg_24h']:+.1f}%")
    if r.get("sol_chg_24h") is not None and r["sol_chg_24h"] <= k["sol_down_24h_pct"]:
        off.append(f"SOL {r['sol_chg_24h']:+.1f}%")
    if r.get("meme_chg_24h") is not None and r["meme_chg_24h"] <= k.get("meme_down_24h_pct", -8):
        off.append(f"meme sector {r['meme_chg_24h']:+.1f}%")
    if r.get("fear_greed") is not None and r["fear_greed"] <= k["fear_greed_low"]:
        off.append(f"Fear & Greed {r['fear_greed']:.0f}")
    if off:
        why.append("risk-off market (" + ", ".join(off) + ")")
        return k["risk_off_multiplier"]
    if r.get("sol_chg_24h") is not None and r["sol_chg_24h"] > 0 and (r.get("fear_greed") or 50) >= 55:
        return k["risk_on_multiplier"]
    return 1.0


def vetoes(t: dict[str, Any], s: dict[str, Any] | None, n: dict[str, Any] | None, dev: dict[str, Any] | None,
           c: dict[str, Any], drivers: dict[str, Any] | None = None) -> list[str]:
    v = c["vetoes"]
    out = []
    lr = (drivers or {}).get("liq_removed_pct_1h")
    mx = v.get("max_liq_removed_pct_1h")
    if lr is not None and mx is not None and lr >= mx:
        out.append(f"{lr:.0f}% of liquidity withdrawn in 1h (>= {mx}%)")
    if s:
        if v["mint_authority_active"] and s.get("mint_authority"):
            out.append("Mint authority is active")
        if v["freeze_authority_active"] and s.get("freeze_authority"):
            out.append("Freeze authority is active")
        if s.get("top10_pct") is not None and s["top10_pct"] > v["max_top10_pct"]:
            out.append(f"Top-10 holders own {s['top10_pct']:.0f}% (> {v['max_top10_pct']}%)")
        if v["rugged"] and s.get("rugged"):
            out.append("RugCheck marks it rugged")
        if s.get("score_normalised") is not None and s["score_normalised"] > v["max_rugcheck_score_normalised"]:
            out.append(f"RugCheck risk score {s['score_normalised']} (> {v['max_rugcheck_score_normalised']})")
    if t.get("liquidity_usd") is not None and t["liquidity_usd"] < v["min_liquidity_usd"]:
        out.append(f"Liquidity ${t['liquidity_usd']:,.0f} below ${v['min_liquidity_usd']:,}")
    if v["deployer_rug_history"] and dev and dev.get("rugged_tokens", 0) > 0:
        out.append(f"Deployer linked to {dev['rugged_tokens']} rugged token(s)")
    if v["likely_fake_of_vip"] and n and n.get("is_likely_fake") and (n.get("vip_mention") or n.get("vip_ca")):
        out.append("Likely fake copy of a VIP coin")
    return out


def plan(t: dict[str, Any], n: dict[str, Any] | None, confidence: str, risk: dict[str, Any], c: dict[str, Any],
         now: float) -> dict[str, Any]:
    p = c["plan"]
    px = t.get("price_usd")
    size_pct = float(risk.get("max_pct_per_trade", 1.5)) * {"high": 1.0, "medium": 0.75, "low": 0.4}[confidence]
    size_usd = round(float(risk.get("bankroll_usd", 0)) * size_pct / 100, 2)
    life_h = p["time_stop_hours"]
    if n and n.get("expected_life_h") and n.get("first_seen"):
        left = n["expected_life_h"] - (now - n["first_seen"]) / 3600
        life_h = max(1.0, min(life_h, left))
    return {
        "entry_low": px, "entry_high": px * (1 + p["entry_zone_pct"] / 100) if px else None,
        "size_usd": size_usd, "size_pct": round(size_pct, 2),
        "stop_price": px * (1 - p["stop_pct"] / 100) if px else None, "stop_pct": p["stop_pct"],
        "ladder": [{"multiple": m, "sell_fraction": f, "price": px * m if px else None} for m, f in p["take_profit_ladder"]],
        "time_stop_ts": now + life_h * 3600, "time_stop_hours": round(life_h, 1),
        "invalidation": f"close below ${px * (1 - p['stop_pct'] / 100):.10g}, liquidity pulled, or narrative turns FADING" if px else None,
    }


def evaluate(inp: dict[str, Any], c: dict[str, Any], risk: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    """inp = {token, safety, narrative, smart_money, regime, dev, ticks}. Returns the full signal."""
    now = now or time.time()
    t, s, n = inp.get("token") or {}, inp.get("safety"), inp.get("narrative")
    why: list[str] = []
    risks: list[str] = []
    d = inp.get("drivers")
    subs = {
        "narrative": narrative_score(n, c, why, d),
        "catalyst": catalyst_score(t, n, c, why, d),
        "momentum": momentum_score(t, inp.get("ticks") or [], c, why, inp.get("flow"), d),
        "smart_money": smart_money_score(inp.get("smart_money"), c, why),
        "safety": safety_score(t, s, c, risks, inp.get("flow"), d),
    }
    w = c["weights"]
    total_w = sum(w.values())
    raw = sum((subs[k] or 0) * w[k] for k in w) / total_w
    mult = regime_multiplier(inp.get("regime"), c, why)
    score = round(_clamp(raw * mult), 1)

    present = sum(v is not None for v in subs.values()) + (1 if inp.get("regime") else 0) + \
        (1 if len(inp.get("ticks") or []) >= 6 else 0)
    k = c["confidence"]
    confidence = "high" if present >= k["high_min_inputs"] else "medium" if present >= k["medium_min_inputs"] else "low"

    vs = vetoes(t, s, n, inp.get("dev"), c, d)
    sv = subs["safety"]
    grade = "F" if vs else next(g for th, g in GRADES if (sv if sv is not None else 30) >= th)
    vd = c["verdict"]
    if vs:
        verdict = "AVOID"
    elif (score >= vd["buy_min_score"] and CONF_RANK[confidence] >= CONF_RANK[vd["buy_min_confidence"]]
          and (s or not c["vetoes"]["require_safety_report"])):
        verdict = "BUY"
    elif score >= vd["watch_min_score"]:
        verdict = "WATCH"
    else:
        verdict = "AVOID"
    if not s and c["vetoes"]["require_safety_report"]:
        risks.append("no safety report yet")
    return {
        "ts": now, "verdict": verdict, "score": score, "confidence": confidence, "risk_grade": grade,
        "subscores": {k2: (round(v, 1) if v is not None else None) for k2, v in subs.items()},
        "regime_multiplier": mult, "vetoes": vs, "reasons": why, "risks": risks,
        "plan": plan(t, n, confidence, risk, c, now) if t.get("price_usd") else None,
    }
