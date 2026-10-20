"""Self-driving Autopilot, v5: Radar's own trading algorithm — it trades its own demo money (and, if you switch it on
there, real money under your hard caps), and it never stops learning.

How it decides
  Two models, both online logistic regressions over ~70 signals and both retrained continuously:
    WIN model   odds the coin runs +60% before it hits the stop (the trade it would actually take)
    RUG model   odds the coin collapses −60% within 20 minutes (the trade it must never take)
  value = P(win) × (1 − 0.6·P(rug)), nudged by its pattern memory. It buys the top slice of what it sees right now
  (a percentile bar), so it always trades the best of the current market.

What it reads (patterns.py): volume influx vs the minutes before, liquidity flowing in / draining out of the curve,
holders arriving / leaving, chart shape (drawdown, vertical candles, staircase of higher lows, volatility), rug tells
(one sell dumping the liquidity, whales unloading, sell streaks, wash trading), the bubble map (coordinated same-second
buys, funder-linked clusters and what they hold), the dev (holding, dumping, big launch buy, serial launcher, fresh
wallet), age and market-cap buckets — plus everything Radar already scores: upside / risk, top wallets, graduation pace,
narratives, X calls, YouTube, trends, insiders, snipers, bundlers, top-10.

How it learns (all the time, not just when it trades)
  Shadow lessons  every coin it scores is sampled at several ages and followed: did it hit +60% before the stop?
                  did it rug? Hundreds of labels an hour; resolved the moment the answer is known.
  Real lessons    every closed trade teaches both models 4× harder than a shadow lesson.
  Replay          every lesson is kept (database, compact vectors) and rehearsed in the background, so it keeps
                  sharpening between trades and remembers across restarts.
  RMSProp steps   per-signal learning rates that never decay to zero — it keeps adapting as the market changes,
                  with a pull back toward sane priors so one bad hour can't wreck it.

How it gets discouraged (and confident again)
  Mood            losses lower it (a rug more than a small stop), wins raise it, time heals it. A low mood means a
                  higher bar (it buys a smaller top slice), smaller size and fewer open positions.
  Losing streaks  4 losses in a row → a short cool-off (only top-10 wallet copies), then back in carefully.
  Drawdown        equity well below its high caps the mood.
  Patterns        it keeps a decaying win/loss record for ~40 readable patterns ("coins under 2 min old",
                  "serial-launcher devs", "liquidity draining", "vertical candle"…). Patterns that keep losing it money
                  get penalised — and it tells you what it learned. Patterns that work get a boost.
  Leaders         copied wallets that keep losing it money get benched; devs whose coins rugged it get blocked.
  Stops           after every stop / trailing exit it keeps watching the coin: shaken out and it ran → stops get more
                  room; it kept dumping → stops tighten. Consistent stop-losses therefore change how it exits.

Top wallets (v5)
  Their sells     a wallet it followed in sells → it follows them out; any top-ranked wallet dumping a coin it holds →
                  it sells part, all of it when several are leaving. Post-mortems tune how hard it follows them.
  Their buys      it copies an INFLUX (3+ top wallets in 5 min, or two top-10s in 2 min) and only when its own read
                  agrees — never a single wallet. Copies are capped at ~35% of positions; its own picks come several a tick.

Exits (one decision per tick, so you see it scale in and out as coins move): adaptive stop · scale-out ladder ·
back-to-entry protection · adaptive trailing stop · momentum-fade partials · rug-pattern and rug-model exits · copied
top-wallet sells · thesis broken · volume dried up · stalled / time stops scaled by a learned patience.
"""
from __future__ import annotations

import json
import math
import random
import time
from array import array
from collections import deque
from typing import Any

from . import patterns as pat

PRIORS: dict[str, float] = {
    "upside": 2.4, "risk": -2.0, "alpha": 1.4, "copy": 2.0, "velocity": 1.0, "progress": 0.8, "flow": 1.0, "sol_rate": 0.8,
    "buy_pressure": 0.7, "buyers": 0.8, "organic": 0.7, "meme": 0.9, "tweet": 1.4, "youtube": 0.6, "trend": 0.5,
    "social": 0.8, "socials": 0.4, "x_comm": 0.3, "dev": 0.6, "dev_sold": 0.3, "insiders": -1.8, "fresh": -0.5,
    "snipers": -0.8, "bundle": -1.0, "top10": -0.8, "bots": -0.4, "young": 0.4, "small": 0.4,
    "narrative": 1.6, "ignition": 1.0, "mention_speed": 1.0, "x_calls": 1.5, "hype_bots": -1.0,
    # v4 — the chart, the flows and the bubble map, straight off the trade tape
    "vol_accel": 0.8, "vol_1m": 0.4, "liq": 0.5, "liq_influx": 1.0, "liq_drain": -1.5, "holders": 0.6, "holder_growth": 0.8,
    "holders_leaving": -0.8, "drawdown": -1.2, "vertical": -0.6, "staircase": 0.8, "volatility": -0.3, "whale_sells": -1.0,
    "dump_candle": -1.4, "sell_streak": -0.8, "wash": -0.8, "retail": 0.5, "whale_buys": 0.2, "coordinated": -1.2,
    "clusters": -0.6, "cluster_hold": -1.4, "dev_hold": -0.8, "dev_dumping": -0.6, "dev_big_buy": -0.4, "dev_serial": -1.0,
    "dev_fresh": -0.3, "graduated": 0.3, "age_0_2m": 0.2, "age_2_5m": 0.3, "age_5_15m": 0.0, "age_15m": -0.3,
    "mc_lt8k": 0.3, "mc_8_25k": 0.2, "mc_25_70k": 0.0, "mc_70k": -0.3,
    # v5 — what the best wallets are doing right now, and short-term momentum
    "influx": 1.2, "smart_selling": -1.8, "mom_30s": 0.5, "mom_2m": 0.4, "quiet": -0.8,
}
RUG_PRIORS: dict[str, float] = {k: 0.0 for k in PRIORS} | {
    "risk": 1.6, "insiders": 1.6, "bundle": 1.2, "snipers": 0.8, "top10": 1.0, "fresh": 0.6, "bots": 0.5, "dev_sold": 0.4,
    "organic": -1.0, "buyers": -0.6, "dev": -0.6, "socials": -0.3, "narrative": -0.3, "hype_bots": 0.6, "upside": -0.4,
    "liq_drain": 1.6, "dump_candle": 1.4, "whale_sells": 1.0, "sell_streak": 0.6, "vertical": 0.8, "wash": 0.8,
    "coordinated": 1.2, "clusters": 0.6, "cluster_hold": 1.5, "dev_hold": 1.0, "dev_dumping": 1.0, "dev_big_buy": 0.6,
    "dev_serial": 1.2, "dev_fresh": 0.5, "holders": -0.5, "retail": -0.4, "staircase": -0.5, "drawdown": 0.6,
    "smart_selling": 1.0, "influx": -0.3, "quiet": 0.3,
}
LABELS = {"upside": "Upside score", "risk": "Risk score", "alpha": "Top wallets in", "copy": "Best wallets buying now",
          "velocity": "Graduation pace", "progress": "Bonding-curve progress", "flow": "Net SOL flowing in", "sol_rate": "Curve SOL / min",
          "buy_pressure": "Buy pressure", "buyers": "Buyer count", "organic": "Organic flow", "meme": "Claude meme score",
          "tweet": "Spawned by a tracked tweet", "youtube": "YouTube buzz", "trend": "Off-crypto trend", "social": "People posting it",
          "socials": "Social links", "x_comm": "X community", "dev": "Dev's graduations", "dev_sold": "Dev already sold",
          "insiders": "Insiders holding", "fresh": "Fresh wallets", "snipers": "Snipers holding", "bundle": "Bundlers holding",
          "top10": "Top-10 concentration", "bots": "Bot wallets", "young": "Earliness", "small": "Small market cap",
          "narrative": "Live narrative strength", "ignition": "Narrative igniting", "mention_speed": "Mention speed (σ)",
          "x_calls": "Called by tracked X accounts", "hype_bots": "Bot-driven hype",
          "vol_accel": "Volume influx", "vol_1m": "Volume (1m)", "liq": "Liquidity in the curve", "liq_influx": "Liquidity flowing in",
          "liq_drain": "Liquidity draining", "holders": "Holders", "holder_growth": "New holders / min", "holders_leaving": "Holders selling out",
          "drawdown": "Drawdown from the high", "vertical": "Vertical candle", "staircase": "Higher lows", "volatility": "Volatility",
          "whale_sells": "Whales doing the selling", "dump_candle": "Dump candle vs liquidity", "sell_streak": "Sell streak",
          "wash": "Wash trading", "retail": "Retail-sized buys", "whale_buys": "Whale-sized buys", "coordinated": "Coordinated buys (bubble map)",
          "clusters": "Funder clusters", "cluster_hold": "Biggest cluster's holding", "dev_hold": "Dev holding", "dev_dumping": "Dev selling",
          "dev_big_buy": "Dev's launch buy", "dev_serial": "Serial-launcher dev", "dev_fresh": "Brand-new dev wallet", "graduated": "Graduated",
          "age_0_2m": "Age < 2 min", "age_2_5m": "Age 2-5 min", "age_5_15m": "Age 5-15 min", "age_15m": "Age 15 min +",
          "mc_lt8k": "Mcap < $8k", "mc_8_25k": "Mcap $8-25k", "mc_25_70k": "Mcap $25-70k", "mc_70k": "Mcap $70k +",
          "influx": "Top-wallet influx", "smart_selling": "Top wallets selling it", "mom_30s": "Momentum (30s)",
          "mom_2m": "Momentum (2m)", "quiet": "Trading gone quiet"}
