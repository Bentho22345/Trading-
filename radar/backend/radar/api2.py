"""Phase 2-6 endpoints: signals, alerts, narratives/social, FLASH, smart money, paper/scorecard/backtest,
risk & positions, rotation, briefs, Ask Radar, settings, Telegram login."""
from __future__ import annotations

import json
import os
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .app import DISCLAIMER, S

router = APIRouter(prefix="/api")


def _sig(r: dict[str, Any]) -> dict[str, Any]:
    for k in ("subscores_json", "vetoes_json", "reasons_json", "plan_json"):
        if k in r:
            r[k[:-5]] = json.loads(r.pop(k) or "null")
    r.pop("inputs_json", None)
    r["disclaimer"] = DISCLAIMER
    return r


# ---------------- signals & alerts ----------------
@router.get("/signals")
async def signals(verdict: str = "", limit: int = 100, hours: float = 48, include_avoid: bool = False) -> list[dict[str, Any]]:
    q = ("SELECT s.*, t.name, t.image, pt.return_pct, pt.closed paper_closed, pt.exit_reason FROM signals s "
         "LEFT JOIN tokens t ON t.address=s.token_address LEFT JOIN paper_trades pt ON pt.signal_id=s.id WHERE s.ts > ?")
    args: list[Any] = [time.time() - hours * 3600]
    if verdict:
        q += " AND s.verdict=?"
        args.append(verdict.upper())
    elif not include_avoid:
        q += " AND s.verdict != 'AVOID'"
    return [_sig(r) for r in await S.db.all(q + " ORDER BY s.ts DESC LIMIT ?", [*args, min(limit, 500)])]


@router.get("/signal/{sid}")
async def signal(sid: int) -> dict[str, Any]:
    r = await S.db.one("SELECT * FROM signals WHERE id=?", (sid,))
    if not r:
        raise HTTPException(404)
    inputs = json.loads(r["inputs_json"] or "{}")
    out = _sig(r)
    out["inputs"] = inputs
    out["paper"] = await S.db.one("SELECT * FROM paper_trades WHERE signal_id=?", (sid,))
    return out


@router.post("/token/{address}/evaluate")
async def evaluate_now(address: str) -> dict[str, Any]:
    res = await S.signals.evaluate(address, force=True)
    if not res:
        raise HTTPException(409, "No live market data for this token yet")
    return res


@router.get("/alerts")
async def alerts(limit: int = 100) -> list[dict[str, Any]]:
    return await S.db.all("SELECT * FROM alerts ORDER BY ts DESC LIMIT ?", (min(limit, 500),))


@router.post("/alerts/{aid}/ack")
async def ack(aid: int) -> dict[str, bool]:
    await S.db.exec("UPDATE alerts SET acked=1 WHERE id=?", (aid,))
    return {"ok": True}


@router.post("/alerts/test")
async def test_alert() -> dict[str, Any]:
    r = await S.alerts.send("info", "Radar test alert", "If you see this on your phone, alerts work.", dedupe=f"test:{time.time()}")
    return r or {}


# ---------------- social / narratives / flash ----------------
@router.get("/narratives")
async def narratives(hours: float = 24, limit: int = 60, category: str = "") -> list[dict[str, Any]]:
    rows = await S.social.board(limit=limit, hours=hours)
    if category:
        rows = [r for r in rows if r.get("category") == category]
    for r in rows:
        r["spark"] = await S.social.sparkline(r["id"], 60)
        r["tokens"] = await S.db.all(
            "SELECT nt.token_address, nt.match_score, nt.legit_score, nt.is_likely_fake, t.symbol, t.name, p.price_usd, p.vol_h1, "
            "p.liquidity_usd, p.chg_h1 FROM narrative_tokens nt LEFT JOIN tokens t ON t.address=nt.token_address "
            "LEFT JOIN pairs p ON p.pair_address=t.best_pair WHERE nt.narrative_id=? ORDER BY nt.legit_score DESC LIMIT 8", (r["id"],))
    return rows


