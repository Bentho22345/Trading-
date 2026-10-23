"""Exact pump.fun bonding-curve fills: impact comes back on the way out, only fees are lost."""
from radar import curve


def test_round_trip_on_a_flat_curve_costs_only_fees():
    for size in (0.1, 1.0, 5.0):                                       # even a big buy: the impact is returned when you sell
        rt = curve.round_trip(40.0, 40.0, size)
        assert 0.955 < rt < 0.972                                     # 2 × 1.5% fees (+ priority fees, which weigh more on tiny buys)
    assert curve.round_trip(40.0, 50.0, 1.0) > 1.2                     # the curve ran +25% in SOL → a real gain
    assert curve.round_trip(40.0, 36.0, 1.0) < 0.85


def test_mcap_and_reserves_agree():
    v = curve.vsol_from_mcap(27.96)
    assert abs(v - 30.0) < 0.01 and curve.on_curve(v) and not curve.on_curve(130.0)
    q = curve.tokens_for(40.0, 2.0)
    assert abs(curve.sol_for(42.0, q) - 2.0) < 1e-9                   # sell back into the curve you bought into: exactly your SOL
    assert abs(curve.liquidation_px(40.0, 2.0, q) * q - 2.0) < 1e-9


def test_demo_position_starts_at_fees_not_at_minus_impact(tmp_path):
    import asyncio

    from .test_autopilot import launch, make

    async def run():
        coin = launch("CURVmint" + "7" * 32, mcap_sol=40.0, upside=60, risk=10, buyers=40)
        coin.vsol = curve.vsol_from_mcap(40.0)
        ap, db = await make(tmp_path, [coin])
        p = await ap.buy(coin.mint, "brain", "test", coin.result, sol=3.0, mode="auto")   # ~8% of the curve's SOL
        await ap.manage()
        x = p["last_price_sol"] / p["entry_price_sol"]
        assert p["status"] == "open" and 0.98 < x < 0.99                 # just the entry fee; it used to start ~−8%
        await ap.sell(p, 1.0, "test")
        assert 0.96 < p["sol_out"] / p["sol_in"] < 0.975                 # round trip: both fees, impact returned
        await db.close()
    asyncio.run(run())


def test_a_demo_buy_lands_a_moment_later_at_that_moments_price(tmp_path):
    import asyncio

    from .test_autopilot import launch, make

    async def run():
        coin = launch("LATEmint" + "8" * 32, mcap_sol=40.0, upside=60, risk=10, buyers=40)
        ap, db = await make(tmp_path, [coin])
        ap.fill_latency = 1.0
        p = await ap.buy(coin.mint, "brain", "test", coin.result, sol=1.0, mode="auto")
        t0 = p["tokens"]
        assert p.get("fill_at")
        coin.mcap_sol = 46.0                                            # the coin ran while the order was in flight
        await ap.manage()
        assert p.get("fill_at") and p["tokens"] == t0                   # not landed yet: no exits, no re-fill
        p["fill_at"] -= 2
        await ap.manage()
        assert "fill_at" not in p and p["tokens"] < t0 * 0.9            # landed at the higher price: fewer tokens for the same SOL
        assert p["entry_mcap_sol"] == 46.0
        await db.close()
    asyncio.run(run())
