import time

from radar.charts import bucket_trades, merge
from radar.sniper import Launch, analyze


def runner(now: float) -> Launch:
    L = Launch(mint="M", created=now - 120, symbol="RUN", name="Runner", deployer="DEV", dev_tokens=3e7, vsol=31.0)
    vsol = 31.0
    for i in range(40):
        ts = now - 100 + i * 2.5
        vsol += 1.2
        L.trades.append((ts, "buy", 0.2 + (i % 7) * 0.13, 1e6, f"W{i}", vsol))
        L.buyers[f"W{i}"] = ts
        L.buy_sol[f"W{i}"] = 0.2 + (i % 7) * 0.13
    L.vsol = vsol
    L.mcap_sol = vsol * 0.97
    L.dev = {"launches": 3, "graduated": 1, "best_peak_usd": 250_000}
    return L


def test_runner_scores_high_with_eta_and_organic_flow():
    now = time.time()
    L = runner(now)
    L.alpha.append({"wallet": "W5", "rank": 42, "ts": now - 90, "sol": 0.5})
    r = analyze(L, now, {"sol_usd": 150})
    keys = {d["key"]: d for d in r["detectors"]}
    assert r["tier"] == "SNIPE" and r["score"] >= 60
    assert keys["alpha"]["points"] == 25
    assert r["eta_min"] is not None and 0 < r["eta_min"] < 30      # 1.2 vSOL per 2.5s ≈ 29 SOL/min, ~67 SOL to go
    assert not r["bundled"] and keys["organic"]["good"]
    assert keys["dev"]["points"] > 0
    assert r["mcap_usd"] == round(L.mcap_sol * 150)


def test_bundle_and_dev_dump_are_traps():
    now = time.time()
    L = runner(now)
    for i in range(6):   # six wallets in the creation second, same size
        L.trades.appendleft((L.created + 0.5, "buy", 2.0, 5e7, f"B{i}", 40.0))
        L.buyers[f"B{i}"] = L.created + 0.5
        L.buy_sol[f"B{i}"] = 20.0
    r = analyze(L, now, {})
    assert r["bundled"] and r["tier"] == "TRAP" and "bundled launch" in r["flags"]

    L2 = runner(now)
    L2.dev_sold_tokens = 2.5e7
    r2 = analyze(L2, now, {})
    assert "dev dumped" in r2["flags"] and r2["tier"] == "TRAP"


def test_too_early_is_never_called():
    now = time.time()
    L = Launch(mint="N", created=now - 3, symbol="NEW", deployer="D", vsol=33)
    L.alpha.append({"wallet": "X", "rank": 1, "ts": now - 2, "sol": 1})
    L.trades.append((now - 2, "buy", 1, 1e6, "X", 33))
    L.buyers["X"] = now - 2
    r = analyze(L, now, {"social": {"N": {"authors": 8, "sources": {"x"}, "vip": True}}})
    assert r["score"] >= 35 and r["tier"] != "SNIPE"   # strong hints, but not enough trades/buyers/age to call


def test_social_spread_by_ca_and_cashtag():
    now = time.time()
    L = runner(now)
    r = analyze(L, now, {"cashtags": {"RUN": {"authors": 3, "sources": {"x", "telegram"}, "vip": False}}})
    assert {d["key"]: d for d in r["detectors"]}["social"]["points"] == 12


def test_pump_candles_use_trade_time_sol_price_and_chain_opens():
    t0 = 1_700_000_000 // 300 * 300
    rows = [{"ts": t0 + 10, "mcap_sol": 30, "sol_usd": 100, "sol": 1},
            {"ts": t0 + 20, "mcap_sol": 33, "sol_usd": 100, "sol": 2},
            {"ts": t0 + 310, "mcap_sol": 36, "sol_usd": None, "sol": 1}]
    c = bucket_trades(rows, 300, fallback_sol_usd=200)
    assert [x["time"] for x in c] == [t0, t0 + 300]
    assert c[0]["open"] == 30 / 1e9 * 100 and c[0]["close"] == 33 / 1e9 * 100 and c[0]["volume"] == 300
    assert c[1]["open"] == c[0]["close"] and c[1]["close"] == 36 / 1e9 * 200


def test_merge_extends_gecko_with_live_tail():
    g = [{"time": 0, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 5},
         {"time": 60, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 1}]
    live = [{"time": 60, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 2},
            {"time": 120, "open": 9, "high": 9, "low": 2.6, "close": 2.8, "volume": 1}]
    m = merge(g, live)
    assert [x["time"] for x in m] == [0, 60, 120]
    assert m[1]["high"] == 3 and m[1]["close"] == 2.5 and m[1]["low"] == 1.5
    assert m[2]["open"] == 2.5                     # chained to the previous close, no phantom gap
    assert merge([], live) == live and merge(g, []) == g
