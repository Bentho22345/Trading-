"""Trader-terminal metrics for a live pump.fun launch, plus Upside / Risk scores and the strategy rule engine.

Everything is computed from Radar's own copy of the coin's trade stream (subscribed from the create event), so the
numbers mean the same thing the big terminals' filters do — holders, top-10 %, dev %, snipers %, bundlers %, pro
traders, dev sold — without scraping anyone. `coverage_pct` says how much of the bonding curve's SOL we actually saw
trade; when it is low (we subscribed late), holder-based metrics are marked partial instead of being trusted blindly.
"""
from __future__ import annotations

import re
from typing import Any

PUMP_SUPPLY = 1e9
CURVE_START_SOL = 30.0

# metric -> (label, unit, kind) — the single list the UI filter builder, playbook extractor and strategies all use
METRICS: dict[str, tuple[str, str, str]] = {
    "age_s": ("Age", "s", "num"), "mcap_usd": ("Market cap", "$", "num"), "progress": ("Bonding curve", "%", "num"),
    "holders": ("Holders", "", "num"), "top10_pct": ("Top 10 holders", "%", "num"), "dev_hold_pct": ("Dev holding", "%", "num"),
    "dev_sold": ("Dev sold", "", "bool"), "snipers_hold_pct": ("Snipers holding", "%", "num"), "snipers": ("Sniper wallets", "", "num"),
    "bundle_hold_pct": ("Bundlers holding", "%", "num"), "pro_traders": ("Pro traders in", "", "num"), "alpha": ("Top-1,000 wallets in", "", "num"),
    "buys_1m": ("Buys 1m", "", "num"), "sells_1m": ("Sells 1m", "", "num"), "buy_ratio_1m": ("Buy/sell 1m", "×", "num"),
    "vol_1m_usd": ("Volume 1m", "$", "num"), "vol_5m_usd": ("Volume 5m", "$", "num"), "net_sol_1m": ("Net SOL in 1m", "◎", "num"),
    "buyers": ("Unique buyers", "", "num"), "sol_per_min": ("Curve SOL/min", "◎", "num"), "eta_min": ("Graduation ETA", "min", "num"),
    "has_twitter": ("Has X / Twitter", "", "bool"), "has_telegram": ("Has Telegram", "", "bool"), "has_website": ("Has website", "", "bool"),
    "socials": ("Social links", "", "num"), "social_authors": ("People posting it", "", "num"), "social_engagement": ("Post engagement", "", "num"),
    "meta_hot": ("Hot meta", "", "bool"), "x_community": ("X community link", "", "bool"), "organic": ("Organic score", "", "num"), "bundled": ("Bundled", "", "bool"),
    "dev_graduated": ("Dev's past graduations", "", "num"), "upside": ("Upside", "", "num"), "risk": ("Risk", "", "num"),
    # on-chain intel (Helius) — only present once the launch was scanned; missing never matches a rule
    "insiders": ("Linked insider wallets", "", "num"), "insider_hold_pct": ("Insiders holding", "%", "num"),
    "fresh_pct": ("Fresh wallets among early buyers", "%", "num"), "fresh_hold_pct": ("Fresh wallets holding", "%", "num"),
    "chain_top10_pct": ("Top 10 (on-chain)", "%", "num"), "bot_wallets": ("Bot wallets early", "", "num"),
    # buzz (YouTube + Claude)
    "yt_videos": ("YouTube videos (48h)", "", "num"), "yt_views": ("YouTube views", "", "num"),
    "ai_meme_score": ("AI meme score", "/10", "num"), "ai_derivative": ("AI: derivative / copy", "", "bool"),
    # X Radar (coin launched off a tracked tweet)
    "x_tweet_score": ("Source tweet score", "", "num"), "x_spawn_rank": ("Coin # off the tweet", "", "num"),
    "x_delay_s": ("Seconds after the tweet", "s", "num"), "x_top_account": ("Tweet from an S-tier account", "", "bool"),
}
OPS = {"<=": lambda a, b: a <= b, ">=": lambda a, b: a >= b, "<": lambda a, b: a < b, ">": lambda a, b: a > b,
       "==": lambda a, b: a == b, "!=": lambda a, b: a != b}

