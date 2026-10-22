"""Self-driving Autopilot, v7: Radar's own trading algorithm — it trades its own demo money (and, if you switch it on
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

Surreal mode (v7, default)
  Snipes          brand-new coins in their first ~45 s on its own read of the launch window; quick profits on small
                  caps; every size comes off the current balance, so profit compounds. Power trades (volume /
                  liquidity / holders flooding in) bet 2.5× with a wider stop and target and run while the flood lasts.

Scalper and surges (v7)
  Scalps          hyper / degen also run a scalper: tiny (~1%) immediate trades on the best next minute, banked at
                  ~+12%, cut at ~−8%, out on a momentum flip / dump odds / quiet tape / ~2.5 min; re-enters the same
                  coin; tunes its own bar, take-profit and stop from results and post-mortems.
  Surges          holders + volume + liquidity all pouring in → bank 25% and ride the rest until it dies down.
  No stalls       no absolute value floor in degen / hyper; scalps barely move the mood; skip reasons are reported.

Apes and timing (v6)
  The tape        ape waves (new buyers / 10 s vs the minute before), first buyers cashing out, pros among holders,
                  turnover, breakouts, dips being bought, near-graduation, exhaustion at the highs.
  Timing models   UP / DOWN odds for the next 3 minutes, trained on a snapshot of every live coin every 30 s; entries
                  lean on UP, exits fire on DOWN with a learned threshold. Buys capped at ~4% curve impact; oversized
                  positions trimmed into strength; a learned share sold into graduation.

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
from bisect import bisect_left
from collections import deque
from typing import Any

from . import patterns as pat
from .autopilot import DEMO_START_SOL
from .allocator import strat_key

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
    # v6 — the apes, the tape and the curve: who's piling in, who's leaving, and where the coin is in its life
    "ape_wave": 0.8, "ape_accel": 0.7, "exhaustion": -1.0, "early_exit": -1.2, "turnover": 0.3, "breakout": 0.6,
    "dip_reclaim": 0.5, "near_grad": 0.4, "pro_share": 0.8,
    # influx quality — when several top wallets pile into one coin, the brains judge the pile-in itself
    "influx_rank": 0.6, "influx_speed": 0.5, "influx_late": -0.9, "leader_record": 0.8,
}
RUG_PRIORS: dict[str, float] = {k: 0.0 for k in PRIORS} | {
    "risk": 1.6, "insiders": 1.6, "bundle": 1.2, "snipers": 0.8, "top10": 1.0, "fresh": 0.6, "bots": 0.5, "dev_sold": 0.4,
    "organic": -1.0, "buyers": -0.6, "dev": -0.6, "socials": -0.3, "narrative": -0.3, "hype_bots": 0.6, "upside": -0.4,
    "liq_drain": 1.6, "dump_candle": 1.4, "whale_sells": 1.0, "sell_streak": 0.6, "vertical": 0.8, "wash": 0.8,
    "coordinated": 1.2, "clusters": 0.6, "cluster_hold": 1.5, "dev_hold": 1.0, "dev_dumping": 1.0, "dev_big_buy": 0.6,
    "dev_serial": 1.2, "dev_fresh": 0.5, "holders": -0.5, "retail": -0.4, "staircase": -0.5, "drawdown": 0.6,
    "smart_selling": 1.0, "influx": -0.3, "quiet": 0.3, "early_exit": 0.8, "exhaustion": 0.4, "pro_share": -0.5,
}
# short-horizon TIMING models: will it be +12% before −10% in the next 3 minutes (UP), or −15% first (DOWN)?
# Trained on a snapshot of every live coin every 30 s, so they learn the tape's next move fast — entries wait for UP,
# exits fire on DOWN.
UP_PRIORS: dict[str, float] = {k: 0.0 for k in PRIORS} | {
    "mom_30s": 0.8, "ape_wave": 0.8, "ape_accel": 0.8, "breakout": 0.8, "dip_reclaim": 0.6, "vol_accel": 0.8, "liq_influx": 0.8,
    "influx": 0.8, "copy": 0.6, "exhaustion": -1.0, "early_exit": -0.6, "smart_selling": -1.0, "sell_streak": -0.8, "quiet": -0.8,
    "near_grad": 0.4, "narrative": 0.4, "x_calls": 0.5, "holder_growth": 0.6, "buy_pressure": 0.5,
}
DN_PRIORS: dict[str, float] = {k: 0.0 for k in PRIORS} | {
    "exhaustion": 1.2, "early_exit": 1.0, "smart_selling": 1.2, "sell_streak": 0.8, "whale_sells": 1.0, "dump_candle": 1.0,
    "liq_drain": 1.2, "quiet": 0.6, "vertical": 0.8, "mom_30s": -0.4, "ape_accel": -0.6, "holders_leaving": 0.8, "dev_dumping": 0.8,
    "drawdown": 0.4, "buy_pressure": -0.5,
}
TIMING_H, UP_X, DN_X = 180, 1.12, 0.85
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
          "mom_2m": "Momentum (2m)", "quiet": "Trading gone quiet",
          "ape_wave": "Ape wave (new buyers / 10s)", "ape_accel": "Apes accelerating", "exhaustion": "Exhausted at the highs",
          "early_exit": "First buyers sold out", "turnover": "Volume vs liquidity", "breakout": "Breakout", "dip_reclaim": "Dip being bought",
          "near_grad": "About to graduate", "pro_share": "Pros among holders",
          "influx_rank": "Influx wallets' rank", "influx_speed": "Influx speed", "influx_late": "Price already ran since the influx began",
          "leader_record": "These wallets' copy record"}
KEYS = list(PRIORS)                       # fixed order for the compact replay vectors
KEYS_VER = "v6:" + str(len(KEYS))
BIAS0, RUG_BIAS0 = -3.0, -1.6
AGGRESSION = {   # top-share of what it sees that it will buy, max positions, stop loss, base size, rug veto, buys per tick,
                 # how long a position may go without a new high (stall_s) and at all (time_s) before it's recycled
    "careful": {"top": 0.03, "max_open": 3, "stop": 0.20, "base": 0.02, "floor": 30, "cooldown": 6, "copy_rank": 10, "rug_veto": 0.45,
                "cool_s": 900, "burst": 1, "stall_s": 480, "time_s": 1800, "ladder": "steady", "scalp": None},
    "aggressive": {"top": 0.08, "max_open": 6, "stop": 0.25, "base": 0.03, "floor": 20, "cooldown": 3, "copy_rank": 25, "rug_veto": 0.55,
                   "cool_s": 480, "burst": 1, "stall_s": 360, "time_s": 1500, "ladder": "steady", "scalp": None},
    # degen / hyper: no absolute floor — as the models calibrate to the real (low) memecoin hit rate, every value shrinks,
    # and a fixed floor would silently stop all trading. They trade the top slice of whatever the market is offering.
    "degen": {"top": 0.15, "max_open": 12, "stop": 0.30, "base": 0.03, "floor": 0, "cooldown": 1, "copy_rank": 50, "rug_veto": 0.65,
              "cool_s": 240, "burst": 2, "stall_s": 240, "time_s": 1200, "ladder": "quick",
              "scalp": {"bar": 0.52, "size": 0.012, "tp": 1.12, "stop": 0.08, "max_s": 180}},
    # demo default: a scalper — many tiny in-and-out trades stacking small profits, plus swings, and it rides real surges
    "hyper": {"top": 0.25, "max_open": 24, "stop": 0.25, "base": 0.015, "floor": 0, "cooldown": 0.3, "copy_rank": 50, "rug_veto": 0.70,
              "cool_s": 90, "burst": 4, "stall_s": 180, "time_s": 900, "ladder": "quick",
              # ~1% of the pot per scalp: small enough to do it all day, big enough that the fixed priority fee isn't the profit
              "scalp": {"bar": 0.42, "size": 0.010, "tp": 1.12, "stop": 0.08, "max_s": 150}},
    # SURREAL: a sniper-compounder. It snipes brand-new coins in their first seconds on its own read, banks quick profits
    # on small caps, re-enters, and sizes every trade off the CURRENT balance so profit compounds. Coins with volume,
    # liquidity or holders flooding in get a bigger bet with a wider stop / target ("power" trades).
    "surreal": {"top": 0.35, "max_open": 80, "stop": 0.20, "base": 0.015, "floor": 0, "cooldown": 0.1, "copy_rank": 50, "rug_veto": 0.75,
                "cool_s": 45, "burst": 8, "stall_s": 120, "time_s": 600, "ladder": "quick",
                "scalp": {"bar": 0.36, "size": 0.012, "tp": 1.10, "stop": 0.08, "max_s": 90},
                "snipe": {"bar": 0.40, "size": 0.012, "max_age": 45, "tp": 1.15, "stop": 0.10, "max_s": 75}},
}
POWER = {"size": 2.5, "tp": 1.35, "stop": 0.15, "time": 3.0, "trail": 0.12}   # a coin with everything pouring in: bet more, give it room
# scale-out ladders: (multiple, share of what's left to sell, marker). Partial sells as a coin moves = buys AND sells all day.
LADDERS = {"quick": [(1.25, 0.25, 101), (1.6, 0.30, 102), (2.2, 0.35, 103), (4.0, 0.50, 104)],
           "steady": [(1.4, 0.30, 101), (2.0, 0.35, 102), (3.0, 0.40, 103), (6.0, 0.50, 104)]}
SMART_SELL_SOL = 0.2                         # a top wallet's sell this size or bigger is a signal
LR_TRADE, LR_SHADOW, LR_REPLAY, LR_TIMING = 0.12, 0.03, 0.012, 0.03
IMPACT_CAP = 0.04                            # never move the curve more than ~4% with one buy (that's the price you'd pay)
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
        **((ctx or {}).get("influx_q") or {}),
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
        self.up = Logit(UP_PRIORS, -1.6)
        self.dn = Logit(DN_PRIORS, -1.6)
        self.tsnap: dict[str, dict[str, Any]] = {}          # timing snapshots waiting 3 min for their answer
        self.tlast: dict[str, float] = {}
        self.replay_t: deque[tuple[array, float, float]] = deque(maxlen=4000)
        self.dn_margin = 0.12                               # learned: how far above the market's typical dump odds before it sells
        self.mkt: dict[str, Any] | None = None              # the live market's spread of model odds (everything is judged against it)
        self.scalp_adj = {"bar": 0.0, "tp": 0.0, "stop": 0.0}   # learned offsets on the scalper's entry bar / take-profit / stop
        self.scalp_hist: deque[float] = deque(maxlen=40)    # last scalps' PnL (fraction)
        self.scalp_streak = 0
        self.scalps = {"n": 0, "wins": 0, "pnl_sol": 0.0}
        self.snipes = {"n": 0, "wins": 0, "pnl_sol": 0.0, "power": 0}
        self.fast_ts: deque[float] = deque(maxlen=5000)    # every fast trade (snipe / scalp) close: trades per hour
        self.last_exit: dict[str, tuple[float, int]] = {}  # mint -> (ts, losses in a row on this coin)
        self.skips: dict[str, int] = {}                    # why it didn't trade, this minute
        self.skips_prev: dict[str, int] = {}
        self.skips_ts = 0.0
        self.bars: dict[str, float] = {}
        self.heat = [0.0, 0.0]
        self.brk_until, self.brk_why, self.breaker_trips = 0.0, "", 0
        self.day_start: tuple[int, float] = (0, 0.0)
        self.last_eq = 0.0
        self.pnl_log: deque[tuple[float, float]] = deque(maxlen=2000)   # (ts, realized SOL) for the hourly breaker                              # [fast, slow] EMA of "this coin went +12% first" (the market brain)
        self.pipe: dict[str, Any] = {}
        self.last_tick_ts = time.time()
        self.grad_frac = 0.5                                # learned: how much it sells into a graduation
        self.aggression = "surreal"
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
        self.cache: dict[str, dict[str, Any]] = {}          # mint -> {rid, cn, ts, f, v, rug, up, dn}: latest read of each coin
        self.charts: dict[str, dict[str, float]] = {}        # mint -> latest raw chart read (exits use it)
        self.shadow: dict[str, dict[str, Any]] = {}
        self.sampled: dict[str, tuple[int, float]] = {}      # mint -> (snapshots taken, last ts)
        self.copy_buys: dict[str, dict[str, Any]] = {}         # mint -> {wallets: {w: (rank, ts)}, ...}
        self._influx_seen: dict[str, float] = {}               # mint -> when its influx verdict was last logged
        self.smart_sells: dict[str, dict[str, tuple[int, float]]] = {}   # mint -> {wallet: (rank, ts)}: top wallets getting out
        self.smart_follow = 1.0                                         # how hard it follows their sells (learned)
        self.patience = 1.0                                             # how long it lets a flat position breathe (learned)
        self.copied_sells = 0
        self.threshold = 50.0
        self.last_publish = self.last_skip_note = self.last_equity = self.last_buy_ts = self.last_rehearse = 0.0
        self.real_balance: tuple[float, float] = (0.0, 0.0)  # (ts, SOL)
        self.diag: dict[str, Any] = {}
        self.rng = random.Random()
        from .allocator import Allocator
        from .council import Council
        self.council = Council(self)                         # the Nebula: skeptic + optimist overseeing this executor
        self.alloc = Allocator()                             # …and a risk manager deciding which strategies get money
        # experience replay
        self.replay: deque[tuple[array, float, float, float]] = deque(maxlen=4000)
        self.pending: list[tuple] = []
        self.rehearsed = 0
        self.label_ts: deque[float] = deque(maxlen=5000)
        # discouragement / confidence
        self.mood = 1.0
        self.streak = 0                                   # +wins / −losses in a row
        self.cool_until = 0.0
        self.peak_equity = DEMO_START_SOL
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
            self.up.restore(s.get("up"))
            self.dn.restore(s.get("dn"))
        else:                                             # v1-v3 kept one weight set: it becomes the win model
            self.win.restore({"w": s.get("w") or {}, "b": s.get("b", BIAS0), "n": s.get("trained", 0)})
        self.trained = int(s.get("trained", 0))
        self.shadow_trained = int(s.get("shadow_trained", 0))
        self.shadow_hits = int(s.get("shadow_hits", 0))
        self.rug_seen = int(s.get("rug_seen", 0))
        self.aggression = s.get("aggression") if s.get("aggression") in AGGRESSION else "surreal"
        if ver < 7:
            self.aggression = "surreal"                 # v7: the sniper-compounder is the default (pick any level any time)
        self.mood = float(s.get("mood", 1.0))
        self.streak = int(s.get("streak", 0))
        self.peak_equity = float(s.get("peak_equity", DEMO_START_SOL))
        self.tags = {k: list(v) for k, v in (s.get("tags") or {}).items()}
        self.base = list(s.get("base") or [0.0, 0.0, 0.0])
        self.leaders = s.get("leaders") or {}
        self.bad_devs = s.get("bad_devs") or {}
        self.stop_mult = float(s.get("stop_mult", 1.0))
        self.trail_mult = float(s.get("trail_mult", 1.0))
        self.smart_follow = float(s.get("smart_follow", 1.0))
        self.patience = float(s.get("patience", 1.0))
        self.copied_sells = int(s.get("copied_sells", 0))
        self.dn_margin = float(s.get("dn_margin", 0.12))
        self.council.restore(s.get("council"))
        self.alloc.restore(s.get("alloc"))
        self.scalp_adj.update(s.get("scalp_adj") or {})
        if ver < 8:
            self.scalp_adj["bar"] = 0.0                 # v8: clear the ratcheted-up bar left behind by older versions
        if ver < 9:
            # v9: PumpPortal stopped streaming trades without an API key (May 2026), so everything learned since was learned
            # from coins whose price never moved — noise. Start the models and pattern memory fresh on a live feed.
            self.win, self.rug = Logit(PRIORS, BIAS0), Logit(RUG_PRIORS, RUG_BIAS0)
            self.up, self.dn = Logit(UP_PRIORS, -1.6), Logit(DN_PRIORS, -1.6)
            self.shadow_trained = self.shadow_hits = self.rug_seen = self.rehearsed = 0
            self.tags, self.base = {}, [0.0, 0.0, 0.0]
            self.scalp_adj = {"bar": 0.0, "tp": 0.0, "stop": 0.0}
            self.stop_mult = self.trail_mult = self.patience = self.smart_follow = 1.0
            self.dn_margin, self.grad_frac, self.mood, self.streak = 0.12, 0.5, 1.0, 0
            self.replay.clear()
            self.replay_t.clear()
            self.fresh_start = True
            try:
                await self.ap.db.exec("DELETE FROM brain_examples")
            except Exception:  # noqa: BLE001
                pass
            return
        self.scalps.update(s.get("scalps") or {})
        self.snipes.update(s.get("snipes") or {})
        self.grad_frac = float(s.get("grad_frac", 0.5))
        self.exit_stats.update(s.get("exit_stats") or {})
        self.rehearsed = int(s.get("rehearsed", 0))
        try:
            rows = await self.ap.db.all("SELECT vec, y, rug, w, src FROM brain_examples WHERE ver=? ORDER BY id DESC LIMIT 8000", (KEYS_VER,))
            for r in reversed(rows):
                v = array("f")
                v.frombytes(r["vec"])
                if r["src"] == "timing":
                    self.replay_t.append((v, float(r["y"]), float(r["rug"])))
                else:
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
            "council": self.council.state(), "alloc": self.alloc.state(), "version": 9, "win": self.win.state(), "rug": self.rug.state(),
            "up": self.up.state(), "dn": self.dn.state(), "dn_margin": round(self.dn_margin, 4), "grad_frac": round(self.grad_frac, 4),
            "scalp_adj": {k: round(v, 4) for k, v in self.scalp_adj.items()}, "scalps": self.scalps, "snipes": self.snipes, "trained": self.trained,
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
        self.up, self.dn = Logit(UP_PRIORS, -1.6), Logit(DN_PRIORS, -1.6)
        self.dn_margin, self.grad_frac = 0.12, 0.5
        self.scalp_adj, self.scalps, self.scalp_streak = {"bar": 0.0, "tp": 0.0, "stop": 0.0}, {"n": 0, "wins": 0, "pnl_sol": 0.0}, 0
        self.snipes = {"n": 0, "wins": 0, "pnl_sol": 0.0, "power": 0}
        self.fast_ts.clear()
        self.scalp_hist.clear()
        self.last_exit.clear()
        self.tsnap.clear()
        self.replay_t.clear()
        self.trained = self.shadow_trained = self.shadow_hits = self.rug_seen = self.rehearsed = 0
        self.mood, self.streak, self.cool_until, self.peak_equity, self.drawdown = 1.0, 0, 0.0, DEMO_START_SOL, 0.0
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
        await self.note("reset", f"🧠 Fresh start: both models back to their priors, no pattern memory, {DEMO_START_SOL:.0f} SOL of demo money.")

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
        v = 100 * p_win * (1 - 0.6 * p_rug)
        if self.up.n >= 400:                        # once the timing model knows the tape: buy when the next move is UP
            v *= 0.7 + 0.6 * self.up.p(f)
        return round(min(100.0, v), 1), p_win, p_rug, worst

    def timing(self, f: dict[str, float]) -> tuple[float, float]:
        return self.up.p(f), self.dn.p(f)

    # Model odds are calibrated to the real base rates — and most memecoins dump and die, so a coin's absolute dump / rug
    # odds are high almost everywhere. Fixed cut-offs (v6) ended up vetoing nearly every coin and the bot stopped trading.
    # Everything is judged RELATIVE to the live market instead: avoid the worst slice, buy the best slice.
    def market_stats(self, scored: list[dict[str, Any]]) -> None:
        rows = [self.cache[c["mint"]] for c in scored if c["mint"] in self.cache]
        if len(rows) < 8:
            self.mkt = None
            return
        ups, dns, rugs = [r["up"] for r in rows], [r["dn"] for r in rows], [r["rug"] for r in rows]
        self.mkt = {"up_med": percentile(ups, 0.5), "dn_med": percentile(dns, 0.5), "dn_hi": percentile(dns, 0.85),
                    "rug_hi": percentile(rugs, 0.8), "rug_top": percentile(rugs, 0.95), "edges": sorted(u - d for u, d in zip(ups, dns)),
                    "n": len(rows)}

    def edge_rank(self, up: float, dn: float) -> float:
        """Where this coin's UP-minus-DOWN odds rank in the live market, 0 (worst) … 1 (best)."""
        m = self.mkt
        if not m:
            return _clip(0.5 + (up - dn), 0, 1)
        e = m["edges"]
        return bisect_left(e, up - dn) / max(1, len(e) - 1) if len(e) > 1 else 0.5

    def dn_hot(self, dn: float) -> bool:
        """Dump odds in the worst slice of the market AND clearly above its typical coin."""
        m = self.mkt
        return bool(self.dn.n >= 400 and m and dn >= max(m["dn_hi"], m["dn_med"] + self.dn_margin))

    def rug_hot(self, rug: float, lim: float, top: bool = False) -> bool:
        if rug < lim:
            return False
        m = self.mkt
        return True if not m else rug >= (m["rug_top"] if top else m["rug_hi"])

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

    async def influx_note(self, mint: str, L: Any, desc: str, verdict: str, d: dict[str, Any] | None = None) -> None:
        """Every pile-in gets a visible verdict (once per coin per 10 min) — the brains' call, and why."""
        now = time.time()
        seen = self._influx_seen.get(mint, 0)
        if now - seen < 600:
            return
        self._influx_seen[mint] = now
        if len(self._influx_seen) > 3000:
            self._influx_seen = {m: t for m, t in self._influx_seen.items() if t > now - 3600}
        sym = (getattr(L, "symbol", None) if L is not None else None) or mint[:6]
        votes = ""
        if d:
            v = d["votes"]
            votes = (f" · ⚙️{v['executor']:.2f} 🛡{v['skeptic']:.2f} 🚀{v['optimist']:.2f}"
                     + (f" · skeptic: {d['why'].get('skeptic')}" if d.get("why", {}).get("skeptic") else "")
                     + (f" · optimist: {d['why'].get('optimist')}" if d.get("why", {}).get("optimist") else ""))
        e = self.copy_buys.get(mint) or {}
        px0 = e.get("px0")
        late = ((L.mcap_sol / px0) - 1) if (L is not None and px0 and getattr(L, "mcap_sol", None)) else 0.0
        await self.note("copy", f"🐋 {desc} into ${sym} — {verdict}{votes}" + (f" · price already +{late * 100:.0f}% since they started" if late >= 0.1 else ""),
                        mint=mint)

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
            if "px0" not in e:
                L0 = self.ap.sniper.launches.get(mint)
                e["px0"] = L0.mcap_sol if L0 is not None and L0.mcap_sol else None
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

    def influx_quality(self, mint: str, L: Any = None) -> dict[str, float]:
        """What the council needs to judge a pile-in: how good the wallets are, how fast they came, whether the price
        already ran since the first one bought (late = exit liquidity), and how copying these wallets has gone before."""
        e = self.copy_buys.get(mint)
        if not e:
            return {}
        now = time.time()
        live = {w: (r, ts) for w, (r, ts) in e["wallets"].items() if ts >= now - 300 and not self.benched(w)}
        if not live:
            return {}
        ranks = [r for r, _ in live.values()]
        span = max(30.0, max(ts for _, ts in live.values()) - min(ts for _, ts in live.values()))
        px0 = e.get("px0")
        late = ((L.mcap_sol / px0) - 1) if (L is not None and px0 and getattr(L, "mcap_sol", None)) else 0.0
        recs = [(self.leaders[w]["w"] / self.leaders[w]["n"]) for w in live if w in self.leaders and self.leaders[w].get("n", 0) >= 2]
        return {"influx_rank": _clip(sum(max(0.0, 1 - r / 100) for r in ranks) / len(ranks), 0, 1),
                "influx_speed": _clip(len(live) / (span / 60) / 6, 0, 1),
                "influx_late": _clip(late / 1.0, 0, 1),
                "leader_record": _clip((sum(recs) / len(recs) - 0.5) * 2, -1, 1) if recs else 0.0}

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
        iq = self.influx_quality(L.mint, L) if infl >= 2 else None
        f = features({**r, "age_s": age}, cn, {"narr": self.narr.get(L.mint), "x_calls": self.x_calls.get(L.mint, 0), "chart": ch,
                                               "influx": infl, "smart_sells": self.smart_selling(L.mint), "influx_q": iq})
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
        """One step. An error here never silently stops trading: it's counted, shown on the Autopilot page and logged."""
        try:
            await self._tick(mode)
        except Exception as e:  # noqa: BLE001
            import logging
            import traceback
            why = f"{type(e).__name__}: {e}"[:160]
            self.skip("error: " + why[:60])
            self.last_error = {"ts": time.time(), "error": why, "where": traceback.format_exc().strip().splitlines()[-2][:200]}
            logging.getLogger("radar.brain").warning("brain tick: %s", traceback.format_exc())
            if time.time() - self.last_err_note > 60:
                self.last_err_note = time.time()
                await self.note("error", f"⚠️ Brain error (it keeps going): {why}")

    last_error: dict[str, Any] | None = None
    last_err_note = 0.0

    async def _tick(self, mode: str = "auto") -> None:
        ap = self.ap
        now = time.time()
        dt, self.last_tick_ts = now - self.last_tick_ts, now
        if getattr(self, "fresh_start", False):
            self.fresh_start = False
            await self.save()
            await self.note("reset", "🧠 Fresh brain: the trade feed was down (PumpPortal needs an API key for trades since May 2026), so "
                                     "everything it learned came from coins that never moved. Models reset — it relearns from live trades now.")
        if now - self.last_buy_ts > 20 and self.scalp_adj["bar"] > 0:   # idle: its pickiness fades back so it never goes silent
            self.scalp_adj["bar"] = max(0.0, self.scalp_adj["bar"] * 0.97 ** min(dt, 5))
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
            held = L.mint in holding
            newborn = now - L.created < 60                               # snipe candidates are always read fresh
            if hit and ((hit["rid"] == id(r) and hit["cn"] == cn and now - hit["ts"] < (1 if held or newborn else 10))
                        or (budget <= 0 and not held and not newborn)):
                f, v, p_rug = hit["f"], hit["v"], hit["rug"]                # unchanged: reuse (held coins refresh every second)
            else:
                budget -= 1
                f, v, _, p_rug, _ = self._score(L, now, cn)
                p_up, p_dn = self.timing(f)
                self.cache[L.mint] = {"rid": id(r), "cn": cn, "ts": now, "f": f, "v": v, "rug": p_rug, "up": p_up, "dn": p_dn}
                raw = self.charts.get(L.mint)
                if raw and L.mint in self.sampled and pat.rug_alarm(raw):
                    for key in (L.mint, *(f"{L.mint}#{k}" for k in range(1, 4))):
                        if key in self.shadow:
                            self.shadow[key]["alarm"] = True
            if now - L.created > 1200:
                continue
            self.vals[L.mint] = (now, v)
            c = self.cache[L.mint]
            self.timing_sample(L, c["f"], now)
            scored.append({"mint": L.mint, "symbol": r.get("symbol"), "value": v, "p_rug": round(p_rug * 100), "hard": self.hard_no(r),
                           "p_up": round(c["up"] * 100), "p_dn": round(c["dn"] * 100),
                           "scalp": self.scalp_score(c["f"], self.charts.get(L.mint)) if self.scalp_cfg() else 0.0,
                           "why": self.why(f), "f": f, "mcap_usd": r.get("mcap_usd"), "age_s": round(now - L.created), "tier": r.get("tier"),
                           "deployer": L.deployer, "leaders": leaders, "copy_ranks": ranks, "mcap_sol": L.mcap_sol, "r": r})
            self.sample(L, f, v, now)
        self.market_stats(scored)
        self.council.step(now)
        self.council.idle(now, self.last_buy_ts)
        nb = [L for L in allL if now - L.created < 45]
        self.pipe = {"ts": now, "launches": len(launches), "launches_60s": sum(1 for L in allL if now - L.created < 60),
                     "newborn": len(nb), "newborn_traded": sum(1 for L in nb if getattr(L, "trades", None)),
                     "newborn_2buyers": sum(1 for L in nb if len(getattr(L, "buyers", None) or {}) >= 2),
                     "live_tapes": sum(1 for L in allL if getattr(L, "trades", None) and L.trades[-1][0] > now - 30),
                     "scored": len(scored), "blocked": None}
        await self.shadow_step(now)
        self.timing_step(now)
        for mint, lesson in self.post_mortem(now):
            await self.note("learn", lesson, mint=mint)
        if now - self.last_rehearse > 20:
            self.last_rehearse = now
            self.rehearse(48)
        if len(self.vals) > len(launches) + 500:
            self.vals = {m: tv for m, tv in self.vals.items() if tv[0] > now - 1200}
            self.cache = {m: c for m, c in self.cache.items() if m in launches}
            self.charts = {m: c for m, c in self.charts.items() if m in launches}
            self.tlast = {m: t for m, t in self.tlast.items() if m in launches}
        if now - self.skips_ts > 60:
            self.skips_prev, self.skips, self.skips_ts = self.skips, {}, now
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
        max_open = max(2, round(max_open * min(1.0, (0.85 if agg.get("snipe") else 0.4) + 0.6 * mf)))   # surreal keeps its slots
        self.pipe.update(open=len(mine), slots=max_open)
        if len(mine) >= max_open:
            self.skip("max positions open")
            self.pipe["blocked"] = f"all {max_open} position slots are full"
            return
        bal = await self.balance(mode)
        if bal < 0.06 and mode == "auto" and not mine:
            # demo money only: an empty pot with nothing open would stop it forever — refill it and say so
            await ap._demo_add(DEMO_START_SOL - bal, "auto")                      # top the balance up; trade history is kept
            self.peak_equity, self.drawdown = DEMO_START_SOL, 0.0
            self.refills = getattr(self, "refills", 0) + 1
            await self.note("mode", f"💸 The demo pot ran dry — refilled to ◎{DEMO_START_SOL:.0f} (refill #{self.refills}). Real money is never refilled.")
            bal = await self.balance(mode)
        self.pipe["balance"] = round(bal, 4)
        if bal < 0.06:
            self.skip("out of money")
            self.pipe["blocked"] = f"out of money (◎{bal:.3f})"
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
            if self.can_enter(mint, mode, "copy"):
                continue
            ok, k, desc = self.influx(mint)
            if not ok or (cooling and k < 4):
                continue
            n, leaders, ranks = self.copy_signal(mint)
            L = launches.get(mint)
            f, v = None, None
            if L is not None and L.result:
                why_not = self.hard_no(L.result) or self.veto(L, now)
                if why_not:
                    await self.influx_note(mint, L, desc, f"skipped — {why_not}")
                    continue
                f, v, _, p_rug, _ = self._score(L, now, n)
                why_not = self.veto(L, now, p_rug)
                if why_not:
                    await self.influx_note(mint, L, desc, f"skipped — {why_not}")
                    continue
            elif k < 4 or not await self._tradeable(mint):
                continue
            else:
                f = {"influx": min(1.0, k / 4), **self.influx_quality(mint)}
            size = self.size(bal, 0.8, mode, copy=True)
            iq = self.influx_quality(mint, L)
            exec_conf = _clip(0.45 + 0.04 * k + 0.2 * iq.get("influx_rank", 0) + 0.15 * iq.get("leader_record", 0)
                              - 0.4 * iq.get("influx_late", 0), 0.05, 0.95)
            if not await self._council_buy("copy", mint, size, mode, "copy", f"🐋 influx: {desc}", L.result if L else None, f, v, leaders,
                                           exec_conf, L, strat="copy"):
                await self.influx_note(mint, L, desc, "the Nebula passed", self.council.debate[0] if self.council.debate else None)
                continue
            await self.influx_note(mint, L, desc, "the Nebula is in", self.council.debate[0] if self.council.debate else None)
            bought += 1
            copies_open += 1
            bal = await self.balance(mode)
        if cooling:
            self.skip("cooling off after losses")
        if bought >= room:
            return
        # 1b) SURREAL snipes: brand-new coins in their first seconds, on its own read of the launch window
        sn = agg.get("snipe")
        if sn:
            fresh = []
            for L in allL:
                age = now - L.created
                if age > sn["max_age"] or not L.result or not L.mcap_sol:
                    continue
                hit = self.cache.get(L.mint)
                if not hit:
                    continue
                sc_ = self.snipe_score(L, hit["f"], self.charts.get(L.mint), age)
                if sc_ > 0:
                    fresh.append((sc_, L, hit))
            fresh.sort(key=lambda t: -t[0])
            bar = self.rel_bar(sn["bar"], [t[0] for t in fresh], 0.5)
            self.bars["snipe"] = bar
            self.pipe.update(snipe_candidates=len(fresh), best_snipe=round(fresh[0][0], 3) if fresh else None)
            for sc_, L, hit in fresh:
                if bought >= room or bal < 0.06:
                    break
                if sc_ < bar:
                    if not bought:
                        self.skip("no new launch above the snipe bar")
                    break
                if self.can_enter(L.mint, mode, "snipe") or (L.deployer and L.deployer in self.bad_devs):
                    continue
                hard = self.hard_no(L.result)
                if hard and not (hard == "too few buyers" and (L.result.get("buyers") or 0) >= 2):
                    self.skip(f"hard no: {hard}")
                    continue
                veto = self.veto(L, now, hit["rug"])
                if veto:
                    self.skip("veto: " + veto.split(" (")[0])
                    continue
                power = self.power(hit["f"])
                size = bal * sn["size"] * (0.6 + 0.8 * sc_) * (0.6 + 0.4 * min(1.0, mf)) * (POWER["size"] if power else 1.0)
                ex = self.fast_exits(sn, power)
                if not await self._council_buy("snipe", L.mint, round(max(0.02, size), 4), mode, "snipe",
                                f"{'💥 POWER ' if power else ''}snipe {sc_ * 100:.0f} at {now - L.created:.0f}s old (bar {bar * 100:.0f}) · "
                                f"tp +{(ex['tp'] - 1) * 100:.0f}% / stop −{ex['stop'] * 100:.0f}%",
                                L.result, hit["f"], hit["v"], [], _clip(0.5 + (sc_ - bar) * 1.5, 0, 1), L, exits=ex,
                                strat=strat_key("snipe", now - L.created)):
                    continue
                bought += 1
                bal = await self.balance(mode)
        if bought >= room:
            return
        # 1c) SECOND WAVE: wait out the first-minute flush (65% of devs sell inside a minute, 55% of snipes are gone in one),
        #     then buy the coins that SURVIVED it — dip being bought back, holders still growing, snipers and dev out
        if agg.get("snipe") or agg.get("scalp"):
            wave = []
            for L in allL:
                age = now - L.created
                if not (45 <= age <= 300) or not L.result or not L.mcap_sol:
                    continue
                hit = self.cache.get(L.mint)
                raw = self.charts.get(L.mint)
                if hit and raw:
                    w = self.wave2_score(hit["f"], raw)
                    if w > 0:
                        wave.append((w, L, hit))
            wave.sort(key=lambda t: -t[0])
            wbar = max(0.35, self.rel_bar(0.45, [t[0] for t in wave], 0.4))
            self.bars["wave2"] = wbar
            for w, L, hit in wave:
                if bought >= room or bal < 0.06 or w < wbar:
                    break
                if self.can_enter(L.mint, mode, "scalp") or (L.deployer and L.deployer in self.bad_devs):
                    continue
                hard = self.hard_no(L.result)
                if hard or self.veto(L, now, hit["rug"]):
                    continue
                cfg = AGGRESSION[self.aggression].get("scalp") or AGGRESSION["hyper"]["scalp"]
                size = bal * cfg["size"] * (0.7 + 0.8 * w) * (0.6 + 0.4 * min(1.0, mf))
                if not await self._council_buy("wave2", L.mint, round(max(0.02, size), 4), mode, "scalp",
                                               f"🌊 second wave {w * 100:.0f} at {now - L.created:.0f}s (survived the flush: dip bought back, holders growing)",
                                               L.result, hit["f"], hit["v"], [], _clip(0.5 + (w - wbar) * 1.5, 0, 1), L, strat="wave2"):
                    continue
                bought += 1
                bal = await self.balance(mode)
            if bought >= room:
                return
        # 2) its own picks: the best coins it can see above its (percentile) bar — several per tick when it's hot
        for c in ([] if cooling else scored):
            if bought >= room or bal < 0.06:
                break
            if c["hard"]:
                self.skip(f"hard no: {c['hard']}")
                continue
            if self.can_enter(c["mint"], mode, "swing"):
                continue
            if c["deployer"] and (c["deployer"] in devs or c["deployer"] in self.bad_devs):
                continue
            L = launches.get(c["mint"])
            veto = self.veto(L, now, c["p_rug"] / 100) if L is not None else None
            if veto or self.smart_selling(c["mint"]) >= 2:
                self.skip("veto: " + (veto or "top wallets selling").split(" (")[0])
                continue
            explore = False
            if c["value"] < self.threshold:
                if False:                                    # explore buys removed: ghost trades teach the same thing for free
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
            if not await self._council_buy("swing", c["mint"], size, mode, "explore" if explore else "brain", detail, c["r"], c["f"], c["value"],
                                           c["leaders"], _clip(0.5 + (c["value"] - self.threshold) / max(10.0, 100 - self.threshold), 0, 1), L,
                                           strat="explore" if explore else "swing"):
                continue
            devs.add(c["deployer"])
            bought += 1
            if explore:
                break
            bal = await self.balance(mode)
        # 3) the scalper: tiny, immediate in-and-out trades on whatever has the best next minute — all day long
        sc = self.scalp_cfg()
        if not sc or bought >= room:
            return
        scalpable = sorted((c for c in scored if c["scalp"] > 0), key=lambda c: -c["scalp"])
        sbar = self.rel_bar(AGGRESSION[self.aggression]["scalp"]["bar"], [c["scalp"] for c in scalpable], 0.3) * (1.1 if cooling else 1.0)
        self.bars["scalp"] = sbar
        self.pipe.update(scalpable=len(scalpable), best_scalp=round(scalpable[0]["scalp"], 3) if scalpable else None)
        sc = {**sc, "bar": sbar}
        for c in scalpable:
            if bought >= room or bal < 0.06:
                break
            if c["scalp"] < sbar:
                if not bought:
                    self.skip("no coin above the scalp bar")
                break
            if c["hard"] or self.can_enter(c["mint"], mode, "scalp") or (c["deployer"] and c["deployer"] in self.bad_devs):
                continue
            L = launches.get(c["mint"])
            veto = self.veto(L, now, c["p_rug"] / 100) if L is not None else None
            if veto:
                self.skip("veto: " + veto.split(" (")[0])
                continue
            power = self.power(c["f"])
            size = max(0.02, bal * sc["size"] * (0.6 + 0.8 * c["scalp"]) * (0.6 + 0.4 * min(1.0, mf)) * (POWER["size"] if power else 1.0))
            ex = self.fast_exits(sc, power)
            if not await self._council_buy("scalp", c["mint"], round(size, 4), mode, "scalp", f"{'💥 POWER ' if power else ''}scalp {c['scalp'] * 100:.0f} (bar {sc['bar'] * 100:.0f}) · "
                            f"▲{c['p_up']} ▼{c['p_dn']} · tp +{(ex['tp'] - 1) * 100:.0f}% / stop −{ex['stop'] * 100:.0f}%",
                            c["r"], c["f"], c["value"], c["leaders"], _clip(0.5 + (c["scalp"] - sbar) * 1.5, 0, 1), L, exits=ex):
                continue
            bought += 1
            bal = await self.balance(mode)
        # (the drought breaker was removed: forcing a trade every 15 s just to stay busy bought coins with no edge)

    # ---------------- scalper: immediate in-and-out trades ----------------
    def scalp_cfg(self) -> dict[str, float] | None:
        sc = AGGRESSION[self.aggression].get("scalp")
        if not sc:
            return None
        a = self.scalp_adj
        return {**sc, "bar": _clip(sc["bar"] + a["bar"], 0.25, 0.85), "tp": _clip(sc["tp"] + a["tp"], 1.05, 1.3),
                "stop": _clip(sc["stop"] + a["stop"], 0.04, 0.15)}

    def scalp_score(self, f: dict[str, float], raw: dict[str, float] | None) -> float:
        """How good the NEXT minute looks: apes arriving, price ticking up, buyers in control, liquidity behind it — and none
        of the tells of a top. Once the timing model has learned the tape, its UP/DOWN odds do most of the work."""
        if not raw or raw.get("liq", 0) < 1.5 or raw.get("quiet_s", 99) > 15:
            return 0.0
        h = (0.30 * f.get("ape_wave", 0) + 0.20 * max(0.0, f.get("ape_accel", 0)) + 0.20 * max(0.0, f.get("mom_30s", 0))
             + 0.15 * f.get("buy_pressure", 0) + 0.15 * _clip(raw.get("net_30s", 0) / 3, 0, 1) + 0.10 * f.get("breakout", 0)
             + 0.10 * f.get("dip_reclaim", 0) + 0.10 * f.get("influx", 0) + 0.05 * f.get("holder_growth", 0))
        h -= (0.40 * f.get("exhaustion", 0) + 0.40 * f.get("smart_selling", 0) + 0.30 * f.get("dump_candle", 0)
              + 0.20 * f.get("sell_streak", 0) + 0.20 * f.get("liq_drain", 0) + (0.25 * f.get("early_exit", 0) if f.get("mom_30s", 0) < 0.1 else 0))
        if self.up.n >= 400:
            h = 0.4 * h + 0.6 * self.edge_rank(self.up.p(f), self.dn.p(f))
        return round(_clip(h, 0, 1), 3)

    def rel_bar(self, base: float, scores: list[float], share: float) -> float:
        """The entry bar is never stricter than 'the best `share` of what's live right now'. Its learned pickiness shrinks
        that share instead of pushing an absolute bar out of reach — the old absolute bar could ratchet up after a bad run
        and then never come down, because with no trades there was nothing to learn from (the bot just went silent)."""
        adj = self.scalp_adj["bar"]
        share = _clip(share - adj * 1.5, 0.15, 0.8)
        absolute = _clip(base + adj, 0.15, 0.85)
        if len(scores) < 3:
            return absolute
        return round(max(0.12, min(absolute, percentile(scores, 1 - share))), 3)

    def snipe_score(self, L: Any, f: dict[str, float], raw: dict[str, float] | None, age: float) -> float:
        """A brand-new coin, read in its first seconds: real buyers arriving (not one hand), money flowing in, a sane dev
        buy, no bundle / cluster / serial dev. Once the timing model knows the tape, its UP / DOWN odds weigh in."""
        if not raw:
            return 0.0
        buyers = len(getattr(L, "buyers", None) or {})
        if buyers < 2 or raw.get("quiet_s", 99) > 12:
            return 0.0
        r = L.result or {}
        h = (0.25 * min(1.0, buyers / 8) + 0.20 * f.get("ape_wave", 0) + 0.15 * max(0.0, f.get("mom_30s", 0))
             + 0.15 * _clip(raw.get("net_30s", 0) / 2, 0, 1) + 0.10 * f.get("organic", 0.5) + 0.10 * (1 - f.get("dev_big_buy", 0))
             + 0.05 * f.get("socials", 0) + 0.05 * f.get("narrative", 0) + 0.05 * f.get("tweet", 0) + 0.05 * f.get("copy", 0))
        h -= (0.5 * f.get("coordinated", 0) + 0.4 * f.get("bundle", 0) + 0.3 * f.get("dev_serial", 0) + 0.3 * f.get("snipers", 0)
              + 0.4 * f.get("dump_candle", 0) + 0.3 * f.get("sell_streak", 0) + 0.3 * f.get("dev_dumping", 0) + (0.4 if r.get("bundled") else 0))
        if self.up.n >= 400:
            h = 0.45 * h + 0.55 * self.edge_rank(self.up.p(f), self.dn.p(f))
        return round(_clip(h, 0, 1), 3)

    @staticmethod
    def wave2_score(f: dict[str, float], raw: dict[str, float]) -> float:
        """A coin that took the first-minute dump and is being bought back: off its early high, buyers back in control,
        holders still arriving, the dev and the snipers mostly out (they were the sellers)."""
        dd = raw.get("drawdown", 0)
        if not (0.15 <= dd <= 0.65) or raw.get("holders", 0) < 12 or raw.get("quiet_s", 99) > 15:
            return 0.0
        if raw.get("dev_hold", 0) >= 5 or f.get("coordinated", 0) >= 0.25 or f.get("cluster_hold", 0) >= 0.25:
            return 0.0
        h = (0.25 * f.get("dip_reclaim", 0) + 0.20 * max(0.0, f.get("mom_30s", 0)) + 0.15 * _clip(raw.get("net_30s", 0) / 2, 0, 1)
             + 0.15 * f.get("holder_growth", 0) + 0.10 * f.get("buy_pressure", 0) + 0.10 * f.get("staircase", 0)
             + 0.05 * f.get("dev_dumping", 0) + 0.05 * f.get("narrative", 0) + 0.05 * f.get("influx", 0))
        h -= 0.3 * f.get("snipers", 0) + 0.3 * f.get("sell_streak", 0) + 0.3 * f.get("whale_sells", 0) + 0.2 * f.get("liq_drain", 0)
        return round(_clip(h, 0, 1), 3)

    def heat_mult(self) -> float:
        """The market brain: how hot pump.fun is right now vs its normal (share of live coins whose next 3 minutes went
        +12% first). Hot → bet a bit more; cold → bet less. Sizes only — the council still decides."""
        fast, slow = self.heat[0], self.heat[1]
        if slow <= 0.01:
            return 1.0
        return round(_clip(fast / slow, 0.6, 1.35), 3)

    def power(self, f: dict[str, float]) -> bool:
        """Volume, liquidity or holders flooding in fast — the coins worth a bigger bet and a wider stop / target."""
        if f.get("exhaustion", 0) >= 0.3 or f.get("smart_selling", 0) or f.get("coordinated", 0) >= 0.25:
            return False
        flood = sum((f.get("holder_growth", 0) >= 0.6, f.get("vol_accel", 0) >= 0.4, f.get("liq_influx", 0) >= 0.3, f.get("ape_wave", 0) >= 0.75))
        return flood >= 2 or self.surging(f)

    @staticmethod
    def fast_exits(cfg: dict[str, float], power: bool) -> dict[str, Any]:
        if power:
            return {"tp": max(cfg["tp"], POWER["tp"]), "stop": max(cfg["stop"], POWER["stop"]), "max_s": cfg["max_s"] * POWER["time"], "power": True}
        return {"tp": cfg["tp"], "stop": cfg["stop"], "max_s": cfg["max_s"], "power": False}

    def can_enter(self, mint: str, mode: str, style: str) -> str | None:
        """Re-entry is allowed (scalpers trade the same coin again and again) — but not into a coin it's holding, not
        straight after leaving it, and not after it lost twice in a row on it."""
        if mint in self.ap.busy or any(p["mint"] == mint and p["mode"] == mode for p in self.ap.open.values()):
            return "holding"
        ex = self.last_exit.get(mint)
        if style == "snipe" and ex:
            return "already sniped"                         # a launch is sniped once; after that it's a scalp candidate
        if ex:
            wait = 20 if style == "scalp" else 120
            if time.time() - ex[0] < wait:
                return "just exited"
            if ex[1] >= 2 and time.time() - ex[0] < 900:
                return "lost twice on it"
        if style != "scalp" and mint in self.ap.entered and not ex:
            return "already traded"                          # rules-mode / manual entries, or a failed buy just now
        return None

    def skip(self, why: str) -> None:
        self.skips[why] = self.skips.get(why, 0) + 1

    @staticmethod
    def surging(f: dict[str, float]) -> bool:
        """A real run: holders piling in, volume surging, liquidity flowing in, and no sign of a top. Hold it."""
        return (f.get("holder_growth", 0) >= 0.45 and f.get("vol_accel", 0) >= 0.2 and f.get("liq_influx", 0) >= 0.15
                and f.get("exhaustion", 0) < 0.3 and f.get("smart_selling", 0) == 0)

    @staticmethod
    def dying(f: dict[str, float]) -> bool:
        """The surge is dying down: new buyers fading, volume slowing, holders stalling (or worse)."""
        return ((f.get("ape_accel", 0) <= -0.4 and f.get("holder_growth", 0) < 0.25 and f.get("vol_accel", 0) < 0)
                or f.get("exhaustion", 0) >= 0.5 or f.get("liq_drain", 0) >= 0.5 or f.get("quiet", 0) >= 0.5)

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
            if self.rug_hot(p_rug, lim):
                return f"rug model {p_rug * 100:.0f}%"
        c = self.cache.get(L.mint)
        if c and self.dn_hot(c["dn"]):
            return f"timing model sees a dump ({c['dn'] * 100:.0f}%)"
        return None

    async def _tradeable(self, mint: str) -> bool:
        tok = await self.ap.tracker.token_summary(mint)
        return bool(tok and tok.get("price_usd") and (tok.get("liquidity_usd") or 0) >= 10_000)

    def breaker(self) -> str | None:
        """Circuit breakers: a bad stretch can't drain the pot. Daily −15% → 30-min pause; −8% in the last hour → 10-min pause."""
        now = time.time()
        if now < self.brk_until:
            return self.brk_why
        day = int(now // 86400)
        eq = self.last_eq or 0.0
        if eq and self.day_start[0] != day:
            self.day_start = (day, eq)
        start = self.day_start[1]
        hour = [x for ts, x in self.pnl_log if ts > now - 3600]
        if start and eq and eq < start * 0.85:
            self.brk_until, self.brk_why = now + 1800, f"down {(1 - eq / start) * 100:.0f}% today — 30-min pause"
        elif eq and sum(hour) < -0.08 * eq:
            self.brk_until, self.brk_why = now + 600, f"lost ◎{-sum(hour):.2f} in the last hour — 10-min pause"
        else:
            return None
        self.breaker_trips += 1
        return self.brk_why

    async def _council_buy(self, style: str, mint: str, size: float, mode: str, trig: str, detail: str, r: dict[str, Any] | None,
                           f: dict[str, float] | None, value: float | None, leaders: list[str], exec_conf: float, L: Any,
                           exits: dict[str, Any] | None = None, strat: str | None = None) -> bool:
        """Every buy goes to the Nebula first: the allocator checks the strategy is still earning its keep, then executor,
        skeptic and optimist vote; the council sets size and exit playbook."""
        strat = strat or style
        ok, amult, why = self.alloc.gate(strat)
        if not ok:
            self.skip(f"allocator: {strat} benched")
            return False
        brk = self.breaker()
        if brk:
            self.skip(f"circuit breaker: {brk}")
            return False
        d = self.council.decide(style, f or {}, exec_conf, (r or {}).get("symbol") or mint[:6], mint)
        d["strat"] = strat
        if not d["go"]:
            self.skip("council: skeptic veto" if d["veto"] else "council said no")
            self.council.ghost(mint, f or {}, L, d, size)
            return False
        # the expected-value gate: honest (calibrated) odds × this strategy's real average win / loss, after fees
        p_lose = self.council.cal(d["votes"]["p_lose"])
        ev, evidence = self.alloc.ev(strat, p_lose)
        d["ev"] = round(ev, 4)
        if evidence >= 15 and ev <= 0:
            self.skip("negative expected value")
            self.council.ghost(mint, f or {}, L, {**d, "go": False}, size)
            return False
        amult *= _clip(1 + 4 * ev, 0.5, 1.6) if evidence >= 15 else 1.0      # lean into the best positive-EV trades
        exposure = sum(p["sol_in"] - p["sol_out"] for p in self.ap.open.values() if p["mode"] == mode and p["tokens_left"] > 0)
        bal = await self.balance(mode)
        if exposure + size > 0.6 * (bal + exposure):
            self.skip("exposure cap (60% of the pot deployed)")
            return False
        ex = dict(d["exits"])
        if exits and exits.get("power"):                          # a flood of volume / holders: keep the wider leash of the two
            ex.update(tp=max(ex["tp"], exits["tp"]), stop=max(ex["stop"], exits["stop"]), max_s=max(ex["max_s"], exits["max_s"]), power=True)
        heat = self.heat_mult()
        p = await self._buy(mint, round(max(0.02, size * d["size_mult"] * amult * heat), 4), mode, trig,
                            f"{detail} · {d['summary']} · EV {ev * 100:+.1f}%{' · probe' if why == 'probe' else ''}", r, f, value, leaders,
                            exits=ex, council=d)
        if p is not None:
            p["strat"], p["probe"] = strat, why == "probe"
            await self.ap.db.exec("UPDATE auto_positions SET features_json=json_set(COALESCE(features_json,'{}'), '$.strat', ?, '$.probe', ?) WHERE id=?",
                                  (strat, 1 if why == "probe" else 0, p["id"]))
        return p is not None

    async def _buy(self, mint: str, size: float, mode: str, trig: str, detail: str, r: dict[str, Any] | None,
                   f: dict[str, float] | None, value: float | None, leaders: list[str], exits: dict[str, Any] | None = None,
                   council: dict[str, Any] | None = None) -> dict[str, Any] | None:
        ap = self.ap
        L = ap.sniper.launches.get(mint)
        if L is not None and getattr(L, "vsol", None):
            cap = max(0.02, IMPACT_CAP * L.vsol)                       # don't pay more than ~4% price impact on the curve
            if size > cap:
                size = round(cap, 4)
                detail += f" · size capped at ◎{cap:.2f} by liquidity"
        style = trig if trig in ("scalp", "snipe") else "copy" if trig == "copy" else "swing"
        try:
            p = await ap.buy(mint, "copy" if trig == "copy" else "brain", detail, r, sol=size, mode=mode)
        except Exception as e:  # noqa: BLE001
            ap.entered[mint] = time.time()            # don't retry the same failing coin every tick
            self.last_exit[mint] = (time.time(), (self.last_exit.get(mint) or (0, 0))[1])
            await self.note("error", f"⚠️ Couldn't buy {(r or {}).get('symbol') or mint[:6]}: {e}", mint=mint)
            return None
        p["leaders"] = list(leaders or [])
        p["features"], p["score"], p["style"] = f, value, style
        if exits:
            p["exits"] = exits
            if exits.get("power"):
                self.snipes["power"] += 1
        if council:
            p["council"] = {"votes": council["votes"], "play": council["play"]}
            self.council.open_track(f"p:{p['id']}", mint, f, (L.mcap_sol if L is not None and L.mcap_sol else p["entry_mcap_sol"]), p["sol_in"],
                                    getattr(L, "vsol", None) if L is not None else None, council, real=True, sol=p["sol_in"])
        meta = {"f": f, "leaders0": p["leaders"], "trig": trig, "v": value, "style": style, "exits": exits, "council": p.get("council")}
        p["entry_value"] = value
        await ap.db.exec("UPDATE auto_positions SET features_json=?, score=?, leaders_json=? WHERE id=?",
                         (json.dumps(meta) if f else None, value, json.dumps(p["leaders"]), p["id"]))
        p["leaders0"], p["brain_trig"] = list(p["leaders"]), trig
        self.last_buy_ts = time.time()
        icon = "🪞" if trig == "copy" else "🧪" if trig == "explore" else "⚡" if trig == "scalp" else "🎯" if trig == "snipe" else "🟢"
        await self.note("buy", f"{icon} {'REAL ' if mode == 'real' else ''}Bought ${p['symbol']} for ◎{p['sol_in']:.3f} — {detail}",
                        mint=mint, value=value, sol=p["sol_in"])
        return p

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
        if len(self.replay_t) >= 50:
            for _ in range(n):
                v, up, dn = self.replay_t[self.rng.randrange(len(self.replay_t))]
                f = dict(zip(KEYS, v))
                self.up.step(f, up, LR_REPLAY, track=False)
                self.dn.step(f, dn, LR_REPLAY, track=False)
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
        tape = getattr(L, "trades", None)
        if tape is not None and not tape:
            return                                          # no trades seen = no information: never learn "nothing happened"
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

    # ---------------- timing models: the tape's next 3 minutes ----------------
    def timing_sample(self, L: Any, f: dict[str, float], now: float) -> None:
        tape = getattr(L, "trades", None)
        if tape is not None and not tape:
            return
        if not L.mcap_sol or now - self.tlast.get(L.mint, 0) < 30 or len(self.tsnap) >= 3000:
            return
        self.tlast[L.mint] = now
        self.tsnap[f"{L.mint}@{int(now)}"] = {"mint": L.mint, "ts": now, "vec": self._vec(f), "px": L.mcap_sol, "up": None}

    def timing_step(self, now: float) -> None:
        launches = self.ap.sniper.launches
        done = []
        for key, t in self.tsnap.items():
            L = launches.get(t["mint"])
            px = L.mcap_sol if L is not None else None
            if px and t["up"] is None:
                if px >= t["px"] * UP_X:
                    t["up"], t["dn"] = 1.0, 0.0                    # +12% came first
                elif px <= t["px"] * DN_X:
                    t["up"], t["dn"] = 0.0, 1.0                    # −15% came first
            if t["up"] is not None or now - t["ts"] >= TIMING_H or L is None:
                done.append(key)
        for key in done:
            t = self.tsnap.pop(key)
            up, dn = (t["up"], t["dn"]) if t["up"] is not None else (0.0, 0.0)
            f = dict(zip(KEYS, t["vec"]))
            self.up.step(f, up, LR_TIMING)
            self.dn.step(f, dn, LR_TIMING * (1.3 if dn else 1.0))
            self.replay_t.append((t["vec"], up, dn))
            self.heat[0] = 0.97 * self.heat[0] + 0.03 * up
            self.heat[1] = 0.997 * self.heat[1] + 0.003 * up if self.heat[1] else up
            self.pending.append((now, KEYS_VER, t["vec"].tobytes(), up, dn, "timing", 1.0))
            self.label_ts.append(now)

    def _learn_win(self, s: dict[str, Any]) -> None:
        self.win.step(dict(zip(KEYS, s["vec"])), s["won"], LR_SHADOW)
        self.shadow_trained += 1
        self.shadow_hits += int(s["won"])

    # ---------------- its own exits ----------------
    def stop_pct(self) -> float:
        return _clip(AGGRESSION[self.aggression]["stop"] * self.stop_mult, 0.15, 0.6)

    def exit_for(self, p: dict[str, Any], r: dict[str, Any] | None, x: float, peak_x: float) -> tuple[float, str] | None:
        """One decision per tick, so as a coin moves you see it scale out, cut, and recycle the money into the next trade."""
        p.pop("_exit_rule", None)                                     # the auditor books only the rule that actually fired
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
        if hit and self.rug.n >= 300 and self.rug_hot(hit["rug"], 0.85, top=True) and x < 2:
            return self._exit(p, 1.0, f"rug model {hit['rug'] * 100:.0f}% — getting out", "rug")
        stop = self.stop_pct()
        f = (hit or {}).get("f") or {}
        # riding a real surge — holders, volume and liquidity all pouring in: hold it until it dies down
        if p.get("ride"):
            if not hit or age > 1800:                                    # lost its live read, or held 30 min: bank it
                return self._exit(p, 1.0, f"ride closed at {x:.2f}× ({'no live read' if not hit else '30-min cap'})", "trail")
            if x <= 0.9:
                return self._exit(p, 1.0, f"ride failed — back below entry ({x:.2f}×)", "stop")
            if self.dying(f) or (hit and self.dn_hot(hit["dn"])) or self.smart_selling(p["mint"]) >= 2:
                return self._exit(p, 1.0, f"surge died down — sold the ride at {x:.2f}× (peak {peak_x:.2f}×)", "trail")
            trail = _clip((0.30 if peak_x < 3 else 0.22) * self.trail_mult, 0.12, 0.45)
            if x <= peak_x * (1 - trail):
                return self._exit(p, 1.0, f"ride trailing stop ({peak_x:.1f}× peak, {trail * 100:.0f}% trail)", "trail")
            return None
        cv = self.council.exit_vote(p, f, x, age) if self.exit_on(p, "skeptic", check_only=True) else None
        if cv:                                                       # the skeptic can pull the plug; the optimist can hold
            p["_exit_rule"] = "skeptic"
            return cv
        if f and x >= 1.10 and self.surging(f):          # bank into a surge only once it covers the fees (+3% was ~break-even)
            p["ride"] = True
            return (0.25, f"surge: holders, volume and liquidity pouring in — banked 25% at {x:.2f}×, riding the rest until it dies down")
        if p.get("style") in ("scalp", "snipe"):
            return self.scalp_exit(p, f, raw, hit, x, age, peak_x)
        pb = p.get("exits") if (p.get("exits") or {}).get("preset") else None   # the council's playbook sets the leash for swings
        if pb:
            stop = _clip(float(pb["stop"]) * self.stop_mult, 0.04, 0.6)
        if x <= 1 - stop:
            return self._exit(p, 1.0, f"stop −{stop * 100:.0f}%", "stop")
        L = self.ap.sniper.launches.get(p["mint"])
        # graduation: early holders sell into the migration — it sells a learned share into the move
        if L is not None and getattr(L, "graduated_at", None) and L.graduated_at > p["opened"] and 200 not in p["tp_done"]:
            p["tp_done"].append(200)
            self.post[f"{p['mint']}#grad"] = {"mint": p["mint"], "ts": now, "kind": "grad", "symbol": p["symbol"], "entry": p.get("entry_mcap_sol") or 1,
                                             "exit": L.mcap_sol or 1, "max": L.mcap_sol or 1, "min": L.mcap_sol or 1}
            return self.grad_frac, f"graduated — sold {self.grad_frac * 100:.0f}% into the migration"
        # the timing model sees the next 3 minutes going −15% first
        if hit and self.dn_hot(hit["dn"]) and now - p.get("_dn_ts", 0) > 30:
            p["_dn_ts"] = now
            if hit["dn"] >= (self.mkt or {}).get("dn_hi", 0) + 0.1 or x < 1.0:
                return self._exit(p, 1.0, f"timing model: dump likely ({hit['dn'] * 100:.0f}%) — out", "model")
            return 0.5, f"timing model: dump likely ({hit['dn'] * 100:.0f}%) — took half off"
        if raw and x >= 1.15 and now - p.get("_ape_ts", 0) > 45:
            n = pat.normalise(raw, age, None)
            if n["exhaustion"] >= 0.5:
                p["_ape_ts"] = now
                return 0.4, "apes exhausted — buyers drying up at the highs"
            if n["early_exit"] >= 0.6 and 201 not in p["tp_done"]:
                p["tp_done"].append(201)
                return 0.35, f"first buyers cashing out ({n['early_exit'] * 100:.0f}% of the first 20 are gone)"
        # exit liquidity: a position too big for the pool gets trimmed while there are buyers to sell to
        if raw and x >= 1.2 and raw.get("liq", 0) > 0 and now - p.get("_liq_ts", 0) > 20:
            share = p["tokens_left"] * p["last_price_sol"] / raw["liq"]
            if share >= 0.06:
                p["_liq_ts"] = now
                return _clip(1 - 0.04 / share, 0.2, 0.8), f"trimmed — position was {share * 100:.0f}% of the pool's liquidity"
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
            trail = _clip(((pb or {}).get("trail") or (0.30 if peak_x < 2 else 0.25 if peak_x < 5 else 0.18)) * self.trail_mult, 0.08, 0.5)
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
        if hit and ev and age > 60 and x < 1.1 and hit["v"] < max(4.0, ev * 0.4) and self.exit_on(p, "thesis"):
            return self._exit(p, 1.0, f"thesis broken (value {ev:.0f} → {hit['v']:.0f})", "early")
        if self.smart_selling(p["mint"]) >= 2 and x < 1.3:
            return self._exit(p, 1.0, "top wallets are leaving", "smart")
        tape = getattr(L, "trades", None) if L is not None else None
        if tape and age > 90 and x < 1.2 and now - tape[-1][0] > 120 * self.patience and self.exit_on(p, "dried"):
            return self._exit(p, 1.0, f"volume dried up (no trades for {now - tape[-1][0]:.0f}s)", "early")
        stall = agg["stall_s"] * self.patience
        last_high = p.setdefault("_high_ts", p["opened"])
        if x > p.get("_best_x", 1.0) * 1.02:                               # a real new high (+2%), not just sitting flat
            p["_best_x"], p["_high_ts"] = x, now
        elif now - last_high > stall and x < 1.15 and age > stall and self.exit_on(p, "stalled"):
            return self._exit(p, 1.0, f"stalled (no new high in {stall / 60:.0f} min)", "early")
        tmax = (float(pb["max_s"]) if pb else agg["time_s"]) * self.patience
        if age > tmax and x < 1.3:
            return self._exit(p, 1.0, f"{tmax / 60:.0f}-min time stop", "early")
        return None

    def scalp_exit(self, p: dict[str, Any], f: dict[str, float], raw: dict[str, float] | None, hit: dict[str, Any] | None,
                   x: float, age: float, peak_x: float = 1.0) -> tuple[float, str] | None:
        """In and out: bank the move, cut the miss, never let a scalp turn into a bag. Power trades get room to run."""
        sc = {**(self.scalp_cfg() or AGGRESSION["hyper"]["scalp"]), **(p.get("exits") or {})}
        name = "snipe" if p.get("style") == "snipe" else "scalp" if p.get("style") == "scalp" else (p.get("exits") or {}).get("preset") or "trade"
        if x <= 1 - sc["stop"]:
            return self._exit(p, 1.0, f"{name} stop −{(1 - x) * 100:.0f}%", "scalp")
        if sc.get("power") and peak_x >= 1.15 and x <= peak_x * (1 - POWER["trail"]):
            return self._exit(p, 1.0, f"power {name}: trailing stop after {peak_x:.2f}× — banked {x:.2f}×", "scalp")
        if sc.get("trail") and sc.get("arm") and peak_x >= sc["arm"] and x <= peak_x * (1 - sc["trail"]):
            return self._exit(p, 1.0, f"{sc.get('preset') or name} playbook: trailing stop after {peak_x:.2f}× — banked {x:.2f}×", "scalp")
        if x >= sc["tp"]:
            if sc.get("power") and self.power(f):                        # still flooding in: let it keep running on the trail
                return None
            return self._exit(p, 1.0, f"{name} take-profit +{(x - 1) * 100:.0f}%", "scalp")
        flipped = raw is not None and (raw.get("net_30s", 0) < 0 or f.get("mom_30s", 0) < 0)
        if x >= 1.07 and flipped and self.exit_on(p, "momentum"):   # after the ~2% it costs to sell, +4% was ~nothing
            return self._exit(p, 1.0, f"scalp: momentum flipped — banked +{(x - 1) * 100:.0f}%", "scalp")
        if hit and self.dn_hot(hit["dn"]) and self.exit_on(p, "dumpodds"):
            return self._exit(p, 1.0, f"scalp: dump odds {hit['dn'] * 100:.0f}% — out at {x:.2f}×", "scalp")
        if raw and raw.get("quiet_s", 0) > 25 and x < 1.03 and self.exit_on(p, "quiet"):
            return self._exit(p, 1.0, "scalp: the tape went quiet", "scalp")
        if age > sc["max_s"] * 0.5 and x < 1.0 and f.get("mom_30s", 0) <= 0 and self.exit_on(p, "notworking"):
            return self._exit(p, 1.0, f"scalp not working ({x:.2f}× after {age:.0f}s)", "scalp")
        if age > sc["max_s"]:
            return self._exit(p, 1.0, f"scalp time's up ({x:.2f}× after {age:.0f}s)", "scalp")
        return None

    def exit_on(self, p: dict[str, Any], rule: str, check_only: bool = False) -> bool:
        """The exit auditor's switch: a discretionary exit rule that keeps doing WORSE than simply following the trade's
        playbook is muted (30 min, then retested). Safety exits (stops, rug signals, playbook targets) are never muted."""
        if self.council.exit_muted(rule):
            return False
        if not check_only:
            p["_exit_rule"] = rule
        return True

    @staticmethod
    def _exit(p: dict[str, Any], frac: float, reason: str, kind: str) -> tuple[float, str]:
        p["_exit_kind"] = kind
        return frac, reason

    def post_mortem(self, now: float) -> list[tuple[str, str]]:
        """After a stop or trailing exit it keeps watching: were the stops right, or did it get shaken out?"""
        launches = self.ap.sniper.launches
        out = []
        for key, w in list(self.post.items()):
            mint = w.get("mint", key)
            L = launches.get(mint)
            if L is not None and L.mcap_sol:
                w["max"], w["min"] = max(w["max"], L.mcap_sol), min(w["min"], L.mcap_sol)
            if now - w["ts"] < w.get("horizon", 900) and L is not None:
                continue
            self.post.pop(key)
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
            elif w["kind"] == "skeptic":                              # the skeptic pulled the plug — was it right?
                w["lesson"] = self.council.plug_lesson(w["max"] >= w["exit"] * 1.25, dumped or w["max"] <= w["exit"] * 1.05,
                                                       w["symbol"], w["max"] / w["exit"])
            elif w["kind"] == "scalp":                                # was the scalp exit well timed?
                a = self.scalp_adj
                if w.get("why", "").startswith("scalp stop"):
                    if w["max"] >= w["entry"] * 1.15:
                        a["stop"] = min(0.08, a["stop"] + 0.003)         # stopped out of a coin that then ran: a little more room
                    elif dumped:
                        a["stop"] = max(-0.03, a["stop"] - 0.002)
                elif w["max"] >= w["exit"] * 1.25:
                    a["tp"] = min(0.2, a["tp"] + 0.005)                  # banked too early: aim a little higher
                elif w["max"] <= w["exit"] * 1.03:
                    a["tp"] = max(-0.04, a["tp"] - 0.002)                # the move was over: bank sooner
            elif w["kind"] == "model":                                # the timing model called a dump
                if w["max"] >= w["exit"] * 1.3:
                    self.dn_margin = min(0.35, self.dn_margin + 0.02)
                    self.exit_stats["model_wrong"] = self.exit_stats.get("model_wrong", 0) + 1
                    w["lesson"] = f"🤔 The timing model sold ${w['symbol']} and it ran {w['max'] / w['exit']:.1f}× — it needs a clearer signal now (+{self.dn_margin * 100:.0f} pts)."
                elif dumped or w["min"] <= w["exit"] * 0.85:
                    self.dn_margin = max(0.04, self.dn_margin - 0.01)
                    self.exit_stats["model_right"] = self.exit_stats.get("model_right", 0) + 1
            elif w["kind"] == "grad":                                 # sold part into a graduation
                if w["max"] >= w["exit"] * 1.5:
                    self.grad_frac = max(0.2, self.grad_frac * 0.9)
                    w["lesson"] = f"🎓 ${w['symbol']} kept running after graduating — selling less into migrations ({self.grad_frac * 100:.0f}%)."
                elif dumped:
                    self.grad_frac = min(0.9, self.grad_frac * 1.06)
                    w["lesson"] = f"🎓 ${w['symbol']} dumped after graduating — selling more into migrations ({self.grad_frac * 100:.0f}%)."
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
        council_notes = self.council.on_close(p, mult, f if isinstance(f, dict) else None)
        self.pnl_log.append((time.time(), p["sol_out"] - p["sol_in"]))
        tr = self.council.track.get(f"p:{p['id']}")
        if tr is not None:                                           # the auditor compares this exit to the playbook's
            tr["real_net"], tr["rule"] = mult - 1, p.get("_exit_rule")
        akey = p.get("strat") or ("snipe:mid" if p.get("style") == "snipe" else p.get("style") or "swing")
        am = self.alloc.book(akey, mult - 1, p["sol_out"] - p["sol_in"], probe=bool(p.get("probe")))
        if am:
            council_notes.append(am)
        rugged = 1.0 if (mult <= 0.45 or reason.startswith("rug")) else 0.0
        notes = list(council_notes)
        scalp = p.get("style") in ("scalp", "snipe") or trig in ("scalp", "snipe")
        snipe = p.get("style") == "snipe" or trig == "snipe"
        now = time.time()
        prev = self.last_exit.get(p["mint"]) or (0, 0)
        self.last_exit[p["mint"]] = (now, prev[1] + 1 if mult < 1 else 0)
        if len(self.last_exit) > 5000:
            self.last_exit = {m: v for m, v in self.last_exit.items() if v[0] > now - 3600}
        # --- mood: a tiny scalp moves it a little, a real position a lot ---
        r = _clip(mult - 1, -1.0, 1.5)
        wgt = 0.2 if scalp else 1.0
        if mult < 1:
            self.mood = max(0.35, self.mood - wgt * ((0.06 + 0.12 * min(1.0, -r)) + (0.06 if rugged else 0)))
        else:
            self.mood = min(1.3, self.mood + wgt * (0.04 + 0.08 * (r / 1.5)))
        if scalp:
            self.scalp_streak = (min(0, self.scalp_streak) - 1) if mult < 1 else (max(0, self.scalp_streak) + 1)
            book = self.snipes if snipe else self.scalps
            book["n"] += 1
            book["wins"] += int(mult > 1)
            book["pnl_sol"] = round(book["pnl_sol"] + (p["sol_out"] - p["sol_in"]), 6)
            self.fast_ts.append(now)
            self.scalp_hist.append(mult - 1)
            h = list(self.scalp_hist)[-20:]
            if len(h) >= 10:                                              # the scalper tunes its own bar from its results
                avg, wr = sum(h) / len(h), sum(1 for z in h if z > 0) / len(h)
                a = self.scalp_adj
                if avg < -0.005:
                    a["bar"] = min(0.3, a["bar"] + 0.01)
                elif avg > 0.01 and wr >= 0.5:
                    a["bar"] = max(-0.15, a["bar"] - 0.01)
            if self.scalp_streak <= -8 and -self.scalp_streak % 4 == 0:
                self.cool_until = max(self.cool_until, now + 60)
                notes.append(f"🥶 {-self.scalp_streak} scalps in a row lost — a 1-minute breather and a higher scalp bar.")
        elif mult < 1:
            self.streak = min(0, self.streak) - 1
        else:
            self.streak = max(0, self.streak) + 1
        if not scalp and self.streak <= -4 and -self.streak % 3 == 1:   # 4, 7, 10… in a row
            cool = AGGRESSION[self.aggression]["cool_s"]
            self.cool_until = time.time() + cool
            notes.append(f"😞 {-self.streak} losses in a row — cooling off {cool / 60:.1f} min (only top-10 wallet copies), "
                         f"then back in with a higher bar.")
        elif not scalp and self.streak == 3:
            notes.append("🔥 3 wins in a row — confidence up, sizing back up.")
        if not scalp:
            self.recent_exits.append("stop" if reason.startswith("stop") else "rug" if rugged else "win" if y else "other")
        stops = sum(1 for e in self.recent_exits if e == "stop")
        if not scalp and stops >= 6 and len(self.recent_exits) >= 8 and self.rng.random() < 0.34:
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
        if L is not None and L.mcap_sol and kind in ("stop", "trail", "early", "smart", "model", "scalp", "skeptic"):
            self.post[p["mint"]] = {"ts": time.time(), "kind": kind, "symbol": p["symbol"], "why": reason,
                                    "horizon": 300 if kind == "scalp" else 900,
                                    "entry": p.get("entry_mcap_sol") or L.mcap_sol, "exit": L.mcap_sol, "max": L.mcap_sol, "min": L.mcap_sol}
        lesson = "no features recorded"
        pred = None
        if f and scalp:                         # a scalp is a lesson about the next minute: it teaches the timing models
            self.up.step(f, 1.0 if mult > 1.02 else 0.0, LR_TRADE * 0.5)
            self.dn.step(f, 1.0 if mult < 0.95 else 0.0, LR_TRADE * 0.5)
            self.rug.step(f, rugged, LR_SHADOW)
            tags = pat.tags(f, "scalp")
            self._tag_update(tags, 1.0 if mult > 1.0 else 0.0, pnl_pct, 0.3)
            notes.extend(self.pattern_lessons(tags))
            self.cache.clear()
        elif f:
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
        if scalp and (self.scalps["n"] + self.snipes["n"]) % 20:                      # scalps are many: save every 20th, and the sell note says it all
            for n in notes:
                await self.note("learn", n, mint=p["mint"])
            return
        await self.save()
        if scalp:
            await self.note("learn", f"⚡ Fast trades: {self.snipes['n']} snipes ({self.snipes['wins'] / max(1, self.snipes['n']) * 100:.0f}% won, "
                                     f"◎{self.snipes['pnl_sol']:+.3f}) · {self.scalps['n']} scalps ({self.scalps['wins'] / max(1, self.scalps['n']) * 100:.0f}% won, "
                                     f"◎{self.scalps['pnl_sol']:+.3f}) · {sum(1 for t in self.fast_ts if t > now - 3600)} in the last hour.")
            for n in notes:
                await self.note("learn", n, mint=p["mint"])
            return
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
        self.last_eq = eq
        self.peak_equity = max(self.peak_equity, eq)
        dd = 1 - eq / self.peak_equity if self.peak_equity else 0.0
        if dd >= 0.3 and self.drawdown < 0.3:
            await self.note("learn", f"📉 Down {dd * 100:.0f}% from my high (◎{self.peak_equity:.2f}) — trading smaller and pickier until I recover.")
        self.drawdown = dd
        await self.ap.db.exec("INSERT INTO auto_equity (ts, mode, equity) VALUES (?,?,?)", (now, "auto", eq))

    # ---------------- reads ----------------
    def public_candidates(self) -> list[dict[str, Any]]:
        return [{k: c.get(k) for k in ("mint", "symbol", "value", "p_rug", "p_up", "p_dn", "scalp", "hard", "why", "mcap_usd", "age_s", "tier", "copy_ranks")}
                for c in self.candidates]

    def verdict(self) -> dict[str, Any]:
        """Plain-English: is it trading, and if not, exactly which stage of the pipeline is empty."""
        ap, p, now = self.ap, self.pipe, time.time()
        mode = ap.c.get("mode")
        pump = getattr(getattr(ap.tracker, "pump", None), "ws", "n/a")
        subs = len(getattr(getattr(ap.tracker, "pump", None), "token_subs", ()) or ())
        idle = now - self.last_buy_ts if self.last_buy_ts else None
        top_skip = max((self.skips or self.skips_prev or {"": 0}).items(), key=lambda kv: kv[1])[0]
        fs = ap.tracker.feed_status() if hasattr(ap.tracker, "feed_status") else {}
        info = {"mode": mode, "pumpportal_connected": None if pump == "n/a" else pump is not None, "trade_feed": fs,
                "trade_subs": subs, "idle_s": round(idle) if idle is not None else None, "top_skip": top_skip, **p}
        def out(state: str, text: str) -> dict[str, Any]:
            return {"state": state, "text": text, **info}
        if mode != "auto" and not (mode == "real" and ap.c.get("real_engine") == "brain"):
            return out("off", f"Self-driving isn't running (Autopilot mode is '{mode}'). Press Start or pick a level.")
        if not p or now - p.get("ts", 0) > 15:
            return out("stalled", "The brain hasn't run for a while — the Autopilot loop is stuck. See the engine error below.")
        if pump is None:
            return out("feed", "Not connected to PumpPortal — no launches or trades can arrive. Check the Health page.")
        if not p.get("launches_60s"):
            return out("feed", "No new pump.fun launches reached the server in the last minute (PumpPortal). Check the Health page.")
        if p.get("newborn") and not p.get("newborn_traded"):
            ch = fs.get("chain") or {}
            if not fs.get("pumpportal_key") and fs.get("chain_running"):
                how = (f"PumpPortal's trade stream needs an API key since May 2026, so Radar switched to the free on-chain trade feed "
                       f"({ch.get('endpoint')}: {'connected' if ch.get('connected') else 'connecting…'}, {ch.get('decoded', 0)} trades decoded). "
                       f"If it stays at 0, connect Helius on Connectors (its websocket is far more reliable than the public RPC) or add a "
                       f"PumpPortal API key.")
            elif not fs.get("pumpportal_key"):
                how = ("PumpPortal only streams trades to connections with an API key since May 2026. Radar starts its free on-chain trade "
                       "feed within a minute — or add a PumpPortal API key on Connectors (its wallet needs ≥ 0.02 SOL).")
            else:
                how = ("A PumpPortal key is set but no trades arrive — check that its linked wallet holds ≥ 0.02 SOL (PumpPortal bills "
                       "0.01 SOL per 10,000 trades).")
            return out("feed", f"{p['newborn']} new launches arrived but none of their trades did ({subs} subscribed). {how}")
        if p.get("blocked"):
            return out("blocked", f"Not buying: {p['blocked']}.")
        if idle is not None and idle < 60:
            return out("trading", f"Trading — last buy {idle:.0f}s ago.")
        if p.get("snipe_candidates") == 0 and not p.get("scalpable"):
            return out("nothing", f"Launches and trades are arriving ({p.get('newborn_traded', 0)} new coins trading), but none pass the "
                                  f"snipe / scalp read yet. Most common reason: {top_skip or 'n/a'}.")
        return out("waiting", f"Candidates are there (best snipe {p.get('best_snipe')}, bar {self.bars.get('snipe')}) but every one was "
                              f"blocked — most common reason: {top_skip or 'n/a'}.")

    async def report(self) -> dict[str, Any]:
        """Its own read of its live results: the last 300 closed trades by strategy, by exit reason and by hold time."""
        now = time.time()
        if self._report and now - self._report[0] < 10:
            return self._report[1]
        rows = await self.ap.db.all("SELECT sol_in, sol_out, exit_reason, features_json, opened, closed FROM auto_positions "
                                    "WHERE mode='auto' AND status='closed' ORDER BY closed DESC LIMIT 300")
        def bucket(groups: dict[str, list], k: str, net: float, pnl: float) -> None:
            groups.setdefault(k, []).append((net, pnl))
        by_s: dict[str, list] = {}
        by_x: dict[str, list] = {}
        by_h: dict[str, list] = {}
        for r in rows:
            if not r["sol_in"]:
                continue
            net, pnl = r["sol_out"] / r["sol_in"] - 1, r["sol_out"] - r["sol_in"]
            try:
                meta = json.loads(r["features_json"] or "{}") or {}
            except ValueError:
                meta = {}
            bucket(by_s, meta.get("strat") or meta.get("style") or "?", net, pnl)
            reason = (r["exit_reason"] or "?").split(" —")[0].split(" (")[0].split(":")[0]
            bucket(by_x, " ".join(reason.split()[:3]), net, pnl)
            held = (r["closed"] or now) - (r["opened"] or now)
            bucket(by_h, "<30s" if held < 30 else "30-90s" if held < 90 else "1.5-5m" if held < 300 else "5-15m" if held < 900 else "15m+", net, pnl)
        def table(g: dict[str, list]) -> list[dict[str, Any]]:
            out = [{"key": k, "n": len(v), "win_pct": round(sum(1 for n, _ in v if n > 0) / len(v) * 100), "avg_pct": round(sum(n for n, _ in v) / len(v) * 100, 2),
                    "sol": round(sum(p for _, p in v), 4)} for k, v in g.items()]
            return sorted(out, key=lambda r: r["sol"])
        rep_ = {"trades": len(rows), "by_strategy": table(by_s), "by_exit": table(by_x)[:12], "by_hold": table(by_h)}
        self._report = (now, rep_)
        return rep_

    _report: tuple[float, dict[str, Any]] | None = None

    def _safe_verdict(self) -> dict[str, Any]:
        try:
            return self.verdict()
        except Exception as e:  # noqa: BLE001
            return {"state": "unknown", "text": f"diagnostics failed: {e}"}

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
                "learning": {"lessons_per_hour": per_hour, "replay": len(self.replay) + len(self.replay_t), "rehearsed": self.rehearsed,
                             "models": 4, "signals": len(KEYS)},
                "timing": {"up": self.up.stats(), "down": self.dn.stats(), "pending": len(self.tsnap), "dn_margin": round(self.dn_margin * 100), "market": ({"coins": self.mkt["n"], "dn_med": round(self.mkt["dn_med"] * 100),
                                                                          "up_med": round(self.mkt["up_med"] * 100)} if self.mkt else None),
                           "grad_frac": round(self.grad_frac * 100), "active": self.up.n >= 400,
                           "up_top": [{"key": k, "label": LABELS[k], "w": round(v, 2)} for k, v in sorted(self.up.w.items(), key=lambda kv: -kv[1])[:5]],
                           "dn_top": [{"key": k, "label": LABELS[k], "w": round(v, 2)} for k, v in sorted(self.dn.w.items(), key=lambda kv: -kv[1])[:5]]},
                "mood": self.mood_public(), "patterns": self.patterns_public(),
                "scalper": ({**self.scalps, **{k: round(v, 3) for k, v in (self.scalp_cfg() or {}).items()}, "on": bool(self.scalp_cfg()),
                             "open": sum(1 for p in self.ap.open.values() if p.get("style") == "scalp"),
                             "riding": sum(1 for p in self.ap.open.values() if p.get("ride")), "streak": self.scalp_streak,
                             "recent_pct": round(sum(self.scalp_hist) / len(self.scalp_hist) * 100, 2) if self.scalp_hist else None}),
                "verdict": self._safe_verdict(),
                "nebula": self.council.snapshot(), "allocator": self.alloc.snapshot(), "heat": self.heat_mult(), "report": await self.report(),
                "breaker": {"active": time.time() < self.brk_until, "why": self.brk_why if time.time() < self.brk_until else None,
                            "resume_s": max(0, round(self.brk_until - time.time())), "trips": self.breaker_trips},
                "bars": {k: round(v * 100) for k, v in self.bars.items()}, "idle_s": round(now - self.last_buy_ts) if self.last_buy_ts else None,
                "snipes": {**self.snipes, "on": bool(AGGRESSION[self.aggression].get("snipe")),
                           "per_hour": sum(1 for t in self.fast_ts if t > now - 3600),
                           "open": sum(1 for p in self.ap.open.values() if p.get("style") == "snipe"),
                           "power_open": sum(1 for p in self.ap.open.values() if (p.get("exits") or {}).get("power"))},
                "compound": {"start": DEMO_START_SOL, "growth_pct": round(((await self.ap.demo_balance("auto")) / DEMO_START_SOL - 1) * 100, 2)},
                "skips": dict(sorted({**self.skips_prev, **self.skips}.items(), key=lambda kv: -kv[1])[:8]),
                "exits": {"stop_pct": round(self.stop_pct() * 100), "trail_mult": round(self.trail_mult, 2), **self.exit_stats,
                          "watching": len(self.post), "patience": round(self.patience, 2), "smart_follow": round(self.smart_follow, 2),
                          "copied_sells": self.copied_sells, "ladder": [f"{f * 100:.0f}% at {m:g}×" for m, f, _ in LADDERS[AGGRESSION[self.aggression]["ladder"]]]},
                "benched": [{"wallet": w, "n": s["n"], "wins": s["w"], "until": s["bench_until"]} for w, s in self.leaders.items()
                            if s.get("bench_until", 0) > now][:10],
                "blocked_devs": len(self.bad_devs),
                "weights": [{"key": k, "label": LABELS[k], "w": round(v, 3), "prior": PRIORS[k]} for k, v in
                            sorted(self.win.w.items(), key=lambda kv: -abs(kv[1]))],
                "candidates": self.public_candidates(), "log": list(self.log)[:150], "equity": eq[::-1], "copies": copies,
                "diag": self.diag, "sizing": self.stats_cache, "last_error": self.last_error, "refills": getattr(self, "refills", 0),
                "engine_error": (self.ap.stats or {}).get("last_error"),
                "balance": await self.ap.demo_balance("auto"), "summary": await self.ap.summary("auto")}
