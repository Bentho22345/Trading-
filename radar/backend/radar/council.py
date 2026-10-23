"""The Nebula: three brains that argue every trade out before money moves.

  EXECUTOR   the main brain (brain.py): finds the trade — snipes, scalps, swings, influx copies — and proposes it.
  SKEPTIC    its own model of "this trade LOSES after fees", trained on every real outcome AND every trade the council
             turned down. It argues for smaller size, tighter exits — and can veto outright when it's sure.
  OPTIMIST   its own model of "this trade could RUN (+25% or more)". It argues for a bigger bet and room to run, and
             holds a position the skeptic wants to dump while volume, holders and liquidity keep pouring in.

How they decide (bull / bear debate + risk vote, as in TradingAgents, arXiv 2412.20138)
  Each brain votes a go-confidence; votes are weighted by CREDIBILITY, learned with Hedge (multiplicative weights):
  after every outcome each brain loses weight in proportion to how wrong its vote was, so the council listens to
  whoever has been right lately. Size, and which exit PLAYBOOK to use, come out of the same weighted vote.

How they learn — from every trade, taken or not
  Playbooks   flash · quick · swing · runner · moon (take-profit / stop / max hold / trailing). For EVERY trade and
              every ghost (a trade the council rejected or vetoed) all five playbooks are replayed on the real price
              path, after fees. So each trade teaches what the best exit WOULD have been, not just what happened, and a
              Thompson-sampled bandit per style picks the playbook that's actually making money.
  Ghosts      rejected trades are followed anyway: the skeptic learns whether its vetoes saved money or cost it.
  Regimes     a losing run flips the council DEFENSIVE (higher bar, smaller size, more exploration of exits — it
              changes things up); a winning run flips it AGGRESSIVE. The bar also relaxes while idle so it never stalls.
"""
from __future__ import annotations

import math
import random
import time
from array import array
from collections import deque
from typing import Any

from . import curve
from .brain import DN_PRIORS, KEYS, LABELS, PRIORS, RUG_PRIORS, UP_PRIORS, Logit, _clip

BRAINS = ("executor", "skeptic", "optimist")
PLAYBOOKS: dict[str, dict[str, float | None]] = {
    "flash": {"tp": 1.08, "stop": 0.05, "hold": 45, "trail": None, "arm": None},
    "quick": {"tp": 1.12, "stop": 0.07, "hold": 90, "trail": None, "arm": None},
    "swing": {"tp": 1.30, "stop": 0.10, "hold": 240, "trail": 0.10, "arm": 1.15},
    "runner": {"tp": 2.00, "stop": 0.15, "hold": 600, "trail": 0.15, "arm": 1.30},
    "moon": {"tp": 4.00, "stop": 0.25, "hold": 1500, "trail": 0.22, "arm": 1.60},
}
ORDER = list(PLAYBOOKS)
DEFAULT_PLAY = {"snipe": "quick", "scalp": "quick", "swing": "swing", "copy": "swing", "wave2": "swing"}
BIG = 0.25                                   # what the optimist calls a run: +25% after fees
# shrunk priors: start near calibrated (a saturated skeptic says "no" to everything, which is useless, not careful)
SKEPTIC_PRIORS = {k: round(0.35 * (0.6 * RUG_PRIORS.get(k, 0) + 0.6 * DN_PRIORS.get(k, 0) - 0.4 * UP_PRIORS.get(k, 0) - 0.3 * PRIORS.get(k, 0)), 3)
                  for k in KEYS}
OPTIMIST_PRIORS = {k: round(0.35 * (0.7 * PRIORS.get(k, 0) + 0.6 * UP_PRIORS.get(k, 0) - 0.3 * RUG_PRIORS.get(k, 0)), 3) for k in KEYS}
# the Referee — a brain over the brains: a stacked model that learns which COMBINATIONS of the executor's, skeptic's and
# optimist's votes (plus style, regime, market heat, feed coverage and tape freshness) actually ended in profit after fees
REF_PRIORS = {"exec": 0.4, "skep": 1.0, "opt": 0.6, "p_lose": -1.2, "p_big": 0.8, "s_snipe": 0.0, "s_scalp": 0.0, "s_swing": 0.0,
              "s_copy": 0.0, "s_wave2": 0.0, "defensive": -0.2, "heat": 0.2, "cov": 0.0, "quiet": -0.5, "vol": 0.3, "early": 0.0,
              "liq_in": 0.2, "holders_up": 0.2, "apes": 0.1, "pros": 0.1, "influx": 0.1, "mom": 0.1, "near_grad": 0.0}