@router.get("/narrative/{nid}")
async def narrative(nid: int) -> dict[str, Any]:
    n = await S.db.one("SELECT * FROM narratives WHERE id=?", (nid,))
    if not n:
        raise HTTPException(404)
    for k in ("keywords_json", "tickers_json", "sources_json", "flags_json"):
        n[k[:-5]] = json.loads(n.pop(k) or "null")
    posts = await S.db.all("SELECT e.*, a.bot_score, a.handle FROM social_events e LEFT JOIN authors a ON a.id=e.author_id "
                           "WHERE e.narrative_id=? ORDER BY e.ts DESC LIMIT 200", (nid,))
    by_source: dict[str, int] = {}
    infl: dict[str, dict[str, Any]] = {}
    for p in posts:
        by_source[p["source"]] = by_source.get(p["source"], 0) + 1
        a = infl.setdefault(p["author_id"], {"author": p["author_id"], "tier": p["author_tier"], "followers": p["followers"],
                                             "posts": 0, "engagement": 0, "bot_score": p["bot_score"]})
        a["posts"] += 1
        a["engagement"] += p["engagement"] or 0
    tokens = await S.db.all(
        "SELECT nt.*, t.symbol, t.name, t.image, t.launched_at, t.first_seen, t.deployer, p.price_usd, p.vol_h1, p.liquidity_usd, "
        "p.market_cap, p.chg_h1, s.mint_authority, s.freeze_authority, s.top10_pct, s.holders FROM narrative_tokens nt "
        "LEFT JOIN tokens t ON t.address=nt.token_address LEFT JOIN pairs p ON p.pair_address=t.best_pair "
        "LEFT JOIN safety_reports s ON s.token_address=nt.token_address WHERE nt.narrative_id=? ORDER BY nt.legit_score DESC", (nid,))
    for t in tokens:
        t["reasons"] = json.loads(t.pop("reasons_json") or "[]")
    return {"narrative": n, "posts": posts, "buzz_by_source": by_source,
            "influencers": sorted(infl.values(), key=lambda a: -(a["engagement"] + a["posts"]))[:15],
            "tokens": tokens, "spark": await S.social.sparkline(nid, 120)}


@router.get("/social")
async def social(limit: int = 150, source: str = "", tier: str = "", with_ca: bool = False) -> list[dict[str, Any]]:
    q, args = "SELECT * FROM social_events WHERE 1=1", []
    if source:
        q += " AND source=?"
        args.append(source)
    if tier:
        q += " AND author_tier=?"
        args.append(tier)
    if with_ca:
        q += " AND cas_json != '[]'"
    rows = await S.db.all(q + " ORDER BY ts DESC LIMIT ?", [*args, min(limit, 500)])
    for r in rows:
        r["cas"] = json.loads(r.pop("cas_json") or "[]")
        r["cashtags"] = json.loads(r.pop("cashtags_json") or "[]")
        r["ai"] = json.loads(r.pop("ai_json") or "null")
    return rows


@router.get("/social/stats")
async def social_stats() -> dict[str, Any]:
    now = time.time()
    rows = await S.db.all("SELECT source, COUNT(*) n, SUM(ts > ?) n5, MAX(ts) last FROM social_events WHERE ts > ? GROUP BY source",
                          (now - 300, now - 3600))
    return {"by_source": rows, "as_of": now}


