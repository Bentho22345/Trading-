"""Replay lab — backtest the self-driving brain on the REAL tape Radar recorded.

Radar keeps every pump.fun launch and every trade it saw (72 h by default). This replays a window of that history through
a FRESH sniper + brain + Nebula council on a virtual clock, exactly as the live engine would have seen it (same partial
feed, same scoring, same exits, same fees and bonding-curve / PumpSwap fills), and reports what it would have traded.

Runs in its own process (`python -m radar.replay --db radar.db --hours 6 --level surreal --out result.json`) on a
snapshot of the database, so the live site never shares a connection or an event loop with it. No look-ahead: dev
histories and graduations after the window's start are stripped from the snapshot, and everything else is only seen
when the virtual clock reaches it.
"""
from __future__ import annotations

import argparse
import asyncio
import heapq
import json
import math
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

CLOCK = [time.time()]
_real_time = time.time


def _now() -> float:
    return CLOCK[0]


async def snapshot(src: str, dst: str, t0: float, t1: float) -> None:
    """A small working database: fresh schema, plus only what the replay may read — the window's launches and the devs'
    history from BEFORE it (no look-ahead). The live database is attached read-only, never copied whole."""
    from .db import DB
    d = DB(Path(dst))
    await d.open()
    await d.close()
    with sqlite3.connect(dst) as c:
        c.execute("ATTACH DATABASE ? AS s", (src,))
        for table, where, args in (("tokens", "launched_at >= ? AND launched_at < ?", (t0, t1)),
                                   ("dev_launches", "ts < ?", (t0,))):
            cols = [r[1] for r in c.execute(f"PRAGMA main.table_info({table})")]
            src_cols = {r[1] for r in c.execute(f"PRAGMA s.table_info({table})")}
            use = ", ".join(x for x in cols if x in src_cols)
            c.execute(f"INSERT OR IGNORE INTO main.{table} ({use}) SELECT {use} FROM s.{table} WHERE {where}", args)
        c.execute("UPDATE dev_launches SET graduated_at=NULL WHERE graduated_at >= ?", (t0,))
        c.commit()
        c.execute("DETACH DATABASE s")


class KV:
    def __init__(self) -> None:
        self.d: dict[str, Any] = {}

    async def kv_get(self, k: str) -> Any:
        return self.d.get(k)

    async def kv_set(self, k: str, v: Any) -> None:
        self.d[k] = json.loads(json.dumps(v))


class Alerts:
    async def send(self, *a: Any, **k: Any) -> None:
        return None


def _launch_row(t: dict[str, Any]) -> dict[str, Any]:
    from . import curve
    pct = t.get("dev_initial_buy_pct") or 0.0
    tok = min(0.9, pct / 100 * 1e9 / 1.073e9) if pct else 0.0
    dev_sol = curve.CURVE0 / (1 - tok) - curve.CURVE0 if tok else 0.0
    v = curve.CURVE0 + dev_sol
    return {"address": t["address"], "symbol": t.get("symbol"), "name": t.get("name"), "deployer": t.get("deployer"),
            "launched_at": t["launched_at"], "initial_buy_sol": dev_sol, "initial_buy_tokens": pct / 100 * 1e9 if pct else 0.0,
            "dev_initial_buy_pct": pct, "vsol": v, "pump_mcap_sol": v * v * 1e9 / curve.K, "uri": None}


async def run(db_path: str, hours: float, level: str, end: float | None = None, step: float = 1.0,
              progress: Any = None, tune: dict[str, Any] | None = None) -> dict[str, Any]:
    from . import curve
    from .autopilot import Autopilot
    from .db import DB
    from .sniper import Sniper

    src = sqlite3.connect(db_path)
    src.row_factory = sqlite3.Row
    t1 = end or (src.execute("SELECT MAX(ts) FROM pump_trades").fetchone()[0] or _real_time())
    t0 = t1 - hours * 3600
    launches = [dict(r) for r in src.execute(
        "SELECT address, symbol, name, deployer, launched_at, dev_initial_buy_pct, graduated_at FROM tokens "
        "WHERE source='pumpportal' AND launched_at >= ? AND launched_at < ? AND COALESCE(is_mayhem,0)=0 ORDER BY launched_at", (t0 - 1800, t1))]
    n_trades = src.execute("SELECT COUNT(*) FROM pump_trades WHERE ts >= ? AND ts < ?", (t0 - 1800, t1)).fetchone()[0]
    src.close()
    if not n_trades:
        return {"ok": False, "error": "no recorded trades in that window"}
    # trades are STREAMED from the database in time order (a day of tape never sits in memory at once)
    feed = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    trades = feed.execute("SELECT ts, mint, side, sol, tokens, trader, mcap_sol, signature, sol_usd FROM pump_trades "
                          "WHERE ts >= ? AND ts < ? ORDER BY ts", (t0 - 1800, t1))

    work = Path(tempfile.mkdtemp(prefix="radar-replay-"))
    snap = str(work / "replay.db")
    await snapshot(db_path, snap, t0 - 1800, t1)
    time.time = _now                                     # the virtual clock (everything in Radar reads time.time())
    CLOCK[0] = t0 - 1800
    try:
        out = await _replay(snap, work, t0, t1, level, launches, trades, step, progress, tune or {})
        out["trades_replayed"] = n_trades
        return out
    finally:
        time.time = _real_time
        feed.close()
        shutil.rmtree(work, ignore_errors=True)


