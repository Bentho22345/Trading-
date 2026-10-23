import json
import time

from radar.playbook import PRESETS, consensus, heuristic_rules
from radar.snipe_metrics import METRICS, appetite_score, matches, twitter_kind
from radar.sniper import Launch, analyze
from radar.tracker import is_mayhem


def test_mayhem_detected_by_flag_or_2b_supply():
    normal = {"vSolInBondingCurve": 30, "vTokensInBondingCurve": 1_073_000_000, "marketCapSol": 27.96}
    assert not is_mayhem(normal)
    assert is_mayhem({**normal, "marketCapSol": 55.9})          # 2B supply
    assert is_mayhem({**normal, "is_mayhem_mode": True})
    assert not is_mayhem({**normal, "isMayhemMode": False})
    assert not is_mayhem({"mint": "x"})                          # missing fields never flag


def test_holder_metrics_from_trade_stream():
    now = time.time()
    L = Launch(mint="M", created=now - 100, symbol="DOG", deployer="DEV", dev_tokens=50e6, dev_buy_sol=1.5, vsol=31.5)
    L.balances["DEV"] = 50e6
    L.metadata = {"twitter": "https://x.com/i/communities/123", "telegram": "https://t.me/x"}
    vs = 31.5
    for i in range(30):
        ts = now - 99 + i * 3
        w = f"W{i}"
        vs += 0.5
        L.trades.append((ts, "buy", 0.5, 10e6, w, vs))
        L.balances[w] = 10e6
        L.buyers[w] = ts
        L.buy_sol[w] = 0.5
        if ts - L.created <= 5:
            L.early.add(w)
    L.vsol = vs
    L.trades.append((now - 2, "sell", 1.5, 50e6, "DEV", vs - 1.5))
    L.dev_sold_tokens = 50e6
    L.balances["DEV"] = 0
    r = analyze(L, now, {"sol_usd": 150, "strategies": [{"id": "cto", "rules": next(p for p in PRESETS if p["id"] == "cto")["rules"]}]})
    m = r["metrics"]
    assert m["holders"] == 30 and m["top10_pct"] == 10.0 and m["dev_hold_pct"] == 0 and m["dev_sold"]
    assert m["x_community"] and m["socials"] == 2 and m["coverage_pct"] >= 80 and m["metrics_basis"] == "complete"
    assert "cto" in r["strategies"]
    assert r["upside"] > 0 and 0 <= r["risk"] <= 100
    assert r["scores"]["degen"] >= r["scores"]["balanced"] >= r["scores"]["safe"]


def test_partial_coverage_when_we_missed_trades():
    now = time.time()
    L = Launch(mint="P", created=now - 600, deployer="D", vsol=90)   # curve has 60 SOL in, we saw almost none
    L.trades.append((now - 5, "buy", 0.4, 1e6, "X", 90))
    L.balances["X"] = 1e6
    r = analyze(L, now, {})
    assert r["metrics"]["metrics_basis"] == "partial" and "partial data" in r["why_risk"]


def test_rule_engine_and_appetite():
    row = {"top10_pct": 25, "dev_sold": True, "holders": 40}
    assert matches([{"metric": "top10_pct", "op": "<=", "value": 30}, {"metric": "dev_sold", "op": "==", "value": True}], row)
    assert not matches([{"metric": "snipers_hold_pct", "op": "<=", "value": 20}], row)       # unknown metric never matches
    assert matches([{"metric": "holders", "op": ">=", "value": 100}, {"metric": "dev_sold", "op": "==", "value": True}], row, "any")
    assert appetite_score(60, 40, "degen") > appetite_score(60, 40, "safe")
    assert twitter_kind("https://x.com/i/communities/1") == "community" and twitter_kind("https://twitter.com/a/status/9") == "post"
    assert all(r["metric"] in METRICS for p in PRESETS for r in p["rules"])


def test_parser_extracts_common_phrasings():
    rules = {(r["metric"], r["op"]): r["value"] for r in heuristic_rules(
        "My filters: top 10 holders under 30%, dev holds less than 5%, bundlers below 10%, snipers under 20%, at least 50 holders, "
        "market cap under $20k, and only if the dev sold. Must have a twitter link.")}
    assert rules[("top10_pct", "<=")] == 30 and rules[("dev_hold_pct", "<=")] == 5 and rules[("bundle_hold_pct", "<=")] == 10
    assert rules[("snipers_hold_pct", "<=")] == 20 and rules[("holders", ">=")] == 50 and rules[("mcap_usd", "<=")] == 20000
    assert rules[("dev_sold", "==")] is True and rules[("has_twitter", "==")] is True


def test_consensus_is_weighted_median_with_support():
    src = lambda rules, views=0: {"rules_json": json.dumps(rules), "views": views}  # noqa: E731
    r = lambda v: {"metric": "top10_pct", "op": "<=", "value": v}  # noqa: E731
    out = consensus([src([r(30)]), src([r(25)]), src([r(10)], 1_000_000), src([{"metric": "dev_sold", "op": "==", "value": True}]),
                     src([r(30)])])
    top = next(x for x in out if x["metric"] == "top10_pct")
    assert top["support"] == 4 and top["value"] in (25, 30)
    assert not any(x["metric"] == "dev_sold" for x in out)       # only one of 5 sources: below the support bar


def test_parser_reads_avoid_and_red_flag_phrasing():
    a = {(r["metric"], r["op"]): r["value"] for r in heuristic_rules("Avoid tokens where bundled wallets control more than 10% of the supply.")}
    b = {(r["metric"], r["op"]): r["value"] for r in heuristic_rules("Multiple sniper wallets holding over 20% combined is a red flag.")}
    assert a[("bundle_hold_pct", "<=")] == 10 and b[("snipers_hold_pct", "<=")] == 20