REF_TRUST_N = 150
FAST = ("snipe", "scalp", "wave2")                    # fast styles never take the 25-minute moon playbook
MAX_REAL, MAX_GHOST, GHOST_RATE = 400, 900, 0.35      # ghosts are free lessons: follow a third of the trades it turns down
ETA = 0.4                                    # Hedge learning rate
LR = 0.05


def _logit(p: float) -> float:
    p = min(0.99, max(0.01, p))
    return math.log(p / (1 - p))


def costs(size: float, vsol: float | None, prio: float = 0.0005) -> tuple[float, float]:
    """Graduated (AMM) coins: fraction lost on the way in and out — fees + pool impact + priority fee. On the bonding curve
    the exact maths in curve.py is used instead (there impact comes back on the way out; only fees are lost)."""
    impact = size / max(30.0, vsol or 60.0)
    fixed = prio / max(0.01, size)
    return 0.015 + impact + fixed, 0.015 + impact + fixed


class Calibrator:
    """Maps the skeptic's raw 'it loses' odds onto how often trades at those odds ACTUALLY lost (10 bins, decayed).
    The expected-value gate runs on these honest numbers, not on the model's self-belief."""

    def __init__(self) -> None:
        self.bins = [[0.0, 0.0] for _ in range(10)]          # [weight, losses]

    def _i(self, p: float) -> int:
        return min(9, max(0, int(p * 10)))

    def add(self, p: float, lost: bool, w: float = 1.0) -> None:
        b = self.bins[self._i(p)]
        b[0] = b[0] * 0.995 + w
        b[1] = b[1] * 0.995 + (w if lost else 0.0)

    def __call__(self, p: float) -> float:
        n, l = self.bins[self._i(p)]
        k = 6.0                                              # sparse bins lean on the raw odds
        return (l + k * p) / (n + k)


