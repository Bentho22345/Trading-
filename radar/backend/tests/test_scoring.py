import copy

from radar import scoring
from radar.cfg import load_yaml
from radar.paper import simulate, stats

CFG = load_yaml("scoring.yaml")
RISK = {"bankroll_usd": 1000, "max_pct_per_trade": 2}

STRONG = {
    "token": {"address": "X", "symbol": "HAWK", "price_usd": 0.001, "market_cap": 500_000, "liquidity_usd": 120_000,
              "vol_h24": 600_000, "vol_h1": 150_000, "buys_m5": 300, "sells_m5": 100, "boost_amount": None},
    "safety": {"mint_authority": "", "freeze_authority": "", "lp_locked_pct": 100, "top10_pct": 12, "insiders_detected": 0,
               "score_normalised": 1, "rugged": 0},
    "narrative": {"id": 1, "title": "hawk tuah", "stage": "ignition", "vel_5m": 8, "sources": ["x", "telegram", "reddit"],
                  "reach_score": 90, "bot_share": 0.0, "vip_mention": True, "vip_ca_match": True, "category": "celebrity",
                  "expected_life_h": 48, "first_seen": 0},
    "smart_money": {"tracking": True, "smart_buyers": 3, "kol_selling": False},
    "regime": {"btc_chg_24h": 1.0, "sol_chg_24h": 2.0, "fear_greed": 60},
    "dev": {"tokens": 1, "rugged_tokens": 0},
    "ticks": [{"price_usd": 0.0005 + i * 0.00003, "liquidity_usd": 80_000 + i * 2000} for i in range(12)],
}


def test_strong_setup_is_buy_with_plan():
    r = scoring.evaluate(STRONG, CFG, RISK, now=1000)
    assert r["verdict"] == "BUY", r
    assert r["score"] >= CFG["verdict"]["buy_min_score"] and r["confidence"] == "high" and r["risk_grade"] in "AB"
    p = r["plan"]
    assert p["size_usd"] == 20 and p["stop_price"] == 0.001 * 0.7
    assert p["ladder"][0] == {"multiple": 2.0, "sell_fraction": 0.5, "price": 0.002}
    assert r["reasons"]


def test_active_mint_authority_is_always_avoid():
    inp = copy.deepcopy(STRONG)
    inp["safety"]["mint_authority"] = "Auth111"
    r = scoring.evaluate(inp, CFG, RISK)
    assert r["verdict"] == "AVOID" and r["risk_grade"] == "F"
    assert "Mint authority is active" in r["vetoes"]
    # even with every weight on non-safety inputs
    c = copy.deepcopy(CFG)
    c["weights"] = {"narrative": 1, "catalyst": 1, "momentum": 1, "smart_money": 1, "safety": 0}
    c["verdict"]["buy_min_score"] = 0
    assert scoring.evaluate(inp, c, RISK)["verdict"] == "AVOID"


def test_other_vetoes():
    for patch, msg in (({"freeze_authority": "F"}, "Freeze"), ({"top10_pct": 55}, "Top-10"), ({"rugged": 1}, "rugged")):
        inp = copy.deepcopy(STRONG)
        inp["safety"].update(patch)
        r = scoring.evaluate(inp, CFG, RISK)
        assert r["verdict"] == "AVOID" and any(msg in v for v in r["vetoes"])
    inp = copy.deepcopy(STRONG)
    inp["token"]["liquidity_usd"] = 500
    assert scoring.evaluate(inp, CFG, RISK)["verdict"] == "AVOID"
    inp = copy.deepcopy(STRONG)
    inp["dev"] = {"tokens": 5, "rugged_tokens": 2}
    assert scoring.evaluate(inp, CFG, RISK)["verdict"] == "AVOID"


def test_no_safety_report_cannot_be_buy_and_fading_hurts():
    inp = copy.deepcopy(STRONG)
    inp["safety"] = None
    assert scoring.evaluate(inp, CFG, RISK)["verdict"] != "BUY"
    inp = copy.deepcopy(STRONG)
    inp["narrative"]["stage"] = "fading"
    assert scoring.evaluate(inp, CFG, RISK)["score"] < scoring.evaluate(STRONG, CFG, RISK)["score"]


def test_risk_off_regime_lowers_score():
    inp = copy.deepcopy(STRONG)
    inp["regime"] = {"btc_chg_24h": -6, "sol_chg_24h": -9, "fear_greed": 15}
    r = scoring.evaluate(inp, CFG, RISK)
    assert r["regime_multiplier"] == CFG["regime"]["risk_off_multiplier"]
    assert any("risk-off" in w for w in r["reasons"])


def test_paper_simulation_ladder_stop_timestop():
    ladder = [{"multiple": 2.0, "sell_fraction": 0.5}, {"multiple": 4.0, "sell_fraction": 0.25}]
    r = simulate(1.0, ladder, 0.7, 10_000, [(1, 1.5), (2, 2.1), (3, 1.2), (4, 0.6)], size=100)
    assert r["closed"] == 4 and r["exit_reason"] == "stop"
    assert round(r["realized_usd"], 2) == round(0.5 * 100 * 1.1 + 0.5 * 100 * -0.4, 2)
    r2 = simulate(1.0, ladder, 0.7, 3, [(1, 1.1), (3, 1.3)], size=100)
    assert r2["exit_reason"] == "time stop" and round(r2["return_pct"], 1) == 30.0
    r3 = simulate(1.0, ladder, 0.7, 99, [(1, 1.1)], size=100)
    assert r3["closed"] is None and round(r3["unrealized_usd"], 1) == 10.0
    s = stats([{"return_pct": 50}, {"return_pct": -30}, {"return_pct": -10}])
    assert s["n"] == 3 and s["hit_rate"] == 33.3 and s["max_drawdown_pct_pts"] == -40