@router.get("/flash")
async def flash(limit: int = 50) -> dict[str, Any]:
    rows = await S.db.all("SELECT * FROM flash_events ORDER BY id DESC LIMIT ?", (limit,))
    lat = sorted(r["latency_ms"] for r in rows if r["kind"] == "vip_ca" and r["latency_ms"] is not None)
    return {"events": rows, "latency_ms": {"n": len(lat), "p50": lat[len(lat) // 2] if lat else None,
                                           "max": lat[-1] if lat else None,
                                           "under_5s_pct": round(sum(x < 5000 for x in lat) / len(lat) * 100, 1) if lat else None}}


class Post(BaseModel):
    author: str = "realDonaldTrump"
    text: str
    source: str = "x"


@router.post("/dev/simulate-vip-post")
async def simulate(post: Post) -> dict[str, Any]:
    """Test fixture for the FLASH latency check. Disabled unless RADAR_ENABLE_FIXTURES=1; events are flagged is_fixture."""
    if os.environ.get("RADAR_ENABLE_FIXTURES") != "1":
        raise HTTPException(403, "Fixtures are disabled (set RADAR_ENABLE_FIXTURES=1 to run the FLASH latency test)")
    ev = {"id": f"fixture:{time.time_ns()}", "source": post.source, "author": post.author, "text": post.text,
          "ts": time.time(), "tier_hint": "vip", "followers": 1_000_000}
    out = await S.social.ingest(ev, fixture=True)
    return {"flash": (out or {}).get("flash")}


# ---------------- smart money ----------------
@router.get("/wallets")
async def wallets(kind: str = "", tracked_only: bool = False, limit: int = 200) -> list[dict[str, Any]]:
    q, args = "SELECT w.*, (SELECT MAX(ts) FROM wallet_trades wt WHERE wt.wallet=w.address) last_trade FROM wallets w WHERE 1=1", []
    if kind:
        q += " AND kind=?"
        args.append(kind)
    else:
        q += " AND COALESCE(kind,'') != 'top'"  # the 1,000 leaderboard wallets live on the Top wallets page
    if tracked_only:
        q += " AND tracked=1"
    return await S.db.all(q + " ORDER BY tracked DESC, score DESC NULLS LAST LIMIT ?", [*args, limit])


@router.get("/wallet-trades")
async def wallet_trades(limit: int = 200, wallet: str = "") -> list[dict[str, Any]]:
    q, args = ("SELECT wt.*, w.label, w.kind, w.score, w.handle, t.symbol FROM wallet_trades wt JOIN wallets w ON w.address=wt.wallet "
               "LEFT JOIN tokens t ON t.address=wt.mint"), []
    if wallet:
        q += " WHERE wt.wallet=?"
        args.append(wallet)
    return await S.db.all(q + " ORDER BY wt.ts DESC LIMIT ?", [*args, limit])


class WalletBody(BaseModel):
    address: str
    kind: str = "smart"
    label: str | None = None
    handle: str | None = None


@router.post("/wallets")
async def add_wallet(b: WalletBody) -> dict[str, Any]:
    if b.kind not in ("smart", "kol"):
        raise HTTPException(400, "kind must be smart or kol")
    await S.db.exec("INSERT INTO wallets (address, label, kind, handle, tracked, updated) VALUES (?,?,?,?,1,?) ON CONFLICT(address) "
                    "DO UPDATE SET label=COALESCE(excluded.label,label), kind=excluded.kind, handle=COALESCE(excluded.handle,handle), tracked=1",
                    (b.address, b.label, b.kind, b.handle, time.time()))
    await S.smart.refresh_tracked()
    return {"ok": True}


@router.delete("/wallets/{address}")
async def untrack(address: str) -> dict[str, Any]:
    await S.db.exec("UPDATE wallets SET tracked=0 WHERE address=?", (address,))
    await S.smart.refresh_tracked()
    return {"ok": True}


@router.post("/wallets/discover")
async def discover() -> dict[str, Any]:
    return {"tracked": await S.smart.discover()}


# ---------------- top-wallet leaderboard ----------------
@router.get("/leaderboard")
async def leaderboard(period: str = "1d", sort: str = "roi", limit: int = 100, offset: int = 0,
                      include_bots: bool = False, source: str = "radar") -> dict[str, Any]:
    if source != "radar":
        return await S.board.external(source, period, max(1, min(limit, 1000)), max(0, offset))
    try:
        return await S.board.board(period, sort, max(1, min(limit, 1000)), max(0, offset), include_bots)
    except ValueError as e:
        raise HTTPException(400, str(e))


class TopTradeFixture(BaseModel):
    wallet: str
    mint: str
    side: str = "buy"
    sol: float = 1.0
    rank: int = 1


@router.post("/dev/simulate-top-trade")
async def simulate_top_trade(b: TopTradeFixture) -> dict[str, Any]:
    """Test fixture: push one top-wallet trade through the live path. Disabled unless RADAR_ENABLE_FIXTURES=1; flagged is_fixture."""
    if os.environ.get("RADAR_ENABLE_FIXTURES") != "1":
        raise HTTPException(403, "Fixtures are disabled (set RADAR_ENABLE_FIXTURES=1)")
    S.smart.also_follow.setdefault(b.wallet, {"rank": b.rank, "period": "1d", "roi": None})
    sig = f"fixture-{time.time_ns()}"
    await S.smart.on_trade({"trader": b.wallet, "mint": b.mint, "side": b.side, "sol": b.sol, "tokens": b.sol * 1e6,
                            "ts": time.time(), "mcap_sol": None, "signature": sig, "is_fixture": True})
    return {"signature": sig}


@router.get("/top-trades")
async def top_trades(limit: int = 80, hours: float = 24) -> list[dict[str, Any]]:
    """Recent trades by the followed top wallets, newest first, with their current rank."""
    follow = S.smart.also_follow
    if not follow:
        return []
    rows = await S.db.all(
        "SELECT wt.*, t.symbol, t.name, t.image FROM wallet_trades wt LEFT JOIN tokens t ON t.address=wt.mint "
        f"WHERE wt.wallet IN ({','.join('?' * len(follow))}) AND wt.ts > ? ORDER BY wt.ts DESC LIMIT ?",
        (*follow, time.time() - hours * 3600, max(1, min(limit, 500))))
    for r in rows:
        r.update(follow.get(r["wallet"]) or {"rank": None, "period": None, "roi": None})
        r["usd"] = S.tracker._usd(r.get("sol"))
        r["mcap_usd"] = S.tracker._usd(r.get("mcap_sol"))
    return rows


@router.get("/leaderboard/wallet/{address}")
async def leaderboard_wallet(address: str) -> dict[str, Any]:
    return await S.board.wallet(address)


@router.post("/leaderboard/sources/refresh")
async def leaderboard_sources_refresh() -> dict[str, Any]:
    """Pull Birdeye's leaderboards now (needs the Birdeye key), then re-rank and re-follow."""
    n = await S.toptraders.birdeye_round()
    await S.board.refresh()
    return {"birdeye": n, "followed": len(S.board.followed)}


@router.post("/leaderboard/refresh")
async def leaderboard_refresh() -> dict[str, Any]:
    return {"ranked": await S.board.refresh(), "followed": len(S.board.followed)}


# ---------------- paper / scorecard / backtest ----------------
@router.get("/scorecard")
async def scorecard(hours: float | None = None) -> dict[str, Any]:
    return await S.paper.scorecard(hours=hours)


@router.get("/paper")
async def paper(open_only: bool = False, verdict: str = "", limit: int = 200) -> list[dict[str, Any]]:
    q, args = "SELECT * FROM paper_trades WHERE is_backtest=0", []
    if open_only:
        q += " AND closed IS NULL"
    if verdict:
        q += " AND verdict=?"
        args.append(verdict.upper())
    return await S.db.all(q + " ORDER BY opened DESC LIMIT ?", [*args, limit])


class BacktestBody(BaseModel):
    override: dict[str, Any] | None = None
    hours: float = 72


@router.post("/backtest")
async def backtest(b: BacktestBody) -> dict[str, Any]:
    return await S.paper.backtest(b.override, S.cfg.risk, b.hours)


@router.post("/tune")
async def tune(b: BacktestBody) -> dict[str, Any]:
    return await S.paper.tune(S.cfg.risk, b.hours)


# ---------------- risk & positions ----------------
@router.get("/risk")
async def risk() -> dict[str, Any]:
    status = await S.signals.check_daily_loss()
    pos = await S.db.all("SELECT * FROM positions ORDER BY closed IS NOT NULL, opened DESC LIMIT 300")
    unreal = 0.0
    for p in pos:
        tok = await S.tracker.token_summary(p["token_address"]) if not p["closed"] else None
        p["price_usd"] = (tok or {}).get("price_usd")
        p["price_as_of"] = (tok or {}).get("as_of")
        if p["price_usd"] and p["entry_price"] and not p["closed"]:
            p["unrealized_usd"] = round(p["size_usd"] * (p["price_usd"] / p["entry_price"] - 1), 2)
            unreal += p["unrealized_usd"]
    realized = sum(p["realized_usd"] or 0 for p in pos if p["closed"])
    return {"settings": S.cfg.risk, **status, "positions": pos, "unrealized_usd": round(unreal, 2),
            "realized_usd": round(realized, 2), "open": sum(1 for p in pos if not p["closed"])}


class PositionBody(BaseModel):
    token_address: str
    entry_price: float
    size_usd: float
    qty: float | None = None
    stop_price: float | None = None
    notes: str | None = None
    signal_id: int | None = None


@router.post("/positions")
async def add_position(b: PositionBody) -> dict[str, Any]:
    tok = await S.tracker.token_summary(b.token_address) or {}
    ladder = [{"multiple": m, "sell_fraction": f} for m, f in S.cfg.scoring["plan"]["take_profit_ladder"]]
    stop = b.stop_price or b.entry_price * (1 - S.cfg.scoring["plan"]["stop_pct"] / 100)
    pid = await S.db.exec("INSERT INTO positions (token_address, symbol, opened, entry_price, size_usd, qty, stop_price, ladder_json, "
                          "fills_json, notes, signal_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                          (b.token_address, tok.get("symbol"), time.time(), b.entry_price, b.size_usd, b.qty, stop,
                           json.dumps(ladder), "[]", b.notes, b.signal_id))
    await S.db.exec("INSERT OR IGNORE INTO watchlist (address, added) VALUES (?,?)", (b.token_address, time.time()))
    return {"id": pid}