class Council:
    def __init__(self, brain: Any) -> None:
        self.b = brain
        self.skeptic = Logit(SKEPTIC_PRIORS, _logit(0.55))
        self.optimist = Logit(OPTIMIST_PRIORS, _logit(0.10))
        self.referee = Logit(REF_PRIORS, _logit(0.15))
        self.ref_rate = 0.15                                      # running profit rate: the referee's no-information baseline
        self.ref_base: deque[float] = deque(maxlen=500)           # baseline Brier on the same outcomes the referee is scored on
        self.cred = {k: 1 / 3 for k in BRAINS}
        self.bar = 0.48
        self.base_lose, self.base_big = 0.55, 0.10
        self.plays: dict[str, dict[str, list[float]]] = {}       # style -> playbook -> [n, mean, M2] (decayed)
        self.track: dict[str, dict[str, Any]] = {}               # counterfactual trackers: real positions + ghosts
        self.n_real = 0
        self.debate: deque[dict[str, Any]] = deque(maxlen=60)
        self.audit_notes: deque[str] = deque(maxlen=10)
        self.recent: deque[float] = deque(maxlen=25)              # last real trades' net results
        self.regime = "normal"
        self.regime_trades = 0                                    # trades since the last regime change (hysteresis)
        self.explore_left = 0
        self.win_rate = 0.45                                      # the no-information baseline every vote is scored against
        self.recent_lose: deque[float] = deque(maxlen=200)        # the skeptic's recent p_lose on proposals (its veto is relative)
        self.stats = {"proposed": 0, "approved": 0, "rejected": 0, "vetoed": 0, "ghosts_done": 0, "saved_sol": 0.0, "missed_sol": 0.0,
                      "skeptic_exits": 0, "optimist_holds": 0, "regime_changes": 0}
        self.rng = random.Random()
        self.plug_margin = 0.0                                    # learned: how much more sure the skeptic must be to pull the plug
        self.cal = Calibrator()
        self.exit_q: dict[str, list[float]] = {}                  # exit rule -> [weight, mean(real − playbook), muted_until]
        self.last_step = 0.0
        self.last_decision_ts = 0.0

    # ---------------- persistence ----------------
    def state(self) -> dict[str, Any]:
        return {"skeptic": self.skeptic.state(), "optimist": self.optimist.state(), "cred": self.cred, "bar": round(self.bar, 4),
                "base": [round(self.base_lose, 4), round(self.base_big, 4)], "plays": self.plays, "stats": self.stats,
                "regime": self.regime, "recent": list(self.recent), "win_rate": round(self.win_rate, 4),
                "plug_margin": round(self.plug_margin, 4), "cal": self.cal.bins,
                "exit_q": self.exit_q, "referee": self.referee.state(), "ref_rate": round(self.ref_rate, 4)}

    def restore(self, s: dict[str, Any] | None) -> None:
        if not s:
            return
        self.skeptic.restore(s.get("skeptic"))
        self.optimist.restore(s.get("optimist"))
        self.referee.restore(s.get("referee"))
        self.ref_rate = float(s.get("ref_rate", self.ref_rate))
        c = s.get("cred") or {}
        if all(k in c for k in BRAINS):
            self.cred = {k: float(c[k]) for k in BRAINS}
        self.bar = float(s.get("bar", self.bar))
        self.base_lose, self.base_big = (s.get("base") or [self.base_lose, self.base_big])[:2]
        self.plays = s.get("plays") or {}
        self.stats.update(s.get("stats") or {})
        self.regime = s.get("regime") or "normal"
        self.win_rate = float(s.get("win_rate", self.win_rate))
        self.plug_margin = float(s.get("plug_margin", 0.0))
        self.exit_q = {k: list(v) for k, v in (s.get("exit_q") or {}).items()}
        if s.get("cal") and len(s["cal"]) == 10:
            self.cal.bins = [list(b) for b in s["cal"]]
        self.recent.extend(s.get("recent") or [])

    # ---------------- the vote ----------------
    def votes(self, f: dict[str, float], exec_conf: float) -> dict[str, Any]:
        p_lose, p_big = self.skeptic.p(f), self.optimist.p(f)
        # each judged against its own base rate (most memecoin trades lose — an absolute cut-off would block everything)
        skep = _clip(0.5 + 0.35 * math.log2(max(0.2, (1 - p_lose) / max(0.05, 1 - self.base_lose))), 0, 1)
        opt = _clip(0.5 + 0.25 * math.log2(max(0.25, p_big / max(0.02, self.base_big))), 0, 1)
        return {"executor": round(exec_conf, 3), "skeptic": round(skep, 3), "optimist": round(opt, 3), "p_lose": round(p_lose, 3),
                "p_big": round(p_big, 3)}

    def meta(self, style: str, v: dict[str, Any], f: dict[str, float]) -> dict[str, float]:
        b = self.b
        cov = ((getattr(b, "pipe", None) or {}).get("feed_coverage_pct") or 100) / 100
        return {"exec": v["executor"], "skep": v["skeptic"], "opt": v["optimist"], "p_lose": v["p_lose"], "p_big": v["p_big"],
                **{f"s_{k}": 1.0 if style == k else 0.0 for k in ("snipe", "scalp", "swing", "copy", "wave2")},
                "defensive": 1.0 if self.regime == "defensive" else 0.0,
                "heat": _clip((b.heat_mult() if hasattr(b, "heat_mult") else 1.0) - 1.0, -1, 1), "cov": _clip(cov, 0, 1),
                "quiet": _clip(f.get("quiet", 0.0), 0, 1), "vol": _clip(f.get("vol_accel", 0.0), -1, 1),
                "early": _clip(f.get("age_0_2m", 0.0), 0, 1), "liq_in": _clip(f.get("liq_influx", 0.0), -1, 1),
                "holders_up": _clip(f.get("holder_growth", 0.0), -1, 1), "apes": _clip(f.get("ape_wave", 0.0), 0, 1),
                "pros": _clip(f.get("pro_share", 0.0), 0, 1), "influx": _clip(f.get("influx", 0.0), 0, 1),
                "mom": _clip(f.get("mom_30s", 0.0), -1, 1), "near_grad": _clip(f.get("near_grad", 0.0), 0, 1)}

    def referee_trusted(self) -> bool:
        """Only once it has judged enough outcomes AND beats simply guessing the base rate on them."""
        st = self.referee.stats()
        if self.referee.n < REF_TRUST_N or st["brier"] is None or len(self.ref_base) < 50:
            return False
        return st["brier"] < sum(self.ref_base) / len(self.ref_base) - 0.003

    def why(self, model: Logit, f: dict[str, float], n: int = 2) -> str:
        c = sorted(((model.w[k] * f.get(k, 0.0), k) for k in model.w), reverse=True)
        return ", ".join(LABELS.get(k, k).lower() for v, k in c[:n] if v > 0.1)

    def choose_play(self, style: str, v: dict[str, Any]) -> str:
        stats = self.plays.get(style) or {}
        temp = 2.0 if self.explore_left > 0 else 1.0
        default = DEFAULT_PLAY.get(style, "quick")
        best, best_s = default, -9.0
        allowed = [n for n in ORDER if not (style in FAST and n == "moon")]
        for name in allowed:
            # unproven playbooks start just behind the style's default, with a narrow prior: it explores, it doesn't gamble
            n, mean, m2 = stats.get(name, [0.0, 0.0 if name == default else -0.03, 0.0])
            sd = math.sqrt(m2 / n) if n > 1 else 0.04
            draw = mean + temp * self.rng.gauss(0, max(0.01, sd) / math.sqrt(n + 1))
            if draw > best_s:
                best, best_s = name, draw
        i = ORDER.index(best)
        top = len(allowed) - 1
        if v["optimist"] >= 0.8 and self.cred["optimist"] >= 0.3 and i < top:
            i += 1                                                   # the optimist talks it into giving the trade room
        if v["skeptic"] <= 0.25 and self.cred["skeptic"] >= 0.3 and i > 0:
            i -= 1                                                   # the skeptic talks it into a tighter leash
        if self.regime == "defensive" and i > 1:
            i -= 1
        return ORDER[i]

    def decide(self, style: str, f: dict[str, float], exec_conf: float, symbol: str, mint: str) -> dict[str, Any]:
        """The debate: three votes, weighted by credibility → go / no, size multiplier, exit playbook, and a one-line record."""
        self.stats["proposed"] += 1
        self.last_decision_ts = time.time()
        v = self.votes(f, exec_conf)
        m = self.meta(style, v, f)
        v["p_win"] = round(self.referee.p(m), 3)                     # the referee's honest odds this ends in profit after fees
        c = self.cred
        go = sum(c[k] * v[k] for k in BRAINS)
        bar = self.bar + (0.04 if self.regime == "defensive" else -0.03 if self.regime == "aggressive" else 0.0)
        self.recent_lose.append(v["p_lose"])
        st = self.skeptic.stats()
        calibrated = self.skeptic.n >= 50 and (st["accuracy"] or 0) >= 58 and (st["brier"] or 1) <= 0.22
        q85 = sorted(self.recent_lose)[int(0.85 * (len(self.recent_lose) - 1))] if len(self.recent_lose) >= 20 else 0.0
        veto = calibrated and c["skeptic"] >= 0.25 and v["p_lose"] >= max(0.8, self.base_lose + 0.2, q85)
        trusted = self.referee_trusted()
        # a proven referee can wave through a trade the weighted vote fell short on, when its odds beat the market's
        # profit rate (the EV gate still has the last word on payoff)
        ref_ok = trusted and v["p_win"] >= self.ref_rate * 1.15
        ok = (go >= bar or ref_ok) and not veto
        size_mult = (c["executor"] * 1.0 + c["skeptic"] * _clip(0.4 + v["skeptic"], 0.4, 1.3)
                     + c["optimist"] * _clip(0.6 + 1.2 * v["optimist"], 0.6, 1.8))
        size_mult *= 0.7 if self.regime == "defensive" else 1.2 if self.regime == "aggressive" else 1.0
        play = self.choose_play(style, v)
        pb = PLAYBOOKS[play]
        if trusted and v["p_win"] < 0.5 * self.ref_rate:              # the referee has earned a veto on clear losers
            ok, veto = False, True
        out = {"go": ok, "veto": veto, "score": round(go, 3), "bar": round(bar, 3), "votes": v, "meta": m, "cred": {k: round(c[k], 3) for k in BRAINS},
               "size_mult": round(_clip(size_mult, 0.3, 2.0), 3), "play": play, "style": style,
               "exits": {"tp": pb["tp"], "stop": pb["stop"], "max_s": pb["hold"], "trail": pb["trail"], "arm": pb["arm"], "preset": play,
                         "power": False},
               "why": {"skeptic": self.why(self.skeptic, f), "optimist": self.why(self.optimist, f)}}
        out["summary"] = (f"🗳 exec {v['executor']:.2f} · skeptic {v['skeptic']:.2f} · optimist {v['optimist']:.2f} → "
                          f"{'VETO' if veto else 'GO' if ok else 'no'} ({go:.2f} vs {bar:.2f}) · {play}")
        self.debate.appendleft({"ts": time.time(), "symbol": symbol, "mint": mint, **{k: out[k] for k in ("go", "veto", "score", "bar", "votes", "play", "style", "why")},
                                "size_mult": out["size_mult"]})
        if self.explore_left > 0:
            self.explore_left -= 1
        self.stats["approved" if ok else "vetoed" if veto else "rejected"] += 1
        return out

    # ---------------- holding: the skeptic can pull the plug, the optimist can hold ----------------
    def exit_vote(self, p: dict[str, Any], f: dict[str, float], x: float, age: float) -> tuple[float, str] | None:
        if not f or age < 8:
            return None
        p_lose, p_big = self.skeptic.p(f), self.optimist.p(f)
        sell = self.cred["skeptic"] * (1.0 if p_lose >= min(0.97, max(0.8, self.base_lose + 0.2) + self.plug_margin) else 0.0)
        hold = self.cred["optimist"] * (1.0 if (p_big >= 2 * self.base_big or self.b.surging(f)) else 0.0)
        if sell - hold >= 0.2:
            self.stats["skeptic_exits"] += 1
            p["_exit_kind"] = "skeptic"
            return (1.0 if x < 1.0 else 0.5), (f"skeptic pulled the plug ({p_lose * 100:.0f}% it loses: {self.why(self.skeptic, f)})"
                                                 + (" — banked half" if x >= 1.0 else ""))
        if hold > 0 and sell > 0:
            self.stats["optimist_holds"] += 1
        return None

    # ---------------- counterfactual tracking (real positions + ghosts) ----------------
    def open_track(self, key: str, mint: str, f: dict[str, float] | None, entry_mcap: float, size: float, vsol: float | None,
                   d: dict[str, Any], real: bool, sol: float = 0.0) -> None:
        if not entry_mcap or key in self.track:
            return
        n_real = self.n_real
        if (real and n_real >= MAX_REAL) or (not real and len(self.track) - n_real >= MAX_GHOST):
            return
        cb, cs = costs(size, vsol)
        L = self.b.ap.sniper.launches.get(mint)
        pl = curve.pool(entry_mcap, bool(getattr(L, "graduated_at", None)))
        cv = None
        if pl and size > 0:                                          # exact constant-product replay: fees are the round-trip cost
            k, v0, fee = pl
            s_in = size * (1 - fee)
            cv = (v0, s_in, curve.tokens_for(v0, s_in, k), size + 0.0005, k)
            cs = fee + 0.0005 / size
        style = d.get("style")
        self.n_real += int(real)
        self.track[key] = {"mint": mint, "t0": time.time(), "entry": entry_mcap, "cb": cb, "cs": cs, "cv": cv, "real": real, "sol": sol,
                           "vec": array("f", ((f or {}).get(k, 0.0) for k in KEYS)), "votes": d.get("votes"), "play": d.get("play"),
                           "style": d.get("style"), "strat": d.get("strat"), "go": d.get("go"), "veto": d.get("veto"), "last": 1.0, "bench": d.get("bench"),
                           "meta": d.get("meta"),
                           "st": {n: [False, 1.0, None] for n in ORDER if not (style in FAST and n == "moon")}}

    def refill(self, key: str, entry_mcap: float) -> None:
        """A demo order landed later than it was placed: replay its playbooks from the price it actually filled at."""
        t = self.track.get(key)
        if t is None or not entry_mcap:
            return
        t["entry"] = entry_mcap
        if t.get("cv"):
            _, s_in, _, basis, k = t["cv"]
            v0 = curve.vsol_from_mcap(entry_mcap, k)
            if v0:
                t["cv"] = (v0, s_in, curve.tokens_for(v0, s_in, k), basis, k)

    def ghost(self, mint: str, f: dict[str, float], L: Any, d: dict[str, Any], size: float, rate: float | None = None) -> None:
        """A trade the council turned down — follow it anyway, so it learns whether saying no was right. A rejected top-wallet
        influx is ALWAYS followed (rare, and exactly the call it most needs to get right)."""
        rate = 1.0 if d.get("style") == "copy" else (GHOST_RATE if rate is None else rate)
        if L is None or not getattr(L, "mcap_sol", None) or self.rng.random() > rate:
            return
        self.open_track(f"g:{mint}:{int(time.time())}", mint, f, L.mcap_sol, size, getattr(L, "vsol", None), d, real=False, sol=size)

    def step(self, now: float) -> None:
        if now - self.last_step < 0.5:
            return
        self.last_step = now
        launches = self.b.ap.sniper.launches
        done = []
        for key, t in self.track.items():
            L = launches.get(t["mint"])
            age = now - t["t0"]
            if L is not None and L.mcap_sol:
                v1 = curve.vsol_from_mcap(L.mcap_sol, t["cv"][4]) if t.get("cv") else None
                if v1:
                    _, s_in, q, basis, k = t["cv"]
                    t["last"] = curve.sol_for(v1 + s_in, q, k) / basis  # what dumping it now returns, per SOL put in
                else:
                    t["last"] = (L.mcap_sol / t["entry"]) / (1 + t["cb"])
            x = t["last"]
            alive = False
            for name, st in t["st"].items():
                if st[0]:
                    continue
                pb = PLAYBOOKS[name]
                st[1] = max(st[1], x)
                hit = (x <= 1 - pb["stop"] or x >= pb["tp"] or age >= pb["hold"] or L is None
                       or (pb["trail"] and st[1] >= pb["arm"] and x <= st[1] * (1 - pb["trail"])))
                if hit:
                    st[0], st[2] = True, x * (1 - t["cs"]) - 1
                else:
                    alive = True
            if not alive:
                done.append(key)
        for key in done:
            t = self.track.pop(key)
            self.n_real -= int(t["real"])
            self.finish(t)

    def finish(self, t: dict[str, Any]) -> None:
        nets = {n: st[2] for n, st in t["st"].items() if st[2] is not None}
        if not nets:
            return
        style = t["style"] or "scalp"
        w = 1.0 if t["real"] else 0.5
        bucket = self.plays.setdefault(style, {})
        for n, net in nets.items():                                  # every playbook learns from every path
            s = bucket.setdefault(n, [0.0, -0.02, 0.0])
            s[0] = s[0] * 0.995 + w
            d = net - s[1]
            s[1] += w * d / max(1.0, s[0])
            s[2] = s[2] * 0.995 + w * d * (net - s[1])
        f = dict(zip(KEYS, t["vec"]))
        best = max(nets.values())
        if t.get("meta"):                                            # the referee learns from every judged path, real and ghost
            y = 1.0 if nets.get(t["play"] or "quick", best) > 0 else 0.0
            self.ref_base.append((self.ref_rate - y) ** 2)
            self.ref_rate = 0.99 * self.ref_rate + 0.01 * y
            self.referee.step(t["meta"], y, LR * w)
        if t["real"] and t.get("rule") and t.get("real_net") is not None:
            self.audit(t["rule"], t["real_net"] - nets.get(t["play"] or "quick", best))
        self.optimist.step(f, 1.0 if best >= BIG else 0.0, LR * w)
        self.base_big = 0.98 * self.base_big + 0.02 * (1.0 if best >= BIG else 0.0)
        if not t["real"] and t.get("bench"):                        # a benched strategy's paper trade: allocator evidence only
            if t.get("strat"):
                self.b.alloc.book_ghost(t["strat"], nets.get(t["play"] or "quick", best))
            return
        if not t["real"]:
            net = nets.get(t["play"] or "quick", best)
            lose = 1.0 if net < 0 else 0.0
            if t.get("votes"):
                self.cal.add(t["votes"].get("p_lose", 0.5), net < 0, 0.5)
            if t.get("strat"):
                self.b.alloc.book_ghost(t["strat"], net)
            self.skeptic.step(f, lose, LR * 0.5)
            self.base_lose = 0.99 * self.base_lose + 0.01 * lose
            self.hedge(t["votes"], net, ETA / 2)
            self.stats["ghosts_done"] += 1
            sol = t.get("sol") or 0.0
            if net < 0:
                self.stats["saved_sol"] = round(self.stats["saved_sol"] - net * sol, 6)     # saying no saved this
                self.bar = min(0.62, self.bar + 0.0005)
            else:
                self.stats["missed_sol"] = round(self.stats["missed_sol"] + net * sol, 6)   # saying no cost this
                if net > 0.03:
                    self.bar = max(0.38, self.bar - 0.003)               # turning down winners costs more than taking a loser

    # ---------------- outcomes ----------------
    def hedge(self, votes: dict[str, float] | None, net: float, eta: float = ETA) -> None:
        if not votes:
            return
        y = 1.0 if net > 0 else 0.0
        base = (self.win_rate - y) ** 2                       # what "no information" would have scored
        for k in BRAINS:
            if k in votes:                                    # only beating the baseline earns trust (a constant "no" doesn't)
                self.cred[k] *= math.exp(-eta * ((votes[k] - y) ** 2 - base))
        tot = sum(self.cred.values()) or 1.0
        self.cred = {k: max(0.08, v / tot) for k, v in self.cred.items()}
        tot = sum(self.cred.values())
        self.cred = {k: v / tot for k, v in self.cred.items()}

    def on_close(self, p: dict[str, Any], mult: float, f: dict[str, float] | None) -> list[str]:
        """A real trade closed: the skeptic learns, credibility moves, the bar and the regime adapt."""
        notes = []
        net = mult - 1
        cv = p.get("council") or {}
        if (cv.get("votes") or {}).get("p_lose") is not None:
            self.cal.add(cv["votes"]["p_lose"], net < 0)
        if f:
            lose = 1.0 if net < 0 else 0.0
            self.skeptic.step(f, lose, LR)
            self.base_lose = 0.98 * self.base_lose + 0.02 * lose
        self.hedge(cv.get("votes"), net)
        self.win_rate = 0.97 * self.win_rate + 0.03 * (1.0 if net > 0 else 0.0)
        self.bar = _clip(self.bar + (0.004 if net < 0 else -0.003), 0.38, 0.62)
        self.recent.append(net)
        self.regime_trades += 1
        if len(self.recent) >= 10 and self.regime_trades >= 20:
            avg = sum(self.recent) / len(self.recent)
            r = self.regime                                   # hysteresis: harder to enter a regime than to stay in it
            new = ("defensive" if avg < -0.03 else "aggressive" if avg > 0.03 else
                   r if (r == "defensive" and avg < 0) or (r == "aggressive" and avg > 0) else "normal")
            if new != self.regime:
                self.regime_trades = 0
                self.stats["regime_changes"] += 1
                leader = max(self.cred, key=self.cred.get)
                if new == "defensive":
                    self.explore_left = 40                           # change things up: try other exit playbooks hard
                    notes.append(f"🔄 Nebula goes DEFENSIVE — last {len(self.recent)} trades averaged {avg * 100:+.1f}%. Raising the bar, "
                                 f"cutting size, exploring new exit playbooks. Listening most to the {leader} ({self.cred[leader] * 100:.0f}%).")
                elif new == "aggressive":
                    notes.append(f"🚀 Nebula goes AGGRESSIVE — last {len(self.recent)} trades averaged {avg * 100:+.1f}%. Lower bar, bigger size.")
                else:
                    notes.append(f"⚖️ Nebula back to NORMAL (last {len(self.recent)} trades {avg * 100:+.1f}%).")
                self.regime = new
        return notes

    def audit(self, rule: str, diff: float) -> None:
        """Book how much a discretionary exit beat (or lost to) just following the playbook; mute rules that keep losing."""
        q = self.exit_q.setdefault(rule, [0.0, 0.0, 0.0])
        q[0] = q[0] * 0.98 + 1
        q[1] += (diff - q[1]) / q[0]
        if q[0] >= 12 and q[1] < -0.01 and q[2] < time.time():
            q[2] = time.time() + 1800
            q[0] *= 0.5                                               # when it's retested, the old verdict counts for less
            self.audit_notes.appendleft(f"🔇 Exit auditor muted '{rule}' for 30 min — it did {q[1] * 100:+.1f}% vs just following "
                                        f"the playbook. Retesting after.")

    def exit_muted(self, rule: str) -> bool:
        q = self.exit_q.get(rule)
        return bool(q and q[2] > time.time())

    def plug_lesson(self, ran: bool, dumped: bool, symbol: str, after: float) -> str | None:
        """After the skeptic pulls the plug it keeps watching: a coin that ran anyway makes it demand more next time."""
        if ran:
            self.plug_margin = min(0.15, self.plug_margin + 0.03)
            return (f"🛡 The skeptic dumped ${symbol} and it ran {after:.1f}× after — it now needs to be more sure before pulling the "
                    f"plug (+{self.plug_margin * 100:.0f} pts).")
        if dumped:
            self.plug_margin = max(0.0, self.plug_margin - 0.01)
        return None

    def idle(self, now: float, last_buy: float) -> None:
        if last_buy and now - last_buy > 30 and self.bar > 0.48:
            self.bar = max(0.48, self.bar - 0.002)                    # never stalls: an idle council relaxes

    # ---------------- reads ----------------
    def snapshot(self) -> dict[str, Any]:
        lb = {}
        for style, plays in self.plays.items():
            lb[style] = sorted(({"play": n, "n": round(s[0], 1), "avg_pct": round(s[1] * 100, 2)} for n, s in plays.items()),
                               key=lambda r: -r["avg_pct"])
        return {"cred": {k: round(v * 100, 1) for k, v in self.cred.items()}, "bar": round(self.bar, 3), "regime": self.regime,
                "base_lose_pct": round(self.base_lose * 100, 1), "base_big_pct": round(self.base_big * 100, 1),
                "skeptic": self.skeptic.stats(), "optimist": self.optimist.stats(), "playbooks": lb,
                "referee": {**self.referee.stats(), "trusted": self.referee_trusted(), "profit_rate_pct": round(self.ref_rate * 100, 1),
                            "baseline_brier": round(sum(self.ref_base) / len(self.ref_base), 3) if self.ref_base else None},
                "tracking": {"real": sum(1 for t in self.track.values() if t["real"]), "ghosts": sum(1 for t in self.track.values() if not t["real"])},
                "stats": self.stats, "debate": list(self.debate)[:25], "exploring": self.explore_left,
                "recent_avg_pct": round(sum(self.recent) / len(self.recent) * 100, 2) if self.recent else None,
                "plug_margin": round(self.plug_margin * 100, 1),
                "exit_audit": sorted(({"rule": k, "n": round(v[0], 1), "vs_playbook_pct": round(v[1] * 100, 2), "muted": v[2] > time.time()}
                                      for k, v in self.exit_q.items()), key=lambda r: r["vs_playbook_pct"]),
                "audit_notes": list(self.audit_notes)[:5]}
