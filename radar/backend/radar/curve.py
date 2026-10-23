"""pump.fun bonding-curve maths — exact fills for demo trades, ghost trades and position marks.

The curve is constant product on virtual reserves: vsol · vtok = K, starting at 30 SOL / 1.073B tokens, so price per token
is vsol² / K and market cap (1B supply) is vsol² · 1e9 / K. Buying s SOL at reserves v gets K/v − K/(v+s) tokens, and those
tokens sell back for exactly s if nobody else traded — on the curve, price impact is NOT a round-trip cost, only the fees are.
A linear "impact on the way in AND on the way out" model double-charges it, and marking a position at the pre-buy price
makes every trade start several % down (instant stop-outs on bigger sizes). This module replaces both.
"""
from __future__ import annotations

import math

K = 30.0 * 1_073_000_000            # SOL · tokens
CURVE0 = 30.0
CURVE_END = 115.0                    # ~85 real SOL in: the coin graduates off the curve
FEE = 0.015                          # pump.fun 1% + router 0.5%, each way


def vsol_from_mcap(mcap_sol: float | None) -> float | None:
    if not mcap_sol or mcap_sol <= 0:
        return None
    return math.sqrt(mcap_sol * K / 1e9)


def on_curve(vsol: float | None) -> bool:
    return bool(vsol) and CURVE0 * 0.98 <= vsol < CURVE_END


def tokens_for(v: float, sol: float) -> float:
    """Tokens out for `sol` (after fees) going into a curve holding `v` virtual SOL."""
    return K / v - K / (v + sol)


def sol_for(w: float, q: float) -> float:
    """SOL out (before fees) for selling `q` tokens into a curve holding `w` virtual SOL."""
    return max(0.0, w - K / (K / w + q))


def liquidation_px(v_market: float, our_sol: float, tokens: float) -> float:
    """SOL per token if the whole position were sold now (before the exit fee). `v_market` is the curve as everyone else
    left it; our own SOL still sitting in the curve (`our_sol`) is added back, as it would be on the real chain."""
    if tokens <= 0:
        return 0.0
    return sol_for(v_market + our_sol, tokens) / tokens


def round_trip(v0: float, v1: float, size: float, prio: float = 0.0005) -> float:
    """Net multiple on `size` SOL bought at reserves v0 and fully sold at reserves v1 (both as the market left them),
    after both fees and both priority fees. 1.0 = break even."""
    s = size * (1 - FEE)
    q = tokens_for(v0, s)
    got = sol_for(v1 + s, q) * (1 - FEE) - prio
    return got / (size + prio)