KEYS = list(PRIORS)                       # fixed order for the compact replay vectors
KEYS_VER = "v4:" + str(len(KEYS))
BIAS0, RUG_BIAS0 = -3.0, -1.6
AGGRESSION = {   # top-share of what it sees that it will buy, max positions, stop loss, base size, rug veto, buys per tick,
                 # how long a position may go without a new high (stall_s) and at all (time_s) before it's recycled
    "careful": {"top": 0.03, "max_open": 3, "stop": 0.20, "base": 0.02, "floor": 30, "cooldown": 6, "copy_rank": 10, "rug_veto": 0.45,
                "cool_s": 900, "burst": 1, "stall_s": 480, "time_s": 1800, "ladder": "steady"},
    "aggressive": {"top": 0.08, "max_open": 6, "stop": 0.25, "base": 0.03, "floor": 20, "cooldown": 3, "copy_rank": 25, "rug_veto": 0.55,
                   "cool_s": 480, "burst": 1, "stall_s": 360, "time_s": 1500, "ladder": "steady"},
    "degen": {"top": 0.15, "max_open": 10, "stop": 0.30, "base": 0.03, "floor": 14, "cooldown": 2, "copy_rank": 50, "rug_veto": 0.65,
              "cool_s": 240, "burst": 2, "stall_s": 240, "time_s": 1200, "ladder": "quick"},
    # demo default: lots of small bets, in and out fast — volume is how it learns and how it finds the runners
    "hyper": {"top": 0.25, "max_open": 20, "stop": 0.25, "base": 0.015, "floor": 9, "cooldown": 0.5, "copy_rank": 50, "rug_veto": 0.70,
              "cool_s": 150, "burst": 3, "stall_s": 180, "time_s": 900, "ladder": "quick"},
}
# scale-out ladders: (multiple, share of what's left to sell, marker). Partial sells as a coin moves = buys AND sells all day.
LADDERS = {"quick": [(1.25, 0.25, 101), (1.6, 0.30, 102), (2.2, 0.35, 103), (4.0, 0.50, 104)],
           "steady": [(1.4, 0.30, 101), (2.0, 0.35, 102), (3.0, 0.40, 103), (6.0, 0.50, 104)]}
SMART_SELL_SOL = 0.2                         # a top wallet's sell this size or bigger is a signal
LR_TRADE, LR_SHADOW, LR_REPLAY = 0.12, 0.03, 0.012
WIN_X = 1.6                                  # a shadow coin "wins" if it hits +60% before the stop
RUG_X = 0.4                                  # …and "rugs" if it falls to 0.4× (−60%) inside 20 minutes


def _sig(z: float) -> float:
    return 1 / (1 + math.exp(-max(-30.0, min(30.0, z))))


def _logit(p: float) -> float:
    p = min(0.99, max(0.01, p))
    return math.log(p / (1 - p))