class CloseBody(BaseModel):
    exit_price: float
    notes: str | None = None


@router.post("/positions/{pid}/close")
async def close_position(pid: int, b: CloseBody) -> dict[str, Any]:
    p = await S.db.one("SELECT * FROM positions WHERE id=?", (pid,))
    if not p:
        raise HTTPException(404)
    pnl = p["size_usd"] * (b.exit_price / p["entry_price"] - 1)
    await S.db.exec("UPDATE positions SET closed=?, exit_price=?, realized_usd=?, notes=COALESCE(?, notes) WHERE id=?",
                    (time.time(), b.exit_price, round(pnl, 2), b.notes, pid))
    return {"realized_usd": round(pnl, 2), "risk": await S.signals.check_daily_loss()}


@router.delete("/positions/{pid}")
async def delete_position(pid: int) -> dict[str, bool]:
    await S.db.exec("DELETE FROM positions WHERE id=?", (pid,))
    return {"ok": True}


@router.post("/risk/cooldown/clear")
async def clear_cooldown() -> dict[str, bool]:
    await S.cfg.kv_set("risk:cooldown_until", 0)
    return {"ok": True}


@router.get("/holdings")
async def holdings() -> dict[str, Any]:
    addr = (await S.connectors.values("wallet")).get("address")
    if not addr:
        raise HTTPException(409, "Add your public wallet address on Connectors")
    rows = await S.tracker.extra.holdings(addr)
    mints = [r["mint"] for r in rows]
    for m in mints:
        await S.tracker._ensure_token(m, "solana", None, None, None, "wallet")
        await S.db.exec("INSERT OR IGNORE INTO watchlist (address, added, note) VALUES (?,?,?)", (m, time.time(), "held"))
    if mints:
        await S.tracker.refresh("solana", mints[:90])
    out = []
    for r in rows:
        tok = await S.tracker.token_summary(r["mint"]) or {}
        out.append({**r, "symbol": tok.get("symbol"), "price_usd": tok.get("price_usd"), "as_of": tok.get("as_of"),
                    "value_usd": round(r["amount"] * tok["price_usd"], 2) if tok.get("price_usd") else None,
                    "mint_authority": tok.get("mint_authority"), "freeze_authority": tok.get("freeze_authority"),
                    "liquidity_usd": tok.get("liquidity_usd")})
    return {"address": addr, "holdings": sorted(out, key=lambda x: -(x["value_usd"] or 0)), "as_of": time.time()}


