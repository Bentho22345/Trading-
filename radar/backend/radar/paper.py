"""Paper trading of every signal, the scorecard, backtest replay and weight tuning."""
from __future__ import annotations

import copy
import itertools
import json
import statistics
import time
from typing import Any

from . import scoring
from .hub import hub


def bucket(score: float) -> str:
    return "85+" if score >= 85 else "70-85" if score >= 70 else "50-70" if score >= 50 else "<50"


def simulate(entry: float, ladder: list[dict[str, Any]], stop: float, time_stop: float, path: list[tuple[float, float]],
             size: float = 100.0) -> dict[str, Any]:
    """Walk a price path [(ts, price)] through the TP ladder / stop / time stop. Pure; used live and in backtests."""
    remaining, realized, fills = 1.0, 0.0, []
    peak = trough = entry
    exit_reason, closed = None, None
    pending = sorted(ladder, key=lambda s: s["multiple"])
    last_ts, last_px = None, entry
    for ts, px in path:
        if px is None or px <= 0:
            continue
        last_ts, last_px = ts, px
        peak, trough = max(peak, px), min(trough, px)
        for step in list(pending):
            if px >= entry * step["multiple"] and remaining > 1e-9:
                frac = min(step["sell_fraction"], remaining)
                realized += frac * size * (px / entry - 1)
                remaining -= frac
                fills.append({"ts": ts, "price": px, "fraction": frac, "multiple": step["multiple"]})
                pending.remove(step)
        if remaining <= 1e-9:
            exit_reason, closed = "ladder complete", ts
            break
        if px <= stop:
            realized += remaining * size * (px / entry - 1)
            fills.append({"ts": ts, "price": px, "fraction": remaining, "stop": True})
            remaining, exit_reason, closed = 0.0, "stop", ts
            break
        if ts >= time_stop:
            realized += remaining * size * (px / entry - 1)
            fills.append({"ts": ts, "price": px, "fraction": remaining, "time_stop": True})
            remaining, exit_reason, closed = 0.0, "time stop", ts
            break
    unrealized = remaining * size * (last_px / entry - 1)
    return {"remaining": remaining, "realized_usd": realized, "unrealized_usd": unrealized, "fills": fills,
            "peak": peak, "trough": trough, "last_price": last_px, "last_ts": last_ts, "closed": closed,
            "exit_reason": exit_reason, "return_pct": (realized + unrealized) / size * 100,
            "max_dd_pct": (trough / entry - 1) * 100}


def stats(trades: list[dict[str, Any]]) -> dict[str, Any]:
    rets = [t["return_pct"] for t in trades if t.get("return_pct") is not None]
    if not rets:
        return {"n": 0}
    equity, peak, mdd = 0.0, 0.0, 0.0
    for r in rets:
        equity += r
        peak = max(peak, equity)
        mdd = min(mdd, equity - peak)
    wins = [r for r in rets if r > 0]
    losses = [r for r in rets if r <= 0]
    return {"n": len(rets), "hit_rate": round(len(wins) / len(rets) * 100, 1), "avg_return": round(statistics.mean(rets), 2),
            "median_return": round(statistics.median(rets), 2),
            "expectancy": round((len(wins) / len(rets)) * (statistics.mean(wins) if wins else 0)
                                + (len(losses) / len(rets)) * (statistics.mean(losses) if losses else 0), 2),
            "best": round(max(rets), 1), "worst": round(min(rets), 1), "max_drawdown_pct_pts": round(mdd, 1),
            "total_pct_pts": round(sum(rets), 1)}


