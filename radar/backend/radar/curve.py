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
# graduated coins trade in a PumpSwap constant-product pool seeded with ~79 SOL and ~206.9M tokens; with k fixed by swaps the
# pool's SOL side follows from the price alone (R = √(price·k)), the same shape as the curve with a different constant
K_AMM = 79.0 * 206_900_000
FEE_AMM = 0.008                      # PumpSwap ~0.3% (LP + protocol + creator) + router 0.5%, each way


def vsol_from_mcap(mcap_sol: float | None, k: float = K) -> float | None:
    if not mcap_sol or mcap_sol <= 0:
        return None
    return math.sqrt(mcap_sol * k / 1e9)


def pool(mcap_sol: float | None, graduated: bool) -> tuple[float, float, float] | None:
    """(k, SOL-side reserve, fee) of the market this coin trades in right now, or None when the price is unknown."""
    if graduated:
        r = vsol_from_mcap(mcap_sol, K_AMM)
        return (K_AMM, r, FEE_AMM) if r else None
    v = vsol_from_mcap(mcap_sol)
    if v is None:
        return None
    if v >= CURVE_END:                                  # past the curve's end but not marked graduated yet: treat as the pool
        r = vsol_from_mcap(mcap_sol, K_AMM)
        return (K_AMM, r, FEE_AMM) if r else None
    return (K, v, FEE)


def on_curve(vsol: float | None) -> bool:
    return bool(vsol) and CURVE0 * 0.98 <= vsol < CURVE_END


def tokens_for(v: float, sol: float, k: float = K) -> float:
    """Tokens out for `sol` (after fees) going into a market holding `v` (virtual) SOL."""
    return k / v - k / (v + sol)


def sol_for(w: float, q: float, k: float = K) -> float:
    """SOL out (before fees) for selling `q` tokens into a market holding `w` (virtual) SOL."""
    return max(0.0, w - k / (k / w + q))


def liquidation_px(v_market: float, our_sol: float, tokens: float, k: float = K) -> float:
    """SOL per token if the whole position were sold now (before the exit fee). `v_market` is the market as everyone else
    left it; our own SOL still sitting in it (`our_sol`) is added back, as it would be on the real chain."""
    if tokens <= 0:
        return 0.0
    return sol_for(v_market + our_sol, tokens, k) / tokens


def round_trip(v0: float, v1: float, size: float, prio: float = 0.0005, k: float = K, fee: float = FEE) -> float:
    """Net multiple on `size` SOL bought at reserves v0 and fully sold at reserves v1 (both as the market left them),
    after both fees and both priority fees. 1.0 = break even."""
    s = size * (1 - fee)
    q = tokens_for(v0, s, k)
    got = sol_for(v1 + s, q, k) * (1 - fee) - prio
    return got / (size + prio)