# ---------------- rotation / brief / ask ----------------
@router.get("/rotation")
async def rotation() -> dict[str, Any]:
    return await S.insights.rotation()


@router.get("/briefs")
async def briefs(limit: int = 20) -> list[dict[str, Any]]:
    return await S.db.all("SELECT id, ts, kind, body, model FROM briefs ORDER BY ts DESC LIMIT ?", (limit,))


@router.post("/brief")
async def make_brief(deliver: bool = False) -> dict[str, Any]:
    return await S.insights.brief("on_demand", deliver=deliver)


class AskBody(BaseModel):
    question: str
    history: list[dict[str, Any]] | None = None


@router.post("/ask")
async def ask(b: AskBody) -> dict[str, Any]:
    try:
        return {"answer": await S.insights.ask(b.question, b.history)}
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e


@router.get("/spend")
async def spend() -> dict[str, Any]:
    start = time.time() - (time.time() % 86400)
    rows = await S.db.all("SELECT adapter, COUNT(*) calls, COALESCE(SUM(cost_usd),0) usd FROM api_usage WHERE ts >= ? GROUP BY adapter", (start,))
    xv = await S.connectors.values("x")
    return {"today": rows, "ai_budget_usd": S.ai.daily_budget, "x_budget_usd": float(xv.get("daily_budget_usd") or 5),
            "since": start}