class Paper:
    def __init__(self, db: Any, cfg: Any) -> None:
        self.db, self.cfg = db, cfg

    async def open(self, sig: dict[str, Any], token: dict[str, Any]) -> int | None:
        p = sig.get("plan")
        if not p or not token.get("price_usd"):
            return None
        size = float(self.cfg.scoring["engine"].get("paper_size_usd", 100))
        return await self.db.exec(
            "INSERT INTO paper_trades (signal_id, token_address, symbol, verdict, category, score, opened, entry_price, size_usd, "
            "stop_price, time_stop, ladder_json, fills_json, peak_price, trough_price, last_price, last_ts) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (sig["id"], token["address"], token.get("symbol"), sig["verdict"], sig.get("category"), sig["score"], sig["ts"],
             token["price_usd"], size, p["stop_price"], p["time_stop_ts"], json.dumps(p["ladder"]), "[]",
             token["price_usd"], token["price_usd"], token["price_usd"], sig["ts"]))

    async def update(self) -> list[dict[str, Any]]:
        """Re-walk every open trade over its stored price path (ticks since open)."""
        closed_now = []
        for t in await self.db.all("SELECT * FROM paper_trades WHERE closed IS NULL AND is_backtest=0"):
            ticks = await self.db.all("SELECT ts, price_usd, liquidity_usd FROM price_ticks WHERE token_address=? AND ts >= ? ORDER BY ts",
                                      (t["token_address"], t["opened"]))
            path = [(x["ts"], x["price_usd"]) for x in ticks]
            # liquidity pulled = rug: mark to zero
            if ticks and (ticks[-1]["liquidity_usd"] or 0) < 500 and (ticks[0]["liquidity_usd"] or 0) > 5000:
                path.append((ticks[-1]["ts"], t["entry_price"] * 1e-6))
            if time.time() >= t["time_stop"] and path:
                path.append((time.time(), path[-1][1]))
            r = simulate(t["entry_price"], json.loads(t["ladder_json"]), t["stop_price"], t["time_stop"], path, t["size_usd"])
            await self.db.exec("UPDATE paper_trades SET remaining=?, realized_usd=?, fills_json=?, peak_price=?, trough_price=?, "
                               "last_price=?, last_ts=?, closed=?, exit_reason=?, return_pct=?, max_dd_pct=? WHERE id=?",
                               (r["remaining"], r["realized_usd"], json.dumps(r["fills"]), r["peak"], r["trough"], r["last_price"],
                                r["last_ts"], r["closed"], r["exit_reason"], round(r["return_pct"], 2), round(r["max_dd_pct"], 2), t["id"]))
            if r["closed"]:
                closed_now.append({**t, **r})
        if closed_now:
            await hub.publish("paper_closed", [{"id": c["id"], "symbol": c["symbol"], "verdict": c["verdict"],
                                                "return_pct": c["return_pct"], "exit_reason": c["exit_reason"]} for c in closed_now])
        return closed_now

    async def scorecard(self, hours: float | None = None, include_open: bool = True) -> dict[str, Any]:
        q = "SELECT * FROM paper_trades WHERE is_backtest=0"
        args: list[Any] = []
        if hours:
            q += " AND opened > ?"
            args.append(time.time() - hours * 3600)
        rows = await self.db.all(q + " ORDER BY opened", args)
        closed = [r for r in rows if r["closed"]]
        considered = rows if include_open else closed
        out: dict[str, Any] = {"overall": stats(considered), "closed": stats(closed), "open": sum(1 for r in rows if not r["closed"]),
                               "by_verdict": {}, "by_category": {}, "by_bucket": {}}
        for key, fn in (("by_verdict", lambda r: r["verdict"]), ("by_category", lambda r: r["category"] or "none"),
                        ("by_bucket", lambda r: bucket(r["score"] or 0))):
            groups: dict[str, list] = {}
            for r in considered:
                groups.setdefault(fn(r), []).append(r)
            out[key] = {k: stats(v) for k, v in groups.items()}
        buy = out["by_verdict"].get("BUY", {"n": 0})
        out["verdict"] = ("not enough BUY trades yet (need 20+)" if buy.get("n", 0) < 20 else
                          "PROFITABLE on paper" if buy.get("expectancy", 0) > 0 else "NOT profitable on paper — don't trade it yet")
        out["equity"] = [{"ts": r["opened"], "ret": r["return_pct"], "verdict": r["verdict"]} for r in considered
                         if r["return_pct"] is not None]
        return out

    async def backtest(self, override: dict[str, Any] | None, risk: dict[str, Any], hours: float = 72) -> dict[str, Any]:
        """Replay every stored signal's exact logged inputs through a (modified) config and simulate on stored ticks."""
        c = copy.deepcopy(self.cfg.scoring)
        if override:
            from .cfg import deep_merge
            c = deep_merge(c, override)
        sigs = await self.db.all("SELECT * FROM signals WHERE ts > ? ORDER BY ts", (time.time() - hours * 3600,))
        trades = []
        for s in sigs:
            inp = json.loads(s["inputs_json"] or "{}")
            if not inp.get("token"):
                continue
            res = scoring.evaluate(inp, c, risk, now=s["ts"])
            if not res.get("plan") or not inp["token"].get("price_usd"):
                continue
            ticks = await self.db.all("SELECT ts, price_usd FROM price_ticks WHERE token_address=? AND ts >= ? ORDER BY ts",
                                      (s["token_address"], s["ts"]))
            if not ticks:
                continue
            p = res["plan"]
            r = simulate(inp["token"]["price_usd"], p["ladder"], p["stop_price"], p["time_stop_ts"],
                         [(x["ts"], x["price_usd"]) for x in ticks])
            trades.append({"verdict": res["verdict"], "score": res["score"], "category": s["category"],
                           "return_pct": r["return_pct"], "closed": r["closed"]})
        by = {}
        for v in ("BUY", "WATCH", "AVOID"):
            by[v] = stats([t for t in trades if t["verdict"] == v])
        return {"signals": len(sigs), "simulated": len(trades), "by_verdict": by,
                "by_bucket": {b: stats([t for t in trades if bucket(t["score"]) == b]) for b in ("85+", "70-85", "50-70", "<50")}}

    async def tune(self, risk: dict[str, Any], hours: float = 72) -> dict[str, Any]:
        """Small grid over weights and the BUY threshold; maximise BUY expectancy with >= 10 trades."""
        base = self.cfg.scoring["weights"]
        results = []
        for nar, mom, thr in itertools.product((0.2, 0.3, 0.4), (0.15, 0.2, 0.3), (60, 65, 70, 75, 80)):
            w = dict(base)
            w["narrative"], w["momentum"] = nar, mom
            o = {"weights": w, "verdict": {"buy_min_score": thr}}
            bt = await self.backtest(o, risk, hours)
            b = bt["by_verdict"]["BUY"]
            if b.get("n", 0) >= 10:
                results.append({"override": o, "buy": b})
        results.sort(key=lambda r: -r["buy"]["expectancy"])
        return {"tested": 45, "qualified": len(results), "best": results[:5],
                "note": "Configs need >= 10 simulated BUY trades to qualify. Apply one from Settings → Scoring."}
