"""Price-driver features: liquidity changes, holder concentration, token social volume, dev wallet
activity and listings. `collect()` reads them from Radar's own tables; the helpers are pure so they can be
unit-tested and every value lands in the signal's logged inputs (backtests replay them)."""
from __future__ import annotations

import json
import math
import time
from typing import Any

LISTING_VENUES = ("binance", "coinbase", "robinhood", "upbit", "okx", "bybit", "kraken", "bitget", "kucoin", "gate.io", "mexc")
NEGATIVE_WORDS = ("delist", "exploit", "hack", "hacked", "drained", "rug pull", "rugged", "scam", "sec charges", "lawsuit", "suspend")
LISTING_WORDS = ("listing", "will list", "lists", "listed", "now available", "trading opens", "adds", "launches trading")


def liquidity_removed_pct(ticks: list[dict[str, Any]]) -> float | None:
    """How much pool liquidity disappeared beyond what the price move explains.

    In a constant-product pool the USD value of liquidity scales with sqrt(price), so a falling price alone
    shrinks it. Liquidity falling faster than sqrt(price) means LP was withdrawn (the classic slow rug)."""
    pts = [x for x in ticks if x.get("price_usd") and x.get("liquidity_usd")]
    if len(pts) < 2:
        return None
    a, b = pts[0], pts[-1]
    expected = math.sqrt(b["price_usd"] / a["price_usd"])
    actual = b["liquidity_usd"] / a["liquidity_usd"]
    return round((1 - actual / expected) * 100, 1)


def max_holder_pct(top_holders_json: str | None) -> float | None:
    try:
        rows = json.loads(top_holders_json or "[]")
    except (ValueError, TypeError):
        return None
    pcts = [float(h.get("pct") or 0) for h in rows if isinstance(h, dict)]
    return round(max(pcts), 2) if pcts else None


def _names_token(low: str, sym: str, nm: str) -> bool:
    return (len(sym) >= 3 and (f"${sym}" in low or f" {sym} " in low or f"({sym})" in low)) or (len(nm) >= 4 and nm in low)


def listing_headline(titles: list[str], symbol: str | None, name: str | None) -> str | None:
    """First headline that names a major exchange, a listing word and this token (by $TICKER, ticker or name)."""
    sym = (symbol or "").lower().lstrip("$")
    nm = (name or "").lower()
    if len(sym) < 3 and len(nm) < 4:
        return None   # too short to match reliably in free text
    for t in titles:
        low = f" {(t or '').lower()} "
        if any(w in low for w in NEGATIVE_WORDS):
            continue
        if any(v in low for v in LISTING_VENUES) and any(w in low for w in LISTING_WORDS) and _names_token(low, sym, nm):
            return t
    return None


def negative_headline(titles: list[str], symbol: str | None, name: str | None) -> str | None:
    """First headline naming this token together with a delisting, exploit, rug or legal word."""
    sym = (symbol or "").lower().lstrip("$")
    nm = (name or "").lower()
    if len(sym) < 3 and len(nm) < 4:
        return None
    for t in titles:
        low = f" {(t or '').lower()} "
        if any(w in low for w in NEGATIVE_WORDS) and _names_token(low, sym, nm):
            return t
    return None


def trade_flow(trades: list[dict[str, Any]], whale_sol: float) -> dict[str, Any]:
    """Net SOL flow, whale buys/sells and churn (trades per wallet, high = wash/bot trading) from raw trades."""
    buys = [t for t in trades if t.get("side") == "buy"]
    sells = [t for t in trades if t.get("side") == "sell"]
    sol = lambda rs: sum(float(t.get("sol") or 0) for t in rs)  # noqa: E731
    wallets = {t.get("trader") for t in trades if t.get("trader")}
    return {
        "net_sol_15m": round(sol(buys) - sol(sells), 3),
        "whale_buys_15m": sum(1 for t in buys if float(t.get("sol") or 0) >= whale_sol),
        "whale_sells_15m": sum(1 for t in sells if float(t.get("sol") or 0) >= whale_sol),
        "trades_per_wallet_15m": round(len(trades) / len(wallets), 2) if wallets else None,
        "trades_15m": len(trades),
    }


_mentions: dict[int, tuple[float, list[tuple[float, str, set[str], set[str], str]]]] = {}


async def _mention_rows(db: Any, now: float, ttl: float = 15) -> list[tuple[float, str, set[str], set[str], str]]:
    """Last 2h of posts carrying a CA or cashtag, loaded once per `ttl` and shared by every token evaluated."""
    hit = _mentions.get(id(db))
    if hit and 0 <= now - hit[0] < ttl:
        return hit[1]
    rows = await db.all("SELECT ts, author_id, author_tier, cas_json, cashtags_json FROM social_events WHERE ts > ? AND is_fixture=0 "
                        "AND (cas_json NOT IN ('[]', '') OR cashtags_json NOT IN ('[]', ''))", (now - 7200,))
    parsed = []
    for r in rows:
        try:
            parsed.append((r["ts"], r["author_id"], set(json.loads(r["cas_json"] or "[]")), set(json.loads(r["cashtags_json"] or "[]")),
                           r["author_tier"] or ""))
        except (ValueError, TypeError):
            continue
    _mentions[id(db)] = (now, parsed)
    return parsed