async def _replay(snap: str, work: Path, t0: float, t1: float, level: str, launches: list[dict[str, Any]], trades: Any,
                  step: float, progress: Any, tune: dict[str, Any]) -> dict[str, Any]:
    from . import curve
    from .autopilot import Autopilot
    from .db import DB
    from .sniper import Sniper
    db = DB(Path(snap))
    await db.open()
    tracker = SimpleNamespace(sol_usd=None, launch_watch={}, born={},
                              token_summary=lambda m: asyncio.sleep(0, None))
    sniper = Sniper(db, tracker, Alerts())
    traders = SimpleNamespace(ranked={}, followed=set(), pool=set())
    ap = Autopilot(db, KV(), sniper, tracker, traders, None, Alerts(), None)
    await ap.load()
    await ap.brain.set_aggression(level)
    ap.brain.tune = dict(tune)

    # warm-up: the 30 minutes before the window build the sniper's picture; trading starts at t0
    ev_l = [(r["launched_at"], 0, r) for r in launches]
    grads = [(r["graduated_at"], 2, r) for r in launches if r.get("graduated_at") and t0 - 1800 <= r["graduated_at"] < t1]
    small = sorted(ev_l + grads, key=lambda e: (e[0], e[1]))
    events = heapq.merge(small, ((r[0], 1, r) for r in trades), key=lambda e: (e[0], e[1]))
    trading = False
    bad, errors = 0, []
    next_tick = CLOCK[0] + step
    n_ticks = 0
    wall0 = _real_time()
    for i, (ts, kind, r) in enumerate(events):
        while next_tick <= ts:                          # the engine's loop, on virtual time
            CLOCK[0] = next_tick
            if not trading and next_tick >= t0:
                trading = True
                await ap.set_mode("auto")
            await _eval_dirty(sniper, next_tick)
            if trading:
                await ap.manage()
                await ap.brain.tick("auto")
                n_ticks += 1
            if int(next_tick) % 60 == 0 and next_tick - int(next_tick) < step:
                prune(sniper, {p["mint"] for p in ap.open.values()}, next_tick)
            next_tick += step
            if progress and n_ticks % 2000 == 0 and n_ticks:
                progress((next_tick - t0) / max(1.0, t1 - t0))
        CLOCK[0] = ts
        try:
            await _event(kind, r, ts, sniper, ap, tracker, curve)
        except Exception as e:  # noqa: BLE001 - a malformed recorded row is skipped, like the live hooks do
            bad += 1
            if bad <= 3:
                errors.append(f"{type(e).__name__}: {e}"[:160])
        if i % 500 == 0:
            await asyncio.sleep(0)                     # let spawned tasks (dev lookups, instant exits) run
            if i % 20000 == 0:
                from .guard import rss_mb
                r_mb = rss_mb() or 0
                if r_mb > float(os.environ.get("REPLAY_MAX_MB", "200")):
                    raise MemoryError(f"replay stopped itself at {r_mb:.0f} MB (REPLAY_MAX_MB) — try a shorter window")
    CLOCK[0] = t1
    for p in list(ap.open.values()):                   # close what's left at the window's end, at the real last price
        await ap.sell(p, 1.0, "backtest window ended")
    out = await summarize(ap, db, t0, t1, level, len(launches), 0)
    out["tune"] = tune
    out["skipped_rows"], out["row_errors"] = bad, errors
    out["learned"] = ap.brain.learned()                      # what this brain learned from the tape (the live one can adopt it)
    out["wall_s"] = round(_real_time() - wall0, 1)
    out["ticks"] = n_ticks
    await db.close()
    return out


async def _event(kind: int, r: Any, ts: float, sniper: Any, ap: Any, tracker: Any, curve: Any) -> None:
    """One recorded event, fed exactly the way the live tracker hooks feed it."""
    if kind == 0:
        await sniper.on_launch(_launch_row(r))
        tracker.born[r["address"]] = ts
    elif kind == 1:
        _, mint, side, sol, toks, trader, mc, sig, sol_usd = r
        if sol_usd:
            tracker.sol_usd = sol_usd
        v = curve.vsol_from_mcap(mc) if mc else None
        t = {"mint": mint, "ts": ts, "side": side, "sol": sol, "tokens": toks, "trader": trader,
             "mcap_sol": mc, "signature": sig, "sol_usd": sol_usd, "vsol": v if v and v < curve.CURVE_END else None}
        await sniper.on_trade(t)
        await ap.on_trade(t)
    else:
        await sniper.on_graduated({"mint": r["address"], "ts": ts})


