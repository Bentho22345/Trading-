"""The Allocator — the Nebula's fourth brain, a risk manager that decides WHICH strategies get money.

The executor has many ways in: early snipes, mid snipes, second-wave entries (after the first-minute dev / sniper
flush), scalps, swings, influx copies, exploration buys, the drought breaker. Research on pump.fun is blunt about who
wins: devs and their bundles took $579M+, snipers $31.5M, and 65% of devs sell inside a minute (Bitquery, Oct 2026) —
so a bot that sees trades a few seconds late is often the exit liquidity. Rather than guess which of its strategies
survive that, the allocator MEASURES it: every closed trade's net result (after fees) is booked to the strategy that
opened it, and

  • a strategy that keeps losing (≥ 12 trades, average below −1% and confidently below zero) is BENCHED for 20 min —
    "take out what isn't working", decided by live results, not by hand;
  • a benched strategy still gets an occasional small PROBE (1 in 6 proposals, 30% size) so it can earn its way back;
  • strategies that make money get a bigger share of the size (≈ fractional Kelly on their record).
"""
from __future__ import annotations

import math
import time
from collections import deque
from typing import Any

MIN_N = 12
BENCH_S = 1200
DECAY = 0.985                                   # recent trades count most: the market changes by the hour


def strat_key(style: str, age_s: float | None = None) -> str:
    if style == "snipe":
        return "snipe:early" if (age_s or 0) < 20 else "snipe:mid"
    return style


class Allocator:
    def __init__(self) -> None:
        self.s: dict[str, dict[str, Any]] = {}
        self.notes: deque[str] = deque(maxlen=20)
        self.probe_tick = 0

    def _get(self, key: str) -> dict[str, Any]:
        return self.s.setdefault(key, {"n": 0.0, "mean": 0.0, "m2": 0.0, "trades": 0, "wins": 0, "sol": 0.0, "bench_until": 0.0,
                                       "benched_times": 0, "last": deque(maxlen=12)})

    def gate(self, key: str) -> tuple[bool, float, str]:
        """(allowed, size multiplier, why) for a proposal from strategy `key`."""
        st = self._get(key)
        now = time.time()
        if st["bench_until"] > now:
            self.probe_tick += 1
            if self.probe_tick % 6 == 0:
                return True, 0.3, "probe"                  # small test trade: can it earn its way back?
            return False, 0.0, "benched"
        if st["n"] >= 8:
            se = math.sqrt(max(1e-6, st["m2"] / st["n"])) / math.sqrt(st["n"])
            edge = st["mean"] / max(0.05, se * math.sqrt(st["n"]))            # risk-adjusted record
            return True, max(0.4, min(1.8, 1 + 3 * st["mean"] + 0.1 * edge)), "record"
        return True, 1.0, "new"

    def book(self, key: str, net: float, sol_pnl: float, probe: bool = False) -> str | None:
        st = self._get(key)
        st["n"] = st["n"] * DECAY + 1
        d = net - st["mean"]
        st["mean"] += d / st["n"]
        st["m2"] = st["m2"] * DECAY + d * (net - st["mean"])
        st["trades"] += 1
        st["wins"] += int(net > 0)
        st["sol"] = round(st["sol"] + sol_pnl, 6)
        st["last"].append(net)
        now = time.time()
        msg = None
        if st["bench_until"] > now:
            recent = list(st["last"])[-4:]
            if probe and len(recent) >= 3 and sum(recent) / len(recent) > 0.01:
                st["bench_until"] = 0.0
                msg = f"✅ Allocator un-benched {key}: its probes are making money again ({sum(recent) / len(recent) * 100:+.1f}%)."
        elif st["n"] >= MIN_N:
            se = math.sqrt(max(1e-6, st["m2"] / st["n"])) / math.sqrt(st["n"])
            if st["mean"] < -0.01 and st["mean"] + se < 0:
                st["bench_until"] = now + BENCH_S * (1 + min(3, st["benched_times"]))
                st["benched_times"] += 1
                msg = (f"⛔ Allocator benched {key} for {BENCH_S * (1 + min(3, st['benched_times'] - 1)) / 60:.0f} min — "
                       f"{st['trades']} trades averaging {st['mean'] * 100:+.1f}% after fees. Small probes only until it proves itself.")
        if msg:
            self.notes.appendleft(msg)
        return msg

    def state(self) -> dict[str, Any]:
        return {k: {**{kk: v for kk, v in st.items() if kk != "last"}, "last": list(st["last"])} for k, st in self.s.items()}

    def restore(self, s: dict[str, Any] | None) -> None:
        for k, st in (s or {}).items():
            cur = self._get(k)
            cur.update({kk: v for kk, v in st.items() if kk != "last"})
            cur["last"] = deque(st.get("last") or [], maxlen=12)

    def snapshot(self) -> dict[str, Any]:
        now = time.time()
        rows = []
        for k, st in self.s.items():
            ok, mult, why = (True, 1.0, "new")
            if st["bench_until"] <= now:
                ok, mult, why = self.gate(k)
            rows.append({"strategy": k, "trades": st["trades"], "win_pct": round(st["wins"] / st["trades"] * 100) if st["trades"] else None,
                         "avg_pct": round(st["mean"] * 100, 2), "sol": st["sol"], "benched": st["bench_until"] > now,
                         "bench_s": max(0, round(st["bench_until"] - now)), "size_mult": round(mult, 2) if st["bench_until"] <= now else 0.3})
        rows.sort(key=lambda r: -r["avg_pct"])
        return {"strategies": rows, "notes": list(self.notes)[:8]}