_news: dict[int, tuple[float, list[str]]] = {}


async def _news_titles(db: Any, now: float, ttl: float = 60) -> list[str]:
    hit = _news.get(id(db))
    if hit and 0 <= now - hit[0] < ttl:
        return hit[1]
    rows = await db.all("SELECT title FROM news WHERE fetched > ? ORDER BY fetched DESC LIMIT 500", (now - 48 * 3600,))
    _news[id(db)] = (now, [r["title"] for r in rows])
    return _news[id(db)][1]


async def collect(db: Any, addr: str, tok: dict[str, Any] | None, ticks: list[dict[str, Any]], now: float | None = None,
                  whale_sol: float = 5.0) -> dict[str, Any]:
    now = now or time.time()
    tok = tok or {}
    out: dict[str, Any] = {}

    # liquidity: depth vs market cap, and LP removed over the last hour
    mcap = tok.get("market_cap") or tok.get("fdv")
    if mcap and tok.get("liquidity_usd") is not None:
        out["liq_mcap_ratio"] = round(tok["liquidity_usd"] / mcap, 4)
    out["liq_removed_pct_1h"] = liquidity_removed_pct(ticks)

    # holder concentration: largest single wallet and the top-10 trend
    s = await db.one("SELECT top_holders_json FROM safety_reports WHERE token_address=?", (addr,))
    out["max_holder_pct"] = max_holder_pct((s or {}).get("top_holders_json"))
    hs = await db.all("SELECT top10_pct FROM holder_snapshots WHERE token_address=? AND ts > ? AND top10_pct IS NOT NULL ORDER BY ts",
                      (addr, now - 3600))
    if len(hs) >= 2:
        out["top10_chg_pts_1h"] = round(hs[-1]["top10_pct"] - hs[0]["top10_pct"], 2)

    # token-level social volume: posts naming the CA (exact) or the $TICKER (shared with copycats, so half weight)
    sym = (tok.get("symbol") or "").upper()
    cur, prev, kols = [], [], set()
    for ts, author, cas, tags, tier in await _mention_rows(db, now):
        if addr in cas:
            ca = True
        elif len(sym) >= 2 and sym in tags:
            ca = False
        else:
            continue
        (cur if ts > now - 3600 else prev).append((author, ca))
        if ca and tier == "kol" and ts > now - 3600:
            kols.add(author)
    out["mentions_1h"] = sum(1.0 if ca else 0.5 for _, ca in cur)
    out["mentions_prev_1h"] = sum(1.0 if ca else 0.5 for _, ca in prev)
    out["ca_mentions_1h"] = sum(1 for _, ca in cur if ca)
    out["mention_authors_1h"] = len({a for a, _ in cur})
    out["kol_calls_1h"] = len(kols)

    # volume acceleration and extension from the best pair (DexScreener windows)
    v5, v1, v6 = tok.get("vol_m5"), tok.get("vol_h1"), tok.get("vol_h6")
    if v5 is not None and v1:
        out["vol_accel_5m"] = round(v5 * 12 / v1, 2)
    if v1 is not None and v6:
        out["vol_accel_1h"] = round(v1 * 6 / v6, 2)
    b1, s1 = tok.get("buys_h1"), tok.get("sells_h1")
    if b1 is not None and s1 is not None and b1 + s1:
        out["buy_sell_1h"] = round(b1 / max(1, s1), 2)
    out["chg_h1"], out["chg_h6"] = tok.get("chg_h1"), tok.get("chg_h6")

    # order flow from the pump.fun trade stream: net SOL, whales, churn
    tr = await db.all("SELECT side, sol, trader FROM pump_trades WHERE mint=? AND ts > ?", (addr, now - 900))
    if tr:
        out.update(trade_flow(tr, whale_sol))

    # dev wallet: selling right now (not just cumulative) and how many tokens this deployer has launched
    if tok.get("deployer"):
        d = await db.one("SELECT COUNT(*) n, COALESCE(SUM(sol),0) sol FROM pump_trades WHERE mint=? AND trader=? AND side='sell' AND ts > ?",
                         (addr, tok["deployer"], now - 900))
        out["dev_sells_15m"] = d["n"] if d else 0
        out["dev_sold_sol_15m"] = round(d["sol"] or 0, 3) if d else 0
        w = await db.one("SELECT COUNT(*) n FROM tokens WHERE deployer=? AND first_seen > ?", (tok["deployer"], now - 7 * 86400))
        out["deployer_launches_7d"] = w["n"] if w else None

    # listings: CEX listing headlines naming this token, pump.fun graduation, CoinGecko trending
    titles = await _news_titles(db, now)
    out["cex_listing"] = listing_headline(titles, tok.get("symbol"), tok.get("name"))
    out["negative_news"] = negative_headline(titles, tok.get("symbol"), tok.get("name"))
    if tok.get("graduated_at"):
        out["graduated_h_ago"] = round((now - tok["graduated_at"]) / 3600, 2)
    if tok.get("symbol") and tok.get("name"):
        cg = await db.one("SELECT rank FROM trending WHERE source='coingecko' AND list='trending' AND UPPER(symbol)=? AND LOWER(name)=?",
                          (sym, tok["name"].lower()))
        out["coingecko_trending_rank"] = cg["rank"] if cg else None
    return out