def _clip(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def features(r: dict[str, Any], copy_n: float = 0.0, ctx: dict[str, Any] | None = None) -> dict[str, float]:
    mx = r.get("metrics") or {}
    n = (ctx or {}).get("narr") or {}
    xc = (ctx or {}).get("x_calls") or 0
    eta = r.get("eta_min")
    mc = r.get("mcap_usd") or 0
    f = {
        "upside": (r.get("upside") or 0) / 100,
        "risk": (r.get("risk") or 0) / 100,
        "alpha": min(1.0, len(r.get("alpha") or []) / 3),
        "copy": min(1.0, copy_n / 3),
        "velocity": 1.0 if r.get("graduated_at") else (1.0 if eta is not None and eta <= 5 else 0.7 if eta is not None and eta <= 10
                                                       else 0.4 if eta is not None and eta <= 20 else 0.1 if eta is not None else 0.0),
        "progress": min(1.0, (r.get("progress") or 0) / 100),
        "flow": max(-1.0, min(1.0, (r.get("net_sol_1m") or 0) / 10)),
        "sol_rate": max(0.0, min(1.0, (r.get("sol_per_min") or 0) / 5)),
        "buy_pressure": min(1.0, (mx.get("buy_ratio_1m") or 0) / 4),
        "buyers": min(1.0, math.log10(1 + (r.get("buyers") or 0)) / 2.5),
        "organic": ((r.get("organic") if r.get("organic") is not None else 50) or 0) / 100,
        "meme": (mx["ai_meme_score"] / 10) if mx.get("ai_meme_score") is not None else 0.4,
        "tweet": (mx.get("x_tweet_score") or 0) / 100,
        "youtube": min(1.0, (mx.get("yt_videos") or 0) / 3),
        "trend": 1.0 if mx.get("web_trend") else 0.0,
        "social": min(1.0, (mx.get("social_authors") or 0) / 5),
        "socials": min(1.0, (mx.get("socials") or 0) / 3),
        "x_comm": 1.0 if mx.get("x_community") else 0.0,
        "dev": min(1.0, (mx.get("dev_graduated") or 0) / 3),
        "dev_sold": 1.0 if mx.get("dev_sold") else 0.0,
        "insiders": min(1.0, (mx.get("insider_hold_pct") or 0) / 25),
        "fresh": (mx.get("fresh_pct") or 0) / 100,
        "snipers": min(1.0, (mx.get("snipers_hold_pct") or 0) / 40),
        "bundle": min(1.0, (mx.get("bundle_hold_pct") or 0) / 30),
        "top10": min(1.0, (mx.get("chain_top10_pct") if mx.get("chain_top10_pct") is not None else mx.get("top10_pct") or 0) / 60),
        "bots": min(1.0, (mx.get("bot_wallets") or 0) / 5),
        "young": 1 - min(1.0, (r.get("age_s") or 0) / 1200),
        "small": 1 - min(1.0, mc / 100_000) if mc else 0.5,
        "narrative": min(1.0, (n.get("strength") or 0) / 100),
        "ignition": 1.0 if n.get("stage") == "ignition" else 0.5 if n.get("stage") == "peak" else 0.0,
        "mention_speed": max(0.0, min(1.0, (n.get("z") or 0) / 5)),
        "x_calls": min(1.0, xc / 2),
        "hype_bots": min(1.0, (n.get("bot_share") or 0) * 1.5),
        "influx": min(1.0, ((ctx or {}).get("influx") or 0) / 4),
        "smart_selling": min(1.0, ((ctx or {}).get("smart_sells") or 0) / 2),
    }
    ch = (ctx or {}).get("chart")
    if ch:
        f.update(ch)
    return f


def percentile(vals: list[float], q: float) -> float:
    if not vals:
        return 100.0
    s = sorted(vals)
    return s[min(len(s) - 1, max(0, int(q * (len(s) - 1))))]


class Logit:
    """Online logistic regression with RMSProp per-signal step sizes (they never decay to zero, so it keeps adapting)
    and a gentle pull back toward its priors."""

    def __init__(self, priors: dict[str, float], bias: float, l2: float = 0.004) -> None:
        self.priors, self.b0, self.l2 = priors, bias, l2
        self.w = dict(priors)
        self.b = bias
        self.g2 = {k: 0.01 for k in priors}
        self.gb = 0.01
        self.n = 0
        self.brier: deque[float] = deque(maxlen=500)
        self.hits: deque[int] = deque(maxlen=500)            # 1 = it called it right (p ≥ .5 ⇔ y = 1)

    def z(self, f: dict[str, float]) -> float:
        return self.b + sum(w * f.get(k, 0.0) for k, w in self.w.items())

    def p(self, f: dict[str, float]) -> float:
        return _sig(self.z(f))

    def step(self, f: dict[str, float], y: float, lr: float, track: bool = True) -> float:
        p = self.p(f)
        err = y - p
        for k in self.w:
            x = f.get(k, 0.0)
            if not x and self.w[k] == self.priors[k]:
                continue
            g = err * x - self.l2 * (self.w[k] - self.priors[k])
            self.g2[k] = 0.95 * self.g2[k] + 0.05 * g * g
            self.w[k] = _clip(self.w[k] + lr * g / (math.sqrt(self.g2[k]) + 0.1), -6.0, 6.0)
        self.gb = 0.95 * self.gb + 0.05 * err * err
        self.b = _clip(self.b + lr * err / (math.sqrt(self.gb) + 0.1), -8.0, 2.0)
        if track:
            self.n += 1
            self.brier.append((p - y) ** 2)
            self.hits.append(int((p >= 0.5) == (y >= 0.5)))
        return p

    def state(self) -> dict[str, Any]:
        return {"w": {k: round(v, 5) for k, v in self.w.items()}, "b": round(self.b, 5), "n": self.n}

    def restore(self, s: dict[str, Any] | None) -> None:
        s = s or {}
        self.w = {k: float((s.get("w") or {}).get(k, v)) for k, v in self.priors.items()}
        self.b = float(s.get("b", self.b0))
        self.n = int(s.get("n", 0))

    def stats(self) -> dict[str, Any]:
        return {"trained": self.n, "brier": round(sum(self.brier) / len(self.brier), 3) if self.brier else None,
                "accuracy": round(sum(self.hits) / len(self.hits) * 100, 1) if len(self.hits) >= 20 else None}


class Brain:
    def __init__(self, ap: Any) -> None:
        self.ap = ap
        self.win = Logit(PRIORS, BIAS0)
        self.rug = Logit(RUG_PRIORS, RUG_BIAS0)
        self.aggression = "hyper"
        self.narr: dict[str, dict[str, Any]] = {}        # mint -> strongest live narrative it's matched to (social engine)
        self.x_calls: dict[str, int] = {}                # mint -> calls by tracked X accounts (last 2h)
        self.last_ctx = 0.0
        self.trained = 0                                 # real (closed) trades learned from
        self.shadow_trained = 0
        self.shadow_hits = 0
        self.rug_seen = 0
        self.log: deque[dict[str, Any]] = deque(maxlen=300)
        self.candidates: list[dict[str, Any]] = []
        self.vals: dict[str, tuple[float, float]] = {}      # mint -> (ts, latest value): the market the bar is a percentile of
        self.cache: dict[str, tuple[int, float, float, dict[str, float], float, float]] = {}  # mint -> (id(r), copy_n, ts, f, value, p_rug)
        self.charts: dict[str, dict[str, float]] = {}        # mint -> latest raw chart read (exits use it)
        self.shadow: dict[str, dict[str, Any]] = {}
        self.sampled: dict[str, tuple[int, float]] = {}      # mint -> (snapshots taken, last ts)
        self.copy_buys: dict[str, dict[str, Any]] = {}         # mint -> {wallets: {w: (rank, ts)}, ...}
        self.smart_sells: dict[str, dict[str, tuple[int, float]]] = {}   # mint -> {wallet: (rank, ts)}: top wallets getting out
        self.smart_follow = 1.0                                         # how hard it follows their sells (learned)
        self.patience = 1.0                                             # how long it lets a flat position breathe (learned)
        self.copied_sells = 0
        self.threshold = 50.0
        self.last_publish = self.last_skip_note = self.last_equity = self.last_buy_ts = self.last_rehearse = 0.0
        self.real_balance: tuple[float, float] = (0.0, 0.0)  # (ts, SOL)
        self.diag: dict[str, Any] = {}
        self.rng = random.Random()
        # experience replay
        self.replay: deque[tuple[array, float, float, float]] = deque(maxlen=4000)
        self.pending: list[tuple] = []
        self.rehearsed = 0
        self.label_ts: deque[float] = deque(maxlen=5000)
        # discouragement / confidence
        self.mood = 1.0
        self.streak = 0                                   # +wins / −losses in a row
        self.cool_until = 0.0
        self.peak_equity = 10.0
        self.drawdown = 0.0
        self.last_mood_ts = time.time()
        # pattern memory
        self.tags: dict[str, list[float]] = {}           # tag -> [n, wins, pnl]  (exponentially decayed)
        self.base = [0.0, 0.0, 0.0]
        self.told: dict[str, float] = {}                 # tag -> when it last told you about it
        self.leaders: dict[str, dict[str, float]] = {}   # copied wallet -> {n, w, pnl, bench_until}
        self.bad_devs: dict[str, float] = {}             # deployer -> ts it got burnt
        # adaptive exits
        self.stop_mult = 1.0
        self.trail_mult = 1.0
        self.post: dict[str, dict[str, Any]] = {}        # mint -> post-mortem watch after a stop / trailing exit
        self.exit_stats = {"shaken": 0, "stop_right": 0, "sold_early": 0, "trail_right": 0, "early_right": 0, "too_early": 0,
                           "smart_right": 0, "smart_wrong": 0}
        self.recent_exits: deque[str] = deque(maxlen=12)

    # ---------------- compat ----------------
    @property
    def w(self) -> dict[str, float]:
        return self.win.w

    @property
    def b(self) -> float:
        return self.win.b

    # ---------------- state ----------------
    async def load(self) -> None:
        s = await self.ap.cfg.kv_get("brain:state") or {}
        ver = int(s.get("version", 0))
        if ver >= 4:
            self.win.restore(s.get("win"))
            self.rug.restore(s.get("rug"))
        else:                                             # v1-v3 kept one weight set: it becomes the win model
            self.win.restore({"w": s.get("w") or {}, "b": s.get("b", BIAS0), "n": s.get("trained", 0)})
        self.trained = int(s.get("trained", 0))
        self.shadow_trained = int(s.get("shadow_trained", 0))
        self.shadow_hits = int(s.get("shadow_hits", 0))
        self.rug_seen = int(s.get("rug_seen", 0))
        self.aggression = s.get("aggression") if s.get("aggression") in AGGRESSION else "hyper"
        if ver < 3:
            self.aggression = "hyper"                   # v3: high risk appetite on demo money by default
        self.mood = float(s.get("mood", 1.0))
        self.streak = int(s.get("streak", 0))
        self.peak_equity = float(s.get("peak_equity", 10.0))
        self.tags = {k: list(v) for k, v in (s.get("tags") or {}).items()}
        self.base = list(s.get("base") or [0.0, 0.0, 0.0])
        self.leaders = s.get("leaders") or {}
        self.bad_devs = s.get("bad_devs") or {}
        self.stop_mult = float(s.get("stop_mult", 1.0))
        self.trail_mult = float(s.get("trail_mult", 1.0))
        self.smart_follow = float(s.get("smart_follow", 1.0))
        self.patience = float(s.get("patience", 1.0))
        self.copied_sells = int(s.get("copied_sells", 0))
        self.exit_stats.update(s.get("exit_stats") or {})
        self.rehearsed = int(s.get("rehearsed", 0))
        try:
            rows = await self.ap.db.all("SELECT vec, y, rug, w FROM brain_examples WHERE ver=? ORDER BY id DESC LIMIT 4000", (KEYS_VER,))
            for r in reversed(rows):
                v = array("f")
                v.frombytes(r["vec"])
                self.replay.append((v, float(r["y"]), float(r["rug"]), float(r["w"] or 1)))
        except Exception:  # noqa: BLE001 - fresh database
            pass

    async def save(self) -> None:
        now = time.time()
        if len(self.bad_devs) > 1500:
            self.bad_devs = dict(sorted(self.bad_devs.items(), key=lambda kv: -kv[1])[:1000])
        if len(self.leaders) > 400:
            self.leaders = dict(sorted(self.leaders.items(), key=lambda kv: -kv[1].get("n", 0))[:300])
        await self.ap.cfg.kv_set("brain:state", {
            "version": 5, "win": self.win.state(), "rug": self.rug.state(), "trained": self.trained,
            "shadow_trained": self.shadow_trained, "shadow_hits": self.shadow_hits, "rug_seen": self.rug_seen,
            "aggression": self.aggression, "mood": round(self.mood, 4), "streak": self.streak, "peak_equity": self.peak_equity,
            "tags": {k: [round(x, 4) for x in v] for k, v in self.tags.items()}, "base": [round(x, 4) for x in self.base],
            "leaders": self.leaders, "bad_devs": self.bad_devs, "stop_mult": round(self.stop_mult, 4), "trail_mult": round(self.trail_mult, 4),
            "smart_follow": round(self.smart_follow, 4), "patience": round(self.patience, 4), "copied_sells": self.copied_sells,
            "exit_stats": self.exit_stats, "rehearsed": self.rehearsed, "saved": now})
        await self.flush_examples()

    async def flush_examples(self) -> None:
        if not self.pending:
            return
        rows, self.pending = self.pending, []
        try:
            await self.ap.db.many("INSERT INTO brain_examples (ts, ver, vec, y, rug, src, w) VALUES (?,?,?,?,?,?,?)", rows)
            if self.rng.random() < 0.1:
                await self.ap.db.exec("DELETE FROM brain_examples WHERE id <= (SELECT MAX(id) - 20000 FROM brain_examples)")
        except Exception:  # noqa: BLE001
            pass

    async def set_aggression(self, level: str) -> None:
        if level in AGGRESSION:
            self.aggression = level
            await self.save()
            await self.note("mode", f"🎚 Aggression → {level}: buys the top {AGGRESSION[level]['top'] * 100:.0f}% of what it sees, "
                                    f"up to {AGGRESSION[level]['max_open']} positions, stop −{AGGRESSION[level]['stop'] * 100:.0f}%.")

    async def reset(self) -> None:
        self.win, self.rug = Logit(PRIORS, BIAS0), Logit(RUG_PRIORS, RUG_BIAS0)
        self.trained = self.shadow_trained = self.shadow_hits = self.rug_seen = self.rehearsed = 0
        self.mood, self.streak, self.cool_until, self.peak_equity, self.drawdown = 1.0, 0, 0.0, 10.0, 0.0
        self.tags, self.base, self.told, self.leaders, self.bad_devs = {}, [0.0, 0.0, 0.0], {}, {}, {}
        self.stop_mult = self.trail_mult = 1.0
        self.smart_follow = self.patience = 1.0
        self.copied_sells = 0
        self.exit_stats = {k: 0 for k in self.exit_stats}
        for c in (self.log, self.shadow, self.sampled, self.cache, self.replay, self.post, self.recent_exits):
            c.clear()
        self.pending = []
        await self.ap.db.exec("DELETE FROM brain_examples")
        await self.save()
        await self.ap.reset_demo("auto")
        await self.ap.db.exec("DELETE FROM auto_equity WHERE mode='auto'")
        await self.note("reset", "🧠 Fresh start: both models back to their priors, no pattern memory, 10 SOL of demo money.")

    # ---------------- scoring ----------------
    def tag_adj(self, tags: list[str]) -> tuple[float, list[str]]:
        """Pattern memory in log-odds: patterns that keep losing it money pull a coin down, ones that work lift it."""
        bn, bw = self.base[0], self.base[1]
        if bn < 8:
            return 0.0, []
        wr_b = (bw + 1) / (bn + 2)
        adj, worst = 0.0, []
        for t in tags:
            s = self.tags.get(t)
            if not s or s[0] < 4:
                continue
            wr = (s[1] + 1) / (s[0] + 2)
            d = _clip(_logit(wr) - _logit(wr_b), -1.5, 1.0) * min(1.0, s[0] / 20) * 0.5
            adj += d
            if d <= -0.1:
                worst.append(t)
        return _clip(adj, -2.5, 1.5), worst

    def value(self, f: dict[str, float], trigger: str = "brain") -> float:
        return self.read(f, trigger)[0]

    def read(self, f: dict[str, float], trigger: str = "brain") -> tuple[float, float, float, list[str]]:
        adj, worst = self.tag_adj(pat.tags(f, trigger))
        p_win = _sig(self.win.z(f) + adj)
        p_rug = self.rug.p(f)
        return round(100 * p_win * (1 - 0.6 * p_rug), 1), p_win, p_rug, worst

    def why(self, f: dict[str, float], n: int = 3) -> str:
        contrib = sorted(((self.win.w[k] * f.get(k, 0.0), k) for k in self.win.w), reverse=True)
        pos = [LABELS[k].lower() for c, k in contrib[:n] if c > 0.15]
        neg = [LABELS[k].lower() for c, k in contrib[::-1][:2] if c < -0.15]
        return ("+ " + ", ".join(pos) if pos else "") + (" · − " + ", ".join(neg) if neg else "")

    def rug_why(self, f: dict[str, float]) -> str:
        contrib = sorted(((self.rug.w[k] * f.get(k, 0.0), k) for k in self.rug.w), reverse=True)
        return ", ".join(LABELS[k].lower() for c, k in contrib[:3] if c > 0.2)

    async def note(self, kind: str, text: str, **extra: Any) -> None:
        from .hub import hub
        ev = {"ts": time.time(), "kind": kind, "text": text, **extra}
        self.log.appendleft(ev)
        await hub.publish("brain", {"event": ev})

    # ---------------- copy-trading input (every trade by a ranked / smart / followed wallet) ----------------
    def wallet_rank(self, w: str) -> int | None:
        tr, sm = self.ap.traders, self.ap.smart
        r = tr.ranked.get(w) if tr else None
        if r and r.get("rank"):
            return int(r["rank"])
        if (tr and w in tr.followed) or (sm and w in getattr(sm, "tracked", {})):
            return 50
        return None

    def benched(self, w: str) -> bool:
        return (self.leaders.get(w) or {}).get("bench_until", 0) > time.time()

    async def on_trade(self, t: dict[str, Any]) -> None:
        w, mint, side = t.get("trader"), t.get("mint"), t.get("side")
        if not w or not mint or side not in ("buy", "sell"):
            return
        rank = self.wallet_rank(w)
        if rank is None:
            return
        now = time.time()
        if side == "buy":
            if self.benched(w):
                return
            e = self.copy_buys.setdefault(mint, {"wallets": {}, "first": now})
            e["wallets"][w] = (rank, now)
            self.ap.kick.set()
            if len(self.copy_buys) > 3000:
                cut = now - 3600
                self.copy_buys = {m: v for m, v in self.copy_buys.items() if v["first"] > cut}
        else:
            await self.on_smart_sell(w, rank, mint, float(t.get("sol") or 0), now)

    def managed(self, p: dict[str, Any]) -> bool:
        return p["mode"] == "auto" or p.get("trigger") in ("brain", "copy")

    async def on_smart_sell(self, w: str, rank: int, mint: str, sol: float, now: float) -> None:
        """A top trader selling is information: a leader we copied → we follow them out; any top wallet dumping a coin
        we hold → we sell some (more if several are getting out, or the seller is top-20). It also scares off new buys."""
        s = self.smart_sells.setdefault(mint, {})
        s[w] = (rank, now)
        if len(self.smart_sells) > 3000:
            self.smart_sells = {m: v for m, v in self.smart_sells.items() if max(ts for _, ts in v.values()) > now - 3600}
        for p in list(self.ap.open.values()):
            if p["mint"] != mint or p["mint"] in self.ap.busy or not self.managed(p) or p["tokens_left"] <= 0:
                continue
            if w in (p.get("leaders") or []):                         # a wallet we copied is getting out → so do we
                p["leaders"] = [x for x in p["leaders"] if x != w]
                frac = 1.0 if not p["leaders"] else 0.5
                p["_exit_kind"] = "smart"
                await self.ap.sell(p, frac, f"leader {w[:4]}… sold")
                self.copied_sells += 1
                await self.note("sell", f"🪞 Copied a sell: the #{rank} wallet I followed into ${p['symbol']} sold → sold {frac * 100:.0f}%", mint=mint)
                continue
            if sol < SMART_SELL_SOL:
                continue
            recent = {x: r for x, (r, ts) in s.items() if ts > now - 300}
            several = len(recent) >= 2
            full = several and min(recent.values()) <= 50                  # several top wallets out: everything, right now
            if (not several and rank > 100) or (not full and now - p.get("_smart_ts", 0) < 15):
                continue
            frac = 1.0 if full else _clip((0.6 if rank <= 20 else 0.35) * self.smart_follow, 0.2, 1.0)
            p["_smart_ts"] = now
            p["_exit_kind"] = "smart"
            await self.ap.sell(p, frac, f"top wallet #{rank} sold" + (f" ({len(recent)} top wallets out)" if several else ""))
            self.copied_sells += 1
            await self.note("sell", f"🧠 Copied a top trader's sell: #{rank} sold ${p['symbol']}"
                                    f"{f' ({len(recent)} top wallets out in 5 min)' if several else ''} → sold {frac * 100:.0f}%", mint=mint)

    def smart_selling(self, mint: str) -> int:
        s = self.smart_sells.get(mint)
        if not s:
            return 0
        cut = time.time() - 600
        return sum(1 for r, ts in s.values() if ts >= cut)

    def copy_signal(self, mint: str) -> tuple[float, list[str], str]:
        e = self.copy_buys.get(mint)
        if not e:
            return 0.0, [], ""
        cut = time.time() - 600
        live = {w: r for w, (r, ts) in e["wallets"].items() if ts >= cut and not self.benched(w)}
        if not live:
            return 0.0, [], ""
        n = sum(1.5 if r <= 20 else 1.0 if r <= 100 else 0.5 for r in live.values())
        ranks = sorted(live.values())
        return n, list(live), ", ".join(f"#{r}" for r in ranks[:4])

    def influx(self, mint: str) -> tuple[bool, int, str]:
        """It doesn't copy any one wallet: it copies an INFLUX — several top wallets piling into the same coin within
        minutes (3+ ranked wallets in 5 min, or 2 top-10s within 2 min), and nobody top-ranked selling it."""
        e = self.copy_buys.get(mint)
        if not e:
            return False, 0, ""
        now = time.time()
        live = {w: (r, ts) for w, (r, ts) in e["wallets"].items() if ts >= now - 300 and not self.benched(w)}
        k = len(live)
        if not k:
            return False, 0, ""
        weight = sum(1.5 if r <= 20 else 1.0 if r <= 100 else 0.5 for r, _ in live.values())
        fast_top = [r for r, ts in live.values() if r <= 10 and ts >= now - 120]
        ok = ((k >= 3 and weight >= 3.0) or len(fast_top) >= 2) and not self.smart_selling(mint)
        return ok, k, f"{k} top wallets in 5 min ({', '.join(f'#{r}' for r, _ in sorted(live.values())[:4])})"

    # ---------------- narrative context (refreshed every 15 s, off the per-coin path) ----------------
    async def refresh_context(self, now: float) -> None:
        if now - self.last_ctx < 15:
            return
        self.last_ctx = now
        db = self.ap.db
        try:
            rows = await db.all("SELECT nt.token_address mint, n.strength, n.stage, n.zscore z, n.bot_share FROM narrative_tokens nt "
                                "JOIN narratives n ON n.id=nt.narrative_id WHERE n.last_seen > ? AND COALESCE(nt.is_likely_fake,0)=0 "
                                "AND nt.match_score >= 0.6", (now - 6 * 3600,))
            narr: dict[str, dict[str, Any]] = {}
            for r in rows:
                if r["mint"] not in narr or (r["strength"] or 0) > (narr[r["mint"]].get("strength") or 0):
                    narr[r["mint"]] = r
            self.narr = narr
            self.x_calls = {r["mint"]: r["n"] for r in await db.all("SELECT mint, COUNT(DISTINCT handle) n FROM x_calls WHERE ts > ? GROUP BY mint",
                                                                   (now - 7200,))}
            self.cache.clear()
        except Exception:  # noqa: BLE001 - tables from optional engines may be empty / missing on a fresh install
            pass

    def _score(self, L: Any, now: float, cn: float) -> tuple[dict[str, float], float, float, float, list[str]]:
        r = L.result
        age = now - L.created
        try:
            raw = pat.chart(L, now)
            self.charts[L.mint] = raw
            ch = pat.normalise(raw, age, r.get("mcap_usd"))
        except Exception:  # noqa: BLE001 - a launch object without a tape (graduated, restored) just skips the chart read
            ch = None
        e = self.copy_buys.get(L.mint)
        infl = sum(1 for _, ts in e["wallets"].values() if ts >= now - 300) if e else 0
        f = features({**r, "age_s": age}, cn, {"narr": self.narr.get(L.mint), "x_calls": self.x_calls.get(L.mint, 0), "chart": ch,
                                               "influx": infl, "smart_sells": self.smart_selling(L.mint)})
        v, p_win, p_rug, worst = self.read(f)
        return f, v, p_win, p_rug, worst

    # ---------------- mood: discouraged by losses, confident after wins ----------------
    def mood_factor(self) -> float:
        m = min(self.mood, 1.0 - 0.8 * max(0.0, self.drawdown - 0.15)) if self.drawdown > 0.15 else self.mood
        return _clip(m, 0.35, 1.25)

    def mood_word(self) -> str:
        m = self.mood_factor()
        if time.time() < self.cool_until:
            return "cooling off"
        return "on fire" if m >= 1.15 else "confident" if m >= 0.95 else "cautious" if m >= 0.75 else "discouraged" if m >= 0.5 else "shaken"

    def heal(self, now: float) -> None:
        dt = now - self.last_mood_ts
        self.last_mood_ts = now
        if dt > 0:                                        # time heals: ~2% of the gap back to neutral per minute
            self.mood += (1.0 - self.mood) * min(1.0, 0.02 * dt / 60)

    # ---------------- main step ----------------
    async def tick(self, mode: str = "auto") -> None:
        ap = self.ap
        now = time.time()
        self.heal(now)
        await self.refresh_context(now)
        agg = AGGRESSION[self.aggression]
        launches = ap.sniper.launches
        holding = {p["mint"] for p in ap.open.values()}
        budget = 60                                                   # fresh re-reads per tick: the event loop never stalls
        scored = []
        allL = list(launches.values())
        self.rot = (getattr(self, "rot", 0) + 37) % max(1, len(allL))            # rotate the start so nobody starves on busy ticks
        for L in allL[self.rot:] + allL[:self.rot]:
            r = L.result
            if not r or (now - L.created > 1200 and L.mint not in holding):
                continue
            cn, leaders, ranks = self.copy_signal(L.mint)
            hit = self.cache.get(L.mint)
            if hit and ((hit[0] == id(r) and hit[1] == cn and now - hit[2] < 10) or budget <= 0):   # unchanged: reuse
                f, v, p_rug = hit[3], hit[4], hit[5]
            else:
                budget -= 1
                f, v, _, p_rug, _ = self._score(L, now, cn)
                self.cache[L.mint] = (id(r), cn, now, f, v, p_rug)
                raw = self.charts.get(L.mint)
                if raw and L.mint in self.sampled and pat.rug_alarm(raw):
                    for key in (L.mint, *(f"{L.mint}#{k}" for k in range(1, 4))):
                        if key in self.shadow:
                            self.shadow[key]["alarm"] = True
            if now - L.created > 1200:
                continue
            self.vals[L.mint] = (now, v)
            scored.append({"mint": L.mint, "symbol": r.get("symbol"), "value": v, "p_rug": round(p_rug * 100), "hard": self.hard_no(r),
                           "why": self.why(f), "f": f, "mcap_usd": r.get("mcap_usd"), "age_s": round(now - L.created), "tier": r.get("tier"),
                           "deployer": L.deployer, "leaders": leaders, "copy_ranks": ranks, "mcap_sol": L.mcap_sol, "r": r})
            self.sample(L, f, v, now)
        await self.shadow_step(now)
        for mint, lesson in self.post_mortem(now):
            await self.note("learn", lesson, mint=mint)
        if now - self.last_rehearse > 20:
            self.last_rehearse = now
            self.rehearse(48)
        if len(self.vals) > len(launches) + 500:
            self.vals = {m: tv for m, tv in self.vals.items() if tv[0] > now - 1200}
            self.cache = {m: c for m, c in self.cache.items() if m in launches}
            self.charts = {m: c for m, c in self.charts.items() if m in launches}
        mf = self.mood_factor()
        vals = [v for ts, v in self.vals.values() if ts > now - 1200]
        top = agg["top"] * mf                                                # discouraged → only the very best slice
        self.threshold = round(max(agg["floor"] * (2 - min(1.0, mf)), percentile(vals, 1 - top)), 1)
        scored.sort(key=lambda c: -c["value"])
        self.candidates = scored[:14]
        self.diag = {"launches": len(launches), "scored": len(scored), "copy_watch": len(self.copy_buys), "shadow_pending": len(self.shadow),
                     "influx": sum(1 for m in list(self.copy_buys)[-200:] if self.influx(m)[0]),
                     "smart_selling": sum(1 for v in self.smart_sells.values() if max(ts for _, ts in v.values()) > now - 600),
                     "mood": round(mf, 2), "top_pct": round(top * 100, 1)}
        if now - self.last_publish > 2:
            self.last_publish = now
            from .hub import hub
            await hub.publish("brain", {"candidates": self.public_candidates(), "threshold": self.threshold, "diag": self.diag,
                                        "mood": self.mood_public()})
        if now - self.last_buy_ts < agg["cooldown"]:
            return
        mine = [p for p in ap.open.values() if p["mode"] == mode]
        max_open = agg["max_open"] if mode == "auto" else min(agg["max_open"], ap.c["size"]["max_open"])
        max_open = max(2, round(max_open * min(1.0, mf)))
        if len(mine) >= max_open:
            return
        bal = await self.balance(mode)
        if bal < 0.06:
            if now - self.last_skip_note > 600:
                self.last_skip_note = now
                await self.note("skip", "💸 Out of money — reset the brain (demo) or top up the trading wallet (real).")
            return
        if mode == "real" and await ap.can_buy():
            return
        if not scored and not self.copy_buys:
            if now - self.last_skip_note > 120:
                self.last_skip_note = now
                await self.note("skip", f"📡 No live launches reaching Radar right now ({len(launches)} tracked) — check PumpPortal on the Health page.")
            return
        cooling = now < self.cool_until
        devs = {(launches[p["mint"]].deployer if p["mint"] in launches else None) for p in mine}
        room = min(agg["burst"], max_open - len(mine))
        copies_open = sum(1 for p in mine if p.get("trigger") == "copy")
        copy_cap = max(1, int(max_open * 0.35))                            # copying never takes over: its own picks come first
        bought = 0
        # 1) influx copy-trades (time-critical): several top wallets piling into one coin, not any single wallet
        for mint, e in list(self.copy_buys.items()):
            if bought >= room or copies_open >= copy_cap:
                break
            if mint in ap.entered or mint in ap.busy:
                continue
            ok, k, desc = self.influx(mint)
            if not ok or (cooling and k < 4):
                continue
            n, leaders, ranks = self.copy_signal(mint)
            L = launches.get(mint)
            f, v = None, None
            if L is not None and L.result:
                if self.hard_no(L.result) or self.veto(L, now):
                    continue
                f, v, _, p_rug, _ = self._score(L, now, n)
                if v < self.threshold * 0.5 or self.veto(L, now, p_rug):          # its own read still has to agree
                    continue
            elif k < 4 or not await self._tradeable(mint):
                continue
            size = self.size(bal, 0.8, mode, copy=True)
            await self._buy(mint, size, mode, "copy", f"influx: {desc}", L.result if L else None, f, v, leaders)
            bought += 1
            copies_open += 1
            bal = await self.balance(mode)
        if cooling or bought >= room:
            return
        # 2) its own picks: the best coins it can see above its (percentile) bar — several per tick when it's hot
        for c in scored:
            if bought >= room or bal < 0.06:
                break
            if c["mint"] in ap.entered or c["mint"] in ap.busy or c["hard"]:
                continue
            if c["deployer"] and (c["deployer"] in devs or c["deployer"] in self.bad_devs):
                continue
            L = launches.get(c["mint"])
            veto = self.veto(L, now, c["p_rug"] / 100) if L is not None else None
            if veto or self.smart_selling(c["mint"]) >= 2:
                continue
            explore = False
            if c["value"] < self.threshold:
                if not bought and c["value"] >= self.threshold - 6 and self.rng.random() < 0.12 * mf:
                    explore = True
                else:
                    if not bought and now - self.last_skip_note > 25:
                        self.last_skip_note = now
                        await self.note("skip", f"👀 Best right now: ${c['symbol']} at {c['value']:.0f} — bar is {self.threshold:.0f} "
                                                f"(top {top * 100:.0f}% of {len(vals)} recent reads, mood {self.mood_word()}). Waiting.",
                                        mint=c["mint"], value=c["value"])
                    break
            conv = max(0.0, min(1.0, (c["value"] - self.threshold) / max(5.0, 100 - self.threshold)))
            size = self.size(bal, 0.3 if explore else conv, mode, explore=explore)
            detail = (f"value {c['value']:.0f} (bar {self.threshold:.0f}) · rug {c['p_rug']}%{' · explore' if explore else ''} · {c['why']}")
            await self._buy(c["mint"], size, mode, "explore" if explore else "brain", detail, c["r"], c["f"], c["value"], c["leaders"])
            devs.add(c["deployer"])
            bought += 1
            if explore:
                break
            bal = await self.balance(mode)

    def veto(self, L: Any, now: float, p_rug: float | None = None) -> str | None:
        """Rug tells on the chart, a burnt dev, or the rug model being sure — any of these and it won't touch the coin."""
        if L.deployer and L.deployer in self.bad_devs:
            return "dev burnt it before"
        raw = self.charts.get(L.mint)
        a = pat.rug_alarm(raw) if raw else None
        if a:
            return a
        if p_rug is not None:
            lim = AGGRESSION[self.aggression]["rug_veto"] if self.rug.n >= 150 else max(0.8, AGGRESSION[self.aggression]["rug_veto"])
            if p_rug >= lim:
                return f"rug model {p_rug * 100:.0f}%"
        return None

    async def _tradeable(self, mint: str) -> bool:
        tok = await self.ap.tracker.token_summary(mint)
        return bool(tok and tok.get("price_usd") and (tok.get("liquidity_usd") or 0) >= 10_000)

    async def _buy(self, mint: str, size: float, mode: str, trig: str, detail: str, r: dict[str, Any] | None,
                   f: dict[str, float] | None, value: float | None, leaders: list[str]) -> None:
        ap = self.ap
        try:
            p = await ap.buy(mint, "copy" if trig == "copy" else "brain", detail, r, sol=size, mode=mode)
        except Exception as e:  # noqa: BLE001
            ap.entered[mint] = time.time()            # don't retry the same failing coin every tick
            await self.note("error", f"⚠️ Couldn't buy {(r or {}).get('symbol') or mint[:6]}: {e}", mint=mint)
            return
        p["leaders"] = list(leaders or [])
        p["features"], p["score"] = f, value
        meta = {"f": f, "leaders0": p["leaders"], "trig": trig, "v": value}
        p["entry_value"] = value
        await ap.db.exec("UPDATE auto_positions SET features_json=?, score=?, leaders_json=? WHERE id=?",
                         (json.dumps(meta) if f else None, value, json.dumps(p["leaders"]), p["id"]))
        p["leaders0"], p["brain_trig"] = list(p["leaders"]), trig
        self.last_buy_ts = time.time()
        icon = "🪞" if trig == "copy" else "🧪" if trig == "explore" else "🟢"
        await self.note("buy", f"{icon} {'REAL ' if mode == 'real' else ''}Bought ${p['symbol']} for ◎{p['sol_in']:.3f} — {detail}",
                        mint=mint, value=value, sol=p["sol_in"])

    async def balance(self, mode: str) -> float:
        if mode != "real":
            return await self.ap.demo_balance("auto")
        ts, bal = self.real_balance
        if time.time() - ts > 20:
            pub = await self.ap.wallet.pubkey() if self.ap.wallet else None
            try:
                bal = await self.ap.wallet.chain.sol_balance(pub) if pub else 0.0
            except Exception:  # noqa: BLE001
                bal = bal or 0.0
            self.real_balance = (time.time(), bal)
        return bal

    def size(self, bal: float, conviction: float, mode: str, explore: bool = False, copy: bool = False) -> float:
        """Half-Kelly from its real record once it has one; conviction-scaled base size before that; shrunk when discouraged."""
        agg = AGGRESSION[self.aggression]
        st = self.stats_cache
        frac = agg["base"]
        if st and st["n"] >= 10 and st["avg_loss"] > 0:
            wr, ratio = st["wr"], st["avg_win"] / st["avg_loss"]
            kelly = wr - (1 - wr) / max(0.1, ratio)
            frac = max(0.01, min(0.08, kelly / 2))
        frac *= (0.5 if explore else 0.6 + 0.9 * conviction) * (1.1 if copy else 1.0)
        frac *= 0.5 + 0.5 * min(1.2, self.mood_factor())
        s = max(0.02, bal * frac)
        if mode == "real":
            s = min(s, self.ap.c["size"]["buy_sol"], self.ap.c["size"]["max_buy_sol_hard"])
        return round(min(s, bal * 0.25), 4)

    stats_cache: dict[str, Any] | None = None

    async def refresh_stats(self) -> None:
        rows = await self.ap.db.all("SELECT sol_in, sol_out FROM auto_positions WHERE mode='auto' AND status='closed' ORDER BY closed DESC LIMIT 60")
        wins = [r["sol_out"] / r["sol_in"] - 1 for r in rows if r["sol_in"] and r["sol_out"] > r["sol_in"]]
        losses = [1 - r["sol_out"] / r["sol_in"] for r in rows if r["sol_in"] and r["sol_out"] <= r["sol_in"]]
        n = len(wins) + len(losses)
        self.stats_cache = {"n": n, "wr": len(wins) / n if n else 0, "avg_win": sum(wins) / len(wins) if wins else 0,
                            "avg_loss": sum(losses) / len(losses) if losses else 0}

    @staticmethod
    def hard_no(r: dict[str, Any]) -> str | None:
        mx = r.get("metrics") or {}
        if r.get("tier") == "TRAP":
            return "TRAP"
        if r.get("bundled"):
            return "bundled"
        if (mx.get("insider_hold_pct") or 0) >= 15:
            return "insiders"
        if (r.get("mcap_usd") or 0) > 250_000:
            return "too big"
        if (r.get("buyers") or 0) < 5:
            return "too few buyers"
        if mx.get("dev_hold_pct") and mx["dev_hold_pct"] > 25 and not mx.get("dev_sold"):
            return "dev holds too much"
        return None

    # ---------------- learning plumbing ----------------
    def _vec(self, f: dict[str, float]) -> array:
        return array("f", (f.get(k, 0.0) for k in KEYS))

    def _remember(self, f: dict[str, float], y: float, rug: float, w: float, src: str) -> None:
        v = self._vec(f)
        self.replay.append((v, y, rug, w))
        self.pending.append((time.time(), KEYS_VER, v.tobytes(), y, rug, src, w))
        self.label_ts.append(time.time())

    def rehearse(self, n: int) -> None:
        """Background practice on remembered lessons: the models keep sharpening between trades."""
        if len(self.replay) < 50:
            return
        for _ in range(n):
            v, y, rug, w = self.replay[self.rng.randrange(len(self.replay))]
            f = dict(zip(KEYS, v))
            self.win.step(f, y, LR_REPLAY * w, track=False)
            self.rug.step(f, rug, LR_REPLAY * w, track=False)
        self.rehearsed += n
        self.cache.clear()

    def _tag_update(self, tags: list[str], y: float, pnl: float, weight: float) -> None:
        for t in tags:
            s = self.tags.setdefault(t, [0.0, 0.0, 0.0])
            s[0], s[1], s[2] = s[0] * 0.97 + weight, s[1] * 0.97 + weight * y, s[2] * 0.97 + weight * pnl
        b = self.base
        b[0], b[1], b[2] = b[0] * 0.985 + weight, b[1] * 0.985 + weight * y, b[2] * 0.985 + weight * pnl

    # ---------------- shadow learning: every coin it scored is a lesson ----------------
    def sample(self, L: Any, f: dict[str, float], v: float, now: float) -> None:
        k, last = self.sampled.get(L.mint, (0, 0.0))
        if k >= 4 or not L.mcap_sol or len(self.shadow) >= 2500 or (k and now - last < 180):
            return
        if v >= self.threshold * 0.6 or self.rng.random() < (0.15 if not k else 0.3):
            key = L.mint if not k else f"{L.mint}#{k}"
            self.sampled[L.mint] = (k + 1, now)
            stop = 1 - AGGRESSION[self.aggression]["stop"] * self.stop_mult
            self.shadow[key] = {"mint": L.mint, "ts": now, "vec": self._vec(f), "entry": L.mcap_sol, "peak": L.mcap_sol,
                                "low": L.mcap_sol, "v": v, "won": None, "stop": stop, "alarm": False}

    async def shadow_step(self, now: float) -> None:
        launches = self.ap.sniper.launches
        done = []
        learned = 0
        for key, s in self.shadow.items():
            L = launches.get(s.get("mint", key))
            if L is not None and L.mcap_sol:
                s["peak"] = max(s["peak"], L.mcap_sol)
                s["low"] = min(s["low"], L.mcap_sol)
                if s["won"] is None and s["entry"]:                     # resolve the moment the answer is known
                    if L.mcap_sol >= s["entry"] * WIN_X:
                        s["won"] = 1.0
                    elif L.mcap_sol <= s["entry"] * s["stop"]:
                        s["won"] = 0.0
                    if s["won"] is not None:
                        self._learn_win(s)
                        learned += 1
            if now - s["ts"] >= 1200 or L is None:
                done.append(key)
        for key in done:
            s = self.shadow.pop(key)
            if not s["entry"]:
                continue
            if s["won"] is None:
                s["won"] = 1.0 if s["peak"] / s["entry"] >= WIN_X else 0.0
                self._learn_win(s)
                learned += 1
            f = dict(zip(KEYS, s["vec"]))
            rug = 1.0 if (s["low"] / s["entry"] <= RUG_X or s["alarm"]) else 0.0
            self.rug.step(f, rug, LR_SHADOW * (1.5 if rug else 1.0))
            self.rug_seen += int(rug)
            self._remember(f, s["won"], rug, 1.0, "shadow")
            self._tag_update(pat.tags(f, "brain"), s["won"], (s["peak"] / s["entry"] - 1) if s["won"] else -0.4, 0.2)
        if learned and self.shadow_trained % 25 < learned:
            self.cache.clear()                                           # the weights moved: re-score everything
        if done:
            if len(self.sampled) > 20000:
                live = {s.get("mint") for s in self.shadow.values()}
                self.sampled = {m: v for m, v in self.sampled.items() if m in live or m in launches}
            if self.shadow_trained % 50 < len(done) or len(self.pending) > 200:
                await self.save()

    def _learn_win(self, s: dict[str, Any]) -> None:
        self.win.step(dict(zip(KEYS, s["vec"])), s["won"], LR_SHADOW)
        self.shadow_trained += 1
        self.shadow_hits += int(s["won"])

    # ---------------- its own exits ----------------
    def stop_pct(self) -> float:
        return _clip(AGGRESSION[self.aggression]["stop"] * self.stop_mult, 0.15, 0.6)

    def exit_for(self, p: dict[str, Any], r: dict[str, Any] | None, x: float, peak_x: float) -> tuple[float, str] | None:
        """One decision per tick, so as a coin moves you see it scale out, cut, and recycle the money into the next trade."""
        agg = AGGRESSION[self.aggression]
        now = time.time()
        age = now - p["opened"]
        mx = (r or {}).get("metrics") or {}
        if r and (r.get("tier") == "TRAP" or (mx.get("insider_hold_pct") or 0) >= 20):
            return self._exit(p, 1.0, "rug exit: " + ", ".join(r.get("flags") or ["insiders"]), "rug")
        raw = self.charts.get(p["mint"])
        alarm = pat.rug_alarm(raw) if raw else None
        if alarm:
            return self._exit(p, 1.0, f"rug pattern: {alarm}", "rug")
        hit = self.cache.get(p["mint"])
        if hit and self.rug.n >= 300 and hit[5] >= 0.85 and x < 2:
            return self._exit(p, 1.0, f"rug model {hit[5] * 100:.0f}% — getting out", "rug")
        stop = self.stop_pct()
        if x <= 1 - stop:
            return self._exit(p, 1.0, f"stop −{stop * 100:.0f}%", "stop")
        # scale out as it climbs: partial sells at each rung (the rest rides with a trailing stop)
        ladder = LADDERS[agg["ladder"]]
        for mult, frac, mark in ladder:
            if x >= mult and mark not in p["tp_done"]:
                p["tp_done"].append(mark)
                return frac, f"took {frac * 100:.0f}% at {mult:g}×"
        first = ladder[0][0]
        if peak_x >= first and x <= 1.02:
            return self._exit(p, 1.0, f"back to entry after {peak_x:.2f}× — protecting the trade", "trail")
        if peak_x >= first:
            trail = _clip((0.30 if peak_x < 2 else 0.25 if peak_x < 5 else 0.18) * self.trail_mult, 0.08, 0.5)
            if x <= peak_x * (1 - trail):
                return self._exit(p, 1.0, f"trailing stop ({peak_x:.1f}× peak, {trail * 100:.0f}% trail)", "trail")
        # momentum fading while in profit: take half off the table (once every 30 s at most)
        if raw and x >= 1.08 and raw.get("drop_60", 0) >= 0.15 and raw.get("net_30s", 0) < 0 and now - p.get("_mom_ts", 0) > 30:
            p["_mom_ts"] = now
            return 0.5, f"momentum fading (−{raw['drop_60'] * 100:.0f}% in 60s, sellers in control)"
        if (mx.get("sells_1m") or 0) >= 6 and (mx.get("sells_1m") or 0) > 2 * (mx.get("buys_1m") or 0) and x < peak_x * 0.85:
            return self._exit(p, 1.0, "sellers took over", "early")
        # the reason it bought is gone: its own read of the coin collapsed and it isn't up
        ev = p.get("entry_value")
        if hit and ev and age > 60 and x < 1.1 and hit[4] < max(4.0, ev * 0.4):
            return self._exit(p, 1.0, f"thesis broken (value {ev:.0f} → {hit[4]:.0f})", "early")
        if self.smart_selling(p["mint"]) >= 2 and x < 1.3:
            return self._exit(p, 1.0, "top wallets are leaving", "smart")
        L = self.ap.sniper.launches.get(p["mint"])
        tape = getattr(L, "trades", None) if L is not None else None
        if tape and age > 90 and x < 1.2 and now - tape[-1][0] > 120 * self.patience:
            return self._exit(p, 1.0, f"volume dried up (no trades for {now - tape[-1][0]:.0f}s)", "early")
        stall = agg["stall_s"] * self.patience
        last_high = p.setdefault("_high_ts", p["opened"])
        if x > p.get("_best_x", 1.0) * 1.02:                               # a real new high (+2%), not just sitting flat
            p["_best_x"], p["_high_ts"] = x, now
        elif now - last_high > stall and x < 1.15 and age > stall:
            return self._exit(p, 1.0, f"stalled (no new high in {stall / 60:.0f} min)", "early")
        tmax = agg["time_s"] * self.patience
        if age > tmax and x < 1.3:
            return self._exit(p, 1.0, f"{tmax / 60:.0f}-min time stop", "early")
        return None

    @staticmethod
    def _exit(p: dict[str, Any], frac: float, reason: str, kind: str) -> tuple[float, str]:
        p["_exit_kind"] = kind
        return frac, reason

    def post_mortem(self, now: float) -> list[tuple[str, str]]:
        """After a stop or trailing exit it keeps watching: were the stops right, or did it get shaken out?"""
        launches = self.ap.sniper.launches
        out = []
        for mint, w in list(self.post.items()):
            L = launches.get(mint)
            if L is not None and L.mcap_sol:
                w["max"], w["min"] = max(w["max"], L.mcap_sol), min(w["min"], L.mcap_sol)
            if now - w["ts"] < 900 and L is not None:
                continue
            self.post.pop(mint)
            ran, dumped = w["max"] >= w["exit"] * 1.5, w["min"] <= w["exit"] * 0.7
            if w["kind"] == "stop":
                if w["max"] >= w["entry"] * 1.3:
                    self.stop_mult = min(1.5, self.stop_mult * 1.06)
                    self.exit_stats["shaken"] += 1
                    w["lesson"] = (f"😤 Got shaken out of ${w['symbol']} — it ran to {w['max'] / w['entry']:.1f}× after my stop. "
                                   f"Giving stops more room (−{self.stop_pct() * 100:.0f}%).")
                elif dumped:
                    self.stop_mult = max(0.7, self.stop_mult * 0.98)
                    self.exit_stats["stop_right"] += 1
            elif w["kind"] == "trail":
                if ran:
                    self.trail_mult = min(1.5, self.trail_mult * 1.05)
                    self.exit_stats["sold_early"] += 1
                    w["lesson"] = f"🏃 Sold ${w['symbol']} too early — it went another {w['max'] / w['exit']:.1f}×. Loosening my trailing stop."
                elif dumped:
                    self.trail_mult = max(0.7, self.trail_mult * 0.98)
                    self.exit_stats["trail_right"] += 1
            elif w["kind"] == "early":                                # stalled / time / thesis / dried-up exits
                if ran:
                    self.patience = min(1.8, self.patience * 1.05)
                    self.exit_stats["too_early"] += 1
                    w["lesson"] = (f"⏳ Recycled ${w['symbol']} too soon — it went {w['max'] / w['exit']:.1f}× after. "
                                   f"Giving flat positions more time (×{self.patience:.2f}).")
                elif dumped or w["max"] <= w["exit"] * 1.1:
                    self.patience = max(0.6, self.patience * 0.98)
                    self.exit_stats["early_right"] += 1
            elif w["kind"] == "smart":                                # we copied a top trader's sell
                if dumped:
                    self.smart_follow = min(1.6, self.smart_follow * 1.04)
                    self.exit_stats["smart_right"] += 1
                    w["lesson"] = f"🎯 Copying the top wallets' sell on ${w['symbol']} was right — it fell {(1 - w['min'] / w['exit']) * 100:.0f}% after. Following their sells harder."
                elif ran:
                    self.smart_follow = max(0.5, self.smart_follow * 0.95)
                    self.exit_stats["smart_wrong"] += 1
                    w["lesson"] = f"🤔 ${w['symbol']} kept running after the top wallets sold — I'll follow their sells a little less."
            if w.get("lesson"):
                out.append((mint, w["lesson"]))
        return out

    # ---------------- learning from its own trades ----------------
    async def learn(self, p: dict[str, Any]) -> None:
        await self.refresh_stats()
        f = p.get("features")
        leaders0, trig = p.get("leaders0"), p.get("brain_trig") or p.get("trigger") or "brain"
        if not f:
            row = await self.ap.db.one("SELECT features_json, leaders_json FROM auto_positions WHERE id=?", (p["id"],))
            meta = json.loads((row or {}).get("features_json") or "null")
            if isinstance(meta, dict) and "f" in meta:
                f, leaders0, trig = meta["f"], meta.get("leaders0"), meta.get("trig") or trig
            else:
                f = meta
            if leaders0 is None:
                leaders0 = json.loads((row or {}).get("leaders_json") or "[]")
        mult = (p["sol_out"] / p["sol_in"]) if p["sol_in"] else 0
        reason = p.get("exit_reason") or ""
        y = 1.0 if mult >= 1.15 else 0.0
        rugged = 1.0 if (mult <= 0.45 or reason.startswith("rug")) else 0.0
        notes = []
        # --- mood ---
        r = _clip(mult - 1, -1.0, 1.5)
        if mult < 1:
            self.mood = max(0.35, self.mood - (0.06 + 0.12 * min(1.0, -r)) - (0.06 if rugged else 0))
            self.streak = min(0, self.streak) - 1
        else:
            self.mood = min(1.3, self.mood + 0.04 + 0.08 * (r / 1.5))
            self.streak = max(0, self.streak) + 1
        if self.streak <= -4 and -self.streak % 3 == 1:                  # 4, 7, 10… in a row
            cool = AGGRESSION[self.aggression]["cool_s"]
            self.cool_until = time.time() + cool
            notes.append(f"😞 {-self.streak} losses in a row — cooling off {cool / 60:.1f} min (only top-10 wallet copies), "
                         f"then back in with a higher bar.")
        elif self.streak == 3:
            notes.append("🔥 3 wins in a row — confidence up, sizing back up.")
        self.recent_exits.append("stop" if reason.startswith("stop") else "rug" if rugged else "win" if y else "other")
        stops = sum(1 for e in self.recent_exits if e == "stop")
        if stops >= 6 and len(self.recent_exits) >= 8 and self.rng.random() < 0.34:
            notes.append(f"🛑 {stops} of my last {len(self.recent_exits)} trades hit the stop — I'm demanding more before entering "
                         f"and watching whether my stops are too tight.")
            self.mood = max(0.35, self.mood - 0.05)
        # --- leaders and devs ---
        pnl_pct = mult - 1
        for w in leaders0 or []:
            s = self.leaders.setdefault(w, {"n": 0, "w": 0, "pnl": 0.0, "bench_until": 0})
            s["n"] += 1
            s["w"] += int(y)
            s["pnl"] = round(s["pnl"] + pnl_pct, 4)
            if s["n"] >= 3 and s["w"] / s["n"] < 0.34 and s["pnl"] < 0 and s.get("bench_until", 0) < time.time():
                s["bench_until"] = time.time() + 12 * 3600
                notes.append(f"🪑 Benched wallet {w[:4]}…{w[-4:]} for 12h — copying it lost me money {s['n'] - s['w']} of {s['n']} times.")
        L = self.ap.sniper.launches.get(p["mint"])
        dev = getattr(L, "deployer", None) if L is not None else None
        if dev and (rugged or mult <= 0.5):
            self.bad_devs[dev] = time.time()
            notes.append(f"🚫 Blocked dev {dev[:4]}…{dev[-4:]} — their coin ${p['symbol']} burnt me ({mult:.2f}×).")
        # --- adaptive exits: watch what happens after a stop / trailing exit ---
        kind = p.get("_exit_kind") or ("stop" if reason.startswith("stop") else "trail" if reason.startswith(("trailing", "back to entry"))
                                       else "smart" if "sold" in reason or "leaving" in reason else "early")
        if L is not None and L.mcap_sol and kind in ("stop", "trail", "early", "smart"):
            self.post[p["mint"]] = {"ts": time.time(), "kind": kind, "symbol": p["symbol"],
                                    "entry": p.get("entry_mcap_sol") or L.mcap_sol, "exit": L.mcap_sol, "max": L.mcap_sol, "min": L.mcap_sol}
        lesson = "no features recorded"
        pred = None
        if f:
            before = dict(self.win.w)
            pred = self.win.step(f, y, LR_TRADE)
            self.rug.step(f, rugged, LR_TRADE)
            for _ in range(4):                                           # a real trade also triggers a quick rehearsal
                self.rehearse(1)
            self._remember(f, y, rugged, 4.0, "trade")
            moved = sorted(((self.win.w[k] - before[k], k) for k in self.win.w), key=lambda m: -abs(m[0]))
            lesson = ", ".join(f"{LABELS[k].lower()} {'↑' if d > 0 else '↓'}" for d, k in moved[:3] if abs(d) > 0.005) or "small adjustment"
            tags = pat.tags(f, trig)
            self._tag_update(tags, y, pnl_pct, 1.0)
            notes.extend(self.pattern_lessons(tags))
            self.trained += 1
            self.cache.clear()
        await self.save()
        odds = f" — I gave it {pred * 100:.0f}% odds" if pred is not None else ""
        await self.note("learn", f"{'✅' if y else '💀' if rugged else '❌'} ${p['symbol']} closed at {mult:.2f}× ({reason or p.get('trigger')}){odds}. "
                                 f"Learned: {lesson}. Mood: {self.mood_word()}.", mint=p["mint"])
        for n in notes:
            await self.note("learn", n, mint=p["mint"])

    def pattern_lessons(self, tags: list[str]) -> list[str]:
        out = []
        bn, bw = self.base[0], self.base[1]
        if bn < 8:
            return out
        wr_b = bw / bn
        now = time.time()
        for t in tags:
            s = self.tags.get(t)
            if not s or s[0] < 5 or now - self.told.get(t, 0) < 6 * 3600:
                continue
            wr = s[1] / s[0]
            text = pat.TAG_TEXT.get(t, t)
            if wr <= wr_b - 0.15:
                self.told[t] = now
                out.append(f"📉 Pattern learned: {text} keep losing for me ({wr * 100:.0f}% win vs {wr_b * 100:.0f}% overall) — "
                           f"I'll need a lot more before buying those.")
            elif wr >= wr_b + 0.15 and s[2] > 0:
                self.told[t] = now
                out.append(f"📈 Pattern learned: {text} are working ({wr * 100:.0f}% win vs {wr_b * 100:.0f}% overall) — leaning in.")
        return out

    # ---------------- equity curve ----------------
    async def equity_tick(self) -> None:
        now = time.time()
        if now - self.last_equity < 30:
            return
        self.last_equity = now
        bal = await self.ap.demo_balance("auto")
        held = sum(p["tokens_left"] * p["last_price_sol"] for p in self.ap.open.values() if p["mode"] == "auto")
        eq = round(bal + held, 6)
        self.peak_equity = max(self.peak_equity, eq)
        dd = 1 - eq / self.peak_equity if self.peak_equity else 0.0
        if dd >= 0.3 and self.drawdown < 0.3:
            await self.note("learn", f"📉 Down {dd * 100:.0f}% from my high (◎{self.peak_equity:.2f}) — trading smaller and pickier until I recover.")
        self.drawdown = dd
        await self.ap.db.exec("INSERT INTO auto_equity (ts, mode, equity) VALUES (?,?,?)", (now, "auto", eq))

    # ---------------- reads ----------------
    def public_candidates(self) -> list[dict[str, Any]]:
        return [{k: c.get(k) for k in ("mint", "symbol", "value", "p_rug", "hard", "why", "mcap_usd", "age_s", "tier", "copy_ranks")}
                for c in self.candidates]

    def mood_public(self) -> dict[str, Any]:
        now = time.time()
        return {"value": round(self.mood_factor(), 2), "word": self.mood_word(), "streak": self.streak,
                "cool_s": max(0, round(self.cool_until - now)), "drawdown_pct": round(self.drawdown * 100, 1),
                "top_pct": round(AGGRESSION[self.aggression]["top"] * self.mood_factor() * 100, 1)}

    def patterns_public(self) -> dict[str, Any]:
        bn, bw = self.base[0], self.base[1]
        wr_b = bw / bn if bn else None
        rows = []
        for t, (n, w, pnl) in self.tags.items():
            if n < 3:
                continue
            rows.append({"tag": t, "text": pat.TAG_TEXT.get(t, t), "n": round(n, 1), "win_pct": round(w / n * 100), "avg_pnl_pct": round(pnl / n * 100, 1)})
        rows.sort(key=lambda r: r["win_pct"])
        return {"base_win_pct": round(wr_b * 100) if wr_b is not None else None, "worst": rows[:6], "best": rows[::-1][:6]}

    async def snapshot(self) -> dict[str, Any]:
        eq = await self.ap.db.all("SELECT ts, equity FROM auto_equity WHERE mode='auto' ORDER BY ts DESC LIMIT 600")
        copies = []
        now = time.time()
        for mint, e in sorted(self.copy_buys.items(), key=lambda kv: -max(ts for _, ts in kv[1]["wallets"].values()))[:10]:
            L = self.ap.sniper.launches.get(mint)
            copies.append({"mint": mint, "symbol": L.symbol if L else None, "wallets": len(e["wallets"]),
                           "best_rank": min(r for r, _ in e["wallets"].values()),
                           "last": max(ts for _, ts in e["wallets"].values()), "age_s": round(now - e["first"])})
        per_hour = sum(1 for t in self.label_ts if t > now - 3600)
        win_st, rug_st = self.win.stats(), self.rug.stats()
        return {"threshold": self.threshold, "trained": self.trained, "bias": round(self.win.b, 3), "aggression": self.aggression,
                "levels": AGGRESSION, "shadow": {"trained": self.shadow_trained, "hit_rate": round(self.shadow_hits / self.shadow_trained * 100, 1)
                                                 if self.shadow_trained else None, "pending": len(self.shadow),
                                                 "brier": win_st["brier"], "accuracy": win_st["accuracy"]},
                "rug_model": {**rug_st, "rugs_seen": self.rug_seen,
                              "top": [{"key": k, "label": LABELS[k], "w": round(v, 2)} for k, v in
                                      sorted(self.rug.w.items(), key=lambda kv: -kv[1])[:6]]},
                "learning": {"lessons_per_hour": per_hour, "replay": len(self.replay), "rehearsed": self.rehearsed,
                             "models": 2, "signals": len(KEYS)},
                "mood": self.mood_public(), "patterns": self.patterns_public(),
                "exits": {"stop_pct": round(self.stop_pct() * 100), "trail_mult": round(self.trail_mult, 2), **self.exit_stats,
                          "watching": len(self.post), "patience": round(self.patience, 2), "smart_follow": round(self.smart_follow, 2),
                          "copied_sells": self.copied_sells, "ladder": [f"{f * 100:.0f}% at {m:g}×" for m, f, _ in LADDERS[AGGRESSION[self.aggression]["ladder"]]]},
                "benched": [{"wallet": w, "n": s["n"], "wins": s["w"], "until": s["bench_until"]} for w, s in self.leaders.items()
                            if s.get("bench_until", 0) > now][:10],
                "blocked_devs": len(self.bad_devs),
                "weights": [{"key": k, "label": LABELS[k], "w": round(v, 3), "prior": PRIORS[k]} for k, v in
                            sorted(self.win.w.items(), key=lambda kv: -abs(kv[1]))],
                "candidates": self.public_candidates(), "log": list(self.log)[:150], "equity": eq[::-1], "copies": copies,
                "diag": self.diag, "sizing": self.stats_cache,
                "balance": await self.ap.demo_balance("auto"), "summary": await self.ap.summary("auto")}