async def _eval_dirty(sniper: Any, now: float) -> None:
    for m in list(sniper.dirty):
        L = sniper.launches.get(m)
        if L is None:
            sniper.dirty.discard(m)
            continue
        if now - L.last_eval < sniper._interval(L):
            continue
        sniper.dirty.discard(m)
        await sniper._evaluate(L, now, publish=False)


def prune(sniper: Any, held: set[str], now: float) -> None:
    """The live sniper stops tracking a launch once its window passes (held coins are kept, as live)."""
    for m, L in list(sniper.launches.items()):
        if L.until and L.until < now and m not in held:
            sniper.launches.pop(m, None)


async def summarize(ap: Any, db: Any, t0: float, t1: float, level: str, n_launch: int, n_trades: int) -> dict[str, Any]:
    rows = await db.all("SELECT * FROM auto_positions WHERE mode='auto' AND status='closed' ORDER BY opened")
    b = ap.brain
    by: dict[str, dict[str, Any]] = {}
    exits: dict[str, dict[str, Any]] = {}
    curve_pts = []
    eq = b.start_sol
    for r in rows:
        meta = json.loads(r.get("features_json") or "null") or {}
        strat = (meta.get("strat") if isinstance(meta, dict) else None) or "?"
        net = (r["sol_out"] / r["sol_in"] - 1) if r["sol_in"] else 0.0
        reason = re.sub(r"[−+-]?\d+(\.\d+)?[×%s]?", "#", (r.get("exit_reason") or "?").split(" (")[0].split(" —")[0])[:32]
        for key, bucket in ((strat, by), (reason, exits)):
            s = bucket.setdefault(key, {"n": 0, "wins": 0, "sol": 0.0, "sum": 0.0})
            s["n"] += 1
            s["wins"] += int(net > 0)
            s["sol"] += r["sol_out"] - r["sol_in"]
            s["sum"] += net
        eq += r["sol_out"] - r["sol_in"]
        curve_pts.append([round(r["closed"]), round(eq, 3)])

    def fmt(d: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        return sorted(({"key": k, "n": s["n"], "win_pct": round(s["wins"] / s["n"] * 100), "avg_pct": round(s["sum"] / s["n"] * 100, 2),
                        "sol": round(s["sol"], 4)} for k, s in d.items()), key=lambda x: x["sol"])

    pnl = sum(r["sol_out"] - r["sol_in"] for r in rows)
    peak, dd = b.start_sol, 0.0
    for _, e in curve_pts:
        peak = max(peak, e)
        dd = max(dd, (peak - e) / peak if peak else 0.0)
    snap = b.council.snapshot()
    return {"ok": True, "from": t0, "to": t1, "hours": round((t1 - t0) / 3600, 2), "level": level, "launches": n_launch,
            "trades_replayed": n_trades, "positions": len(rows), "wins": sum(1 for r in rows if r["sol_out"] > r["sol_in"]),
            "pnl_sol": round(pnl, 4), "return_pct": round(pnl / b.start_sol * 100, 2), "max_drawdown_pct": round(dd * 100, 2),
            "by_strategy": fmt(by), "by_exit": fmt(exits), "equity": curve_pts[-400:],
            "skips": dict(sorted((b.skips or b.skips_prev or {}).items(), key=lambda kv: -kv[1])[:10]),
            "referee": snap.get("referee"), "regime": snap.get("regime"), "allocator": b.alloc.snapshot().get("strategies"),
            "last_error": b.last_error}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", required=True)
    ap.add_argument("--hours", type=float, default=6.0)
    ap.add_argument("--level", default="surreal")
    ap.add_argument("--end", type=float, default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--tune", default="{}", help="brain knobs as JSON, e.g. '{\"tape_mult\": 0.6}'")
    a = ap.parse_args()
    prog_path = (a.out + ".progress") if a.out else None

    def progress(f: float) -> None:
        if prog_path:
            Path(prog_path).write_text(json.dumps({"progress": round(min(1.0, f), 3), "ts": _real_time()}))
    try:
        res = asyncio.run(run(a.db, a.hours, a.level, a.end, progress=progress, tune=json.loads(a.tune or "{}")))
    except Exception as e:  # noqa: BLE001
        import traceback
        res = {"ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]}
    txt = json.dumps(res, default=lambda o: None if isinstance(o, float) and math.isnan(o) else str(o))
    if a.out:
        Path(a.out).write_text(txt)
    else:
        sys.stdout.write(txt + "\n")


if __name__ == "__main__":
    main()