# ---------------- settings ----------------
@router.get("/settings")
async def get_settings() -> dict[str, Any]:
    return {"scoring": S.cfg.scoring, "watch": S.cfg.watch, "risk": S.cfg.risk}


@router.post("/settings/{name}")
async def save_settings(name: str, patch: dict[str, Any]) -> dict[str, Any]:
    try:
        out = await S.cfg.save(name, patch)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if name == "watch":
        await S.smart.load()
    return out


@router.delete("/settings/{name}")
async def reset_settings(name: str) -> dict[str, bool]:
    await S.cfg.reset(name)
    return {"ok": True}


# ---------------- telegram login ----------------
class CodeBody(BaseModel):
    code: str | None = None
    password: str | None = None


@router.post("/telegram/send-code")
async def tg_send() -> dict[str, str]:
    try:
        return {"message": await S.telegram.send_code()}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e)) from e


@router.post("/telegram/sign-in")
async def tg_sign(b: CodeBody) -> dict[str, str]:
    try:
        return {"message": await S.telegram.sign_in(b.code or "", b.password)}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e)) from e


# ---------------- discovery: trending / launching / emerging / stories / search / launch watch ----------------
_cache: dict[str, tuple[float, Any]] = {}


async def _cached(key: str, ttl: float, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    val = await fn()
    _cache[key] = (time.time(), val)
    return val


@router.get("/discover/climbers")
async def climbers(hours: float = 4, min_liq: float = 5000, limit: int = 60) -> dict[str, Any]:
    rows = await _cached(f"climb:{hours}:{min_liq}:{limit}", 8, lambda: S.discover.climbers(hours=hours, min_liq=min_liq, limit=limit))
    return {"as_of": time.time(), "rows": rows}


@router.get("/discover/launching")
async def launching(max_age_h: float = 24, limit: int = 60) -> dict[str, Any]:
    rows = await _cached(f"launch:{max_age_h}:{limit}", 6, lambda: S.discover.launching(max_age_h=max_age_h, limit=limit))
    return {"as_of": time.time(), "rows": rows}


@router.get("/discover/emerging")
async def emerging(limit: int = 30) -> dict[str, Any]:
    return await _cached(f"emerging:{limit}", 4, lambda: S.discover.emerging(limit=limit))


@router.get("/token/{address}/story")
async def story(address: str) -> dict[str, Any]:
    st = await S.story.get(address)
    if not st:
        st = await S.story.build(address)
    if not st:
        raise HTTPException(404, "unknown token")
    return st


@router.post("/token/{address}/story")
async def story_refresh(address: str, x: bool = False) -> dict[str, Any]:
    st = await S.story.build(address, use_x=x)
    if not st:
        raise HTTPException(404, "unknown token")
    return st


@router.get("/sparks")
async def sparks(a: str, hours: float = 2) -> dict[str, list[float]]:
    return await S.discover.sparks([x for x in a.split(",") if x][:300], hours)


@router.get("/search")
async def search(q: str) -> dict[str, Any]:
    return await S.discover.search(q)


class WatchTermsBody(BaseModel):
    terms: list[str]
    label: str | None = None
    narrative_id: int | None = None


@router.get("/launch-watches")
async def launch_watches() -> list[dict[str, Any]]:
    return await S.discover.watches()


@router.post("/launch-watches")
async def add_launch_watch(b: WatchTermsBody) -> dict[str, Any]:
    try:
        return {"id": await S.discover.add_watch(b.terms, b.label, b.narrative_id)}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/launch-watches/{wid}")
async def del_launch_watch(wid: int) -> dict[str, bool]:
    await S.db.exec("DELETE FROM launch_watches WHERE id=?", (wid,))
    return {"ok": True}