TWITTER_RX = re.compile(r"(?:twitter\.com|x\.com)/(i/communities/\d+|[^/?#\s]+/status/\d+|[A-Za-z0-9_]{1,15})", re.I)


def twitter_kind(url: str | None) -> str | None:
    """'community' | 'post' | 'profile' — traders read these very differently (a community link is the CTO norm)."""
    m = TWITTER_RX.search(url or "")
    if not m:
        return None
    s = m.group(1).lower()
    return "community" if s.startswith("i/communities") else "post" if "/status/" in s else "profile"


def compute(L: Any, now: float, sol_usd: float | None, ctx: dict[str, Any]) -> dict[str, Any]:
    trades = list(L.trades)
    m1 = [t for t in trades if t[0] >= now - 60]
    m5 = [t for t in trades if t[0] >= now - 300]
    px = sol_usd or 0.0
    bal = {w: b for w, b in L.balances.items() if b > 1}
    top = sorted(bal.values(), reverse=True)
    dev_hold = bal.get(L.deployer, 0.0) if L.deployer else 0.0
    snipers = [w for w in L.early if w != L.deployer]
    snip_hold = sum(bal.get(w, 0.0) for w in snipers)
    bund_hold = sum(bal.get(w, 0.0) for w in L.bundlers)
    observed_sol = (getattr(L, "observed_sol", None) if getattr(L, "observed_sol", None) else
                    sum((t[2] or 0) * (1 if t[1] == "buy" else -1) for t in trades)) + (L.dev_buy_sol or 0)
    curve_sol = max(0.0, (L.vsol or CURVE_START_SOL) - CURVE_START_SOL)
    coverage = 100.0 if curve_sol < 0.5 else max(0.0, min(100.0, observed_sol / curve_sol * 100))
    buys1, sells1 = sum(1 for t in m1 if t[1] == "buy"), sum(1 for t in m1 if t[1] == "sell")
    soc = ctx.get("social") or {}
    meta = getattr(L, "meta", []) or []
    md = L.metadata or {}
    it = getattr(L, "intel", None) or {}
    ai = getattr(L, "ai", None) or {}
    yt = ctx.get("yt") or {}
    xr = ctx.get("x") or {}
    ins, fresh = it.get("insiders") or [], it.get("fresh") or []
    intel = {
        "insiders": len(ins) if it else None,
        "insider_hold_pct": round(sum(bal.get(w, 0.0) for w in ins) / PUMP_SUPPLY * 100, 1) if it else None,
        "fresh_pct": it.get("fresh_pct"), "bot_wallets": it.get("bots") if it else None,
        "fresh_hold_pct": round(sum(bal.get(w, 0.0) for w in fresh) / PUMP_SUPPLY * 100, 1) if it else None,
        "chain_top10_pct": it.get("chain_top10_pct"),
        "yt_videos": yt.get("videos") or 0, "yt_views": yt.get("views") or 0,
        "ai_meme_score": ai.get("meme_score"), "ai_derivative": ai.get("derivative") if ai else None,
        "ai_narrative": ai.get("narrative"),
        "x_tweet_score": xr.get("score"), "x_spawn_rank": xr.get("rank"), "x_delay_s": xr.get("delay_s"),
        "x_top_account": (xr.get("tier") == "S") if xr else None,
    }
    return {**intel,
        "holders": len(bal), "top10_pct": round(sum(top[:10]) / PUMP_SUPPLY * 100, 1),
        "dev_hold_pct": round(dev_hold / PUMP_SUPPLY * 100, 2),
        "dev_sold": bool(L.dev_tokens and L.dev_sold_tokens >= 0.5 * L.dev_tokens),
        "snipers": len(snipers), "snipers_hold_pct": round(snip_hold / PUMP_SUPPLY * 100, 1),
        "bundle_hold_pct": round(bund_hold / PUMP_SUPPLY * 100, 1),
        "pro_traders": len(L.pros), "buys_1m": buys1, "sells_1m": sells1,
        "buy_ratio_1m": round(buys1 / max(1, sells1), 2),
        "vol_1m_usd": round(sum(t[2] or 0 for t in m1) * px), "vol_5m_usd": round(sum(t[2] or 0 for t in m5) * px),
        "has_twitter": bool(md.get("twitter")), "has_telegram": bool(md.get("telegram")), "has_website": bool(md.get("website")),
        "twitter_kind": twitter_kind(md.get("twitter")), "x_community": twitter_kind(md.get("twitter")) == "community",
        "socials": sum(1 for k in ("twitter", "telegram", "website") if md.get(k)),
        "social_authors": soc.get("authors", 0), "social_engagement": round(soc.get("engagement", 0)),
        "meta_hot": any(x.get("status") in ("hot", "heating") for x in meta),
        "dev_graduated": (L.dev or {}).get("graduated") or 0,
        "coverage_pct": round(coverage), "metrics_basis": "complete" if coverage >= 80 else "partial",
    }


