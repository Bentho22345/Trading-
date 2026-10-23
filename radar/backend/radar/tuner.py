"""The Tuner — the brain's coach. It runs tournaments of brain variants on the real tape Radar recorded and keeps the
settings that actually make money, walk-forward so it can't just memorise the last few hours:

  1. TRAIN: every variant (the current settings ± one change: stricter / looser dead-tape filter, no swings, no snipes,
     pickier / more eager entries, smaller bets) replays the same older window through a fresh brain;
  2. VALIDATE: the best two and the current settings replay the most recent hours, which none of them were picked on;
  3. ADOPT: a challenger replaces the current settings only if it beat them on BOTH windows, by a margin
     (score = return − ½ × max drawdown). Otherwise nothing changes.

Each replay is its own low-priority process (python -m radar.replay), one at a time, so the live engine keeps the CPU.
It never touches real-money settings: auto-adoption only happens while the self-driving demo is what's running.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("radar.tuner")

CHANGES: dict[str, dict[str, Any]] = {
    "strict tape": {"tape_mult": 0.6},
    "loose tape": {"tape_mult": 1.6},
    "no swings": {"off": ["swing"]},
    "no snipes": {"off": ["snipe:early", "snipe:mid"]},
    "picky": {"ev_margin": 0.01, "scalp_bar": 0.05, "snipe_bar": 0.05},
    "eager": {"ev_margin": -0.01, "scalp_bar": -0.05, "snipe_bar": -0.05},
    "small bets": {"bet_mult": 0.5},
    "tight exits": {"stop_scale": 0.75, "tp_scale": 0.75},
    "room to run": {"stop_scale": 1.3, "tp_scale": 1.4},
}
MARGIN = 1.0                     # percentage points of score a challenger must win by, on both windows


def score(r: dict[str, Any] | None) -> float:
    if not r or not r.get("ok"):
        return -1e9
    return float(r.get("return_pct") or 0.0) - 0.5 * float(r.get("max_drawdown_pct") or 0.0)


def merge(base: dict[str, Any], change: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k, v in change.items():
        if k == "off":
            out["off"] = sorted(set(out.get("off") or []) | set(v))
        elif k in ("tape_mult", "bet_mult", "stop_scale", "tp_scale"):
            out[k] = round(float(out.get(k, 1.0)) * float(v), 3)
        else:
            out[k] = round(float(out.get(k, 0.0)) + float(v), 3)
    return out


class Tuner:
    def __init__(self, ap: Any, db_path: Path) -> None:
        self.ap = ap
        self.db_path = db_path
        self.out = db_path.parent / "tuner.json"
        self.state: dict[str, Any] = {"running": False, "phase": None, "last": None, "history": []}
        self.task: asyncio.Task | None = None
        try:
            saved = json.loads(self.out.read_text())
            self.state.update(last=saved.get("last"), history=saved.get("history") or [])
        except (OSError, ValueError):
            pass

    def _save(self) -> None:
        try:
            self.out.write_text(json.dumps({"last": self.state.get("last"), "history": self.state.get("history", [])[-20:]}))
        except OSError:
            pass

    async def _replay(self, hours: float, end: float, tune: dict[str, Any], level: str) -> dict[str, Any]:
        from .guard import mem_headroom_mb
        for _ in range(20):                                         # wait (up to ~10 min) for memory headroom; live first
            room = mem_headroom_mb()
            if room is None or room >= float(os.environ.get("REPLAY_MIN_HEADROOM_MB", "160")):
                break
            await asyncio.sleep(30)
        else:
            return {"ok": False, "error": "not enough free memory for a replay"}
        out = self.db_path.parent / f"tuner-run-{os.getpid()}.json"
        cmd = [sys.executable, "-m", "radar.replay", "--db", str(self.db_path), "--hours", str(hours), "--end", str(end),
               "--level", level, "--tune", json.dumps(tune), "--out", str(out)]
        try:
            proc = await asyncio.create_subprocess_exec("nice", "-n", "19", *cmd)
        except FileNotFoundError:
            proc = await asyncio.create_subprocess_exec(*cmd)
        await proc.wait()
        try:
            return json.loads(out.read_text())
        except (OSError, ValueError):
            return {"ok": False, "error": "replay produced no result"}
        finally:
            try:
                out.unlink()
            except OSError:
                pass

    def start(self, train_h: float = 8.0, valid_h: float = 3.0, auto_adopt: bool = True) -> bool:
        if self.task is not None and not self.task.done():
            return False
        self.task = asyncio.get_running_loop().create_task(self.tournament(train_h, valid_h, auto_adopt))
        return True

    async def tournament(self, train_h: float, valid_h: float, auto_adopt: bool) -> dict[str, Any]:
        b = self.ap.brain
        level = b.aggression
        current = dict(b.tune)
        now = time.time()
        t_valid_end, t_train_end = now, now - valid_h * 3600
        variants = {"current": current, **{name: merge(current, ch) for name, ch in CHANGES.items()}}
        rows: dict[str, dict[str, Any]] = {n: {"name": n, "tune": t} for n, t in variants.items()}
        self.state.update(running=True, started=now, phase="train", done=0, total=len(variants) + 3, rows=list(rows.values()))
        try:
            for name, tune in variants.items():
                self.state["current_run"] = f"train · {name}"
                r = await self._replay(train_h, t_train_end, tune, level)
                rows[name].update(train=_brief(r), train_score=round(score(r), 2))
                self.state["done"] += 1
            ranked = sorted((n for n in rows if n != "current"), key=lambda n: -rows[n]["train_score"])
            finalists = ["current"] + [n for n in ranked[:2] if rows[n]["train_score"] > rows["current"]["train_score"]]
            self.state["phase"] = "validate"
            for name in finalists:
                self.state["current_run"] = f"validate · {name}"
                r = await self._replay(valid_h, t_valid_end, variants[name], level)
                rows[name].update(valid=_brief(r), valid_score=round(score(r), 2))
                self.state["done"] += 1
            base = rows["current"]
            winner = max(finalists, key=lambda n: rows[n].get("valid_score", -1e9))
            beat = (winner != "current" and rows[winner]["valid_score"] >= base.get("valid_score", -1e9) + MARGIN
                    and rows[winner]["train_score"] >= base["train_score"] + MARGIN)
            adopted = False
            if beat and auto_adopt and self.ap.c.get("mode") != "real":
                b.tune = dict(variants[winner])
                await b.save()
                adopted = True
                await b.note("mode", f"🎛 Tuner: '{winner}' beat the current settings on the replayed tape (train "
                                     f"{rows[winner]['train_score']:+.1f} vs {base['train_score']:+.1f}, fresh hours "
                                     f"{rows[winner]['valid_score']:+.1f} vs {base.get('valid_score', 0):+.1f}) — adopted.")
            elif beat:
                await b.note("mode", f"🎛 Tuner: '{winner}' beat the current settings on the replayed tape — not adopted "
                                     f"automatically while real money is on (adopt it from the Replay lab if you want it).")
            else:
                await b.note("mode", "🎛 Tuner: no variant beat the current settings on both the training and the fresh "
                                     "hours of real tape — keeping them.")
            last = {"ts": now, "level": level, "train_h": train_h, "valid_h": valid_h, "winner": winner if beat else "current",
                    "adopted": adopted, "rows": sorted(rows.values(), key=lambda r: -(r.get("valid_score") or r.get("train_score") or -1e9)),
                    "tune_now": b.tune}
            self.state["last"] = last
            self.state["history"] = (self.state.get("history") or []) + [{"ts": now, "winner": last["winner"], "adopted": adopted,
                                                                            "tune": b.tune}]
            self._save()
            return last
        except Exception as e:  # noqa: BLE001
            log.warning("tuner: %s", e)
            self.state["error"] = f"{type(e).__name__}: {e}"
            return {}
        finally:
            self.state.update(running=False, phase=None, current_run=None)

    async def loop(self) -> None:
        """Every TUNE_EVERY_H hours (default 6) while the self-driving demo runs: hold a tournament."""
        every = float(os.environ.get("TUNE_EVERY_H", "6") or 0)
        if every <= 0:
            return
        await asyncio.sleep(1800)                                   # let a fresh deploy record some tape first
        while True:
            try:
                if self.ap.c.get("mode") == "auto":
                    self.start()
            except Exception as e:  # noqa: BLE001
                log.warning("tuner loop: %s", e)
            await asyncio.sleep(every * 3600)

    def snapshot(self) -> dict[str, Any]:
        st = {k: v for k, v in self.state.items() if k != "history"}
        st["history"] = (self.state.get("history") or [])[-8:]
        st["tune"] = self.ap.brain.tune
        return st


def _brief(r: dict[str, Any]) -> dict[str, Any]:
    if not r.get("ok"):
        return {"ok": False, "error": r.get("error")}
    return {k: r.get(k) for k in ("ok", "return_pct", "pnl_sol", "max_drawdown_pct", "positions", "wins", "wall_s")}
