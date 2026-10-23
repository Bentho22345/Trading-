import json

from radar.adapters.dexscreener import parse_pair, token_meta
from radar.adapters.geckoterminal import parse_ohlcv, parse_pools
from radar.adapters.pumpportal import classify
from radar.adapters.rugcheck import parse_report
from radar.custom import find_items, to_item
from radar.detect import detect

from .fixtures import (DEX_PAIR, GECKO_OHLCV, GECKO_TRENDING, MINT, PAIR, PUMP_CREATE, PUMP_MIGRATE, PUMP_TRADE,
                       RUG_REPORT, RUG_REPORT_MINTABLE)


def test_dex_pair():
    r = parse_pair(DEX_PAIR, 1.0)
    assert r["token_address"] == MINT and r["pair_address"] == PAIR
    assert r["price_usd"] == 0.0000612 and r["liquidity_usd"] == 52000.1
    assert (r["buys_m5"], r["sells_m5"], r["vol_h1"]) == (120, 80, 300100.2)
    assert r["pair_created_at"] == 1759766400 and r["boosts_active"] == 10
    assert token_meta(DEX_PAIR)["links"]["socials"][0]["type"] == "twitter"


def test_gecko():
    rows = parse_pools(GECKO_TRENDING)
    assert rows[0]["token_address"] == MINT and rows[0]["symbol"] == "HAWKTUAH"
    assert rows[0]["image"] is None and rows[0]["liquidity_usd"] == 52000.1
    candles = parse_ohlcv(GECKO_OHLCV)
    assert [c["time"] for c in candles] == [1759766400, 1759766700]


def test_rugcheck_excludes_amm_from_concentration():
    r = parse_report(MINT, RUG_REPORT)
    assert r["mint_authority"] == "" and r["freeze_authority"] == ""
    assert r["top10_pct"] == 7.5  # AMM vault (20%) excluded
    assert r["lp_locked_pct"] == 100.0 and r["holders"] == 812 and r["insiders_detected"] == 2
    assert json.loads(r["risks_json"])[0]["name"] == "Low Liquidity"
    assert parse_report("x", RUG_REPORT_MINTABLE)["mint_authority"].startswith("Auth")


def test_pump_classify():
    assert classify(PUMP_CREATE) == "create"
    assert classify(PUMP_TRADE) == "trade"
    assert classify(PUMP_MIGRATE) == "migrate"
    assert classify({"message": "Successfully subscribed"}) == "control"


def test_detect():
    d = detect(f"Official: $TRUMP is live CA {MINT} also 0x6982508145454ce325ddbe47a25d4ec3d2311933 $usd")
    assert d["solana"] == [MINT]
    assert d["evm"] == ["0x6982508145454ce325ddbe47a25d4ec3d2311933"]
    assert d["cashtags"] == ["TRUMP"]
    assert detect("the quick brown fox jumps over lazy dogs again")["solana"] == []


def test_custom_items():
    data = {"meta": {}, "results": [{"headline": "A", "url": "https://a"}, {"title": "B"}]}
    items = find_items(data, None)
    assert len(items) == 2
    it = to_item(1, items[0])
    assert it["title"] == "A" and it["link"] == "https://a"
    assert find_items({"a": {"b": [1, 2]}}, "a.b") == [1, 2]


def test_goplus_mapping():
    from radar.adapters.extra import parse_goplus
    r = parse_goplus("0xabc", {"is_mintable": "1", "is_honeypot": "0", "holder_count": "1200",
                               "holders": [{"address": "0x1", "percent": "0.12", "is_contract": 0},
                                           {"address": "0x2", "percent": "0.5", "is_contract": 1}],
                               "lp_holders": [{"address": "0x000000000000000000000000000000000000dEaD", "percent": "0.9"}],
                               "sell_tax": "0.2"})
    assert r["mint_authority"] == "mintable" and r["holders"] == 1200
    assert r["top10_pct"] == 12.0 and r["lp_locked_pct"] == 90.0
    assert any("Sell tax" in x["name"] for x in json.loads(r["risks_json"]))


def test_heuristic_classifier():
    from radar.social.text import heuristic_classify
    c = heuristic_classify("Hawk Tuah girl launches $HAWK on pump.fun, the dog is going viral", ["HAWK"], [],
                           {"animal": ["dog", "hawk"], "celebrity": ["girl"]}, ["listing"])
    assert c["tokenizable"] and c["category"] == "animal" and "HAWK" in c["ticker_candidates"]