def upside_risk(r: dict[str, Any], mx: dict[str, Any]) -> tuple[float, float, list[str], list[str]]:
    """Two separate axes instead of one verdict: how much could it run, and how likely is it to hurt you.
    Thresholds follow what trader guides and terminal filters commonly use (top 10 ≲ 30%, dev ≲ 5%, bundlers ≲ 10%,
    snipers ≲ 20%, dev-sold read as a positive)."""
    up, why_up = 0.0, []
    det = {d["key"]: d for d in r.get("detectors", [])}

    def add(pts: float, why: str) -> None:
        nonlocal up
        if pts:
            up += pts
            why_up.append(why)

    if det.get("alpha"):
        add(min(25.0, det["alpha"]["points"]), "top wallets in")
    add(min(10.0, mx["pro_traders"] * 4.0), f"{mx['pro_traders']} pro traders" if mx["pro_traders"] else "")
    eta = r.get("eta_min")
    if r.get("graduated_at"):
        add(10, "graduated")
    elif eta is not None:
        add(22 if eta <= 5 else 16 if eta <= 12 else 9 if eta <= 25 else 3, f"graduation ETA {eta:.0f}m")
    add(min(12.0, max(0.0, mx["net_sol_1m"] if "net_sol_1m" in mx else r.get("net_sol_1m", 0)) * 1.5), "net buying")
    br = mx["buy_ratio_1m"]
    add(6 if br >= 3 and mx["buys_1m"] >= 6 else 3 if br >= 1.5 and mx["buys_1m"] >= 4 else 0, f"buy pressure {br:.1f}×")
    add(min(14.0, mx["social_authors"] * 3.5 + min(4.0, mx["social_engagement"] / 50)),
        f"{mx['social_authors']} people posting it" if mx["social_authors"] else "")
    if det.get("meta"):
        add(min(12.0, det["meta"]["points"]), "fits a live meta")
    add(min(8.0, mx["socials"] * 2.5 + (2 if mx["twitter_kind"] == "community" else 0)), f"{mx['socials']} social links" if mx["socials"] else "")
    add(min(6.0, mx["holders"] / 10), f"{mx['holders']} holders" if mx["holders"] >= 20 else "")
    if mx["dev_graduated"]:
        add(min(8.0, 4 + 2 * mx["dev_graduated"]), "dev has graduated coins")
    if mx.get("yt_videos"):
        add(min(12.0, mx["yt_videos"] * 4 + (mx.get("yt_views") or 0) / 2500), f"{mx['yt_videos']} YouTube video{'s' if mx['yt_videos'] > 1 else ''}")
    if mx.get("ai_meme_score") is not None and mx["ai_meme_score"] >= 6:
        add(min(12.0, (mx["ai_meme_score"] - 5) * 2.5), f"AI meme score {mx['ai_meme_score']:.0f}/10")
    if mx.get("x_tweet_score") is not None:
        add(min(18.0, mx["x_tweet_score"] / 5 + (5 if mx.get("x_spawn_rank") == 1 else 0)),
            f"coin #{mx.get('x_spawn_rank')} off a tracked tweet" + (" (S-tier)" if mx.get("x_top_account") else ""))
    if mx.get("insiders") == 0 and (mx.get("fresh_pct") or 0) < 35:
        add(5, "independent buyers (on-chain)")

    risk, why_risk = 0.0, []

    def bad(pts: float, why: str) -> None:
        nonlocal risk
        if pts > 0:
            risk += pts
            why_risk.append(why)

    bad(min(30.0, max(0.0, mx["bundle_hold_pct"] - 5) * 2), f"bundlers hold {mx['bundle_hold_pct']:.0f}%")
    bad(min(20.0, max(0.0, mx["snipers_hold_pct"] - 10) * 1.2), f"snipers hold {mx['snipers_hold_pct']:.0f}%")
    chain = mx.get("chain_top10_pct")
    t10 = chain if chain is not None and mx["metrics_basis"] == "partial" else mx["top10_pct"]
    bad(min(25.0, max(0.0, t10 - 30) * 0.9), f"top 10 hold {t10:.0f}%" + (" (on-chain)" if t10 is chain else ""))
    ihp = mx.get("insider_hold_pct")
    if ihp is not None and mx.get("insiders"):
        bad(min(35.0, 4 + max(0.0, ihp - 3) * 1.5), f"{mx['insiders']} linked insiders hold {ihp:.0f}%")
    fhp = mx.get("fresh_hold_pct")
    if fhp is not None:
        bad(min(15.0, max(0.0, fhp - 10)), f"fresh wallets hold {fhp:.0f}%")
    if not mx["dev_sold"]:
        bad(min(20.0, max(0.0, mx["dev_hold_pct"] - 5) * 1.2), f"dev holds {mx['dev_hold_pct']:.0f}%")
    flags = set(r.get("flags", []))
    bad(35 if "dev dumped" in flags and not mx["dev_sold"] else 0, "dev dumping")
    bad(18 if "serial launcher, nothing graduated" in flags else 0, "serial launcher")
    bad(8 if mx["socials"] == 0 and r.get("age_s", 0) > 60 else 0, "no socials")
    bad(10 if mx["sells_1m"] > mx["buys_1m"] * 2 and mx["sells_1m"] >= 6 else 0, "sell-off")
    bad((5 if chain is not None else 10) if mx["metrics_basis"] == "partial" else 0, "partial data")
    if det.get("meta") and "copies trending" in det["meta"]["detail"]:
        bad(6, "copycat ticker")
    return round(min(100.0, up), 1), round(min(100.0, risk), 1), [w for w in why_up if w], why_risk


APPETITE = {"safe": 1.0, "balanced": 0.6, "degen": 0.25}


def appetite_score(upside: float, risk: float, appetite: str) -> float:
    return round(upside - APPETITE.get(appetite, 0.6) * risk, 1)


def matches(rules: list[dict[str, Any]], row: dict[str, Any], mode: str = "all") -> bool:
    """A strategy's rules against a scored launch. Missing metrics never match (no guessing)."""
    if not rules:
        return False
    hits = 0
    for rule in rules:
        v = row.get(rule.get("metric"))
        op = OPS.get(rule.get("op", ">="))
        ok = v is not None and op is not None and _cmp(op, v, rule.get("value"))
        if ok:
            hits += 1
        elif mode == "all":
            return False
    return hits == len(rules) if mode == "all" else hits > 0


def _cmp(op: Any, v: Any, target: Any) -> bool:
    try:
        if isinstance(v, bool) or isinstance(target, bool):
            return op(bool(v), bool(target))
        return op(float(v), float(target))
    except (TypeError, ValueError):
        return False
