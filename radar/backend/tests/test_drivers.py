import asyncio
import copy
import json

from radar import drivers, scoring
from radar.db import DB
from tests.test_scoring import CFG, RISK, STRONG

NOW = 1_000_000.0


def test_liquidity_removed_ignores_price_driven_shrink():
    # price quarters -> constant-product liquidity halves on its own: nothing was withdrawn
    assert drivers.liquidity_removed_pct([{"price_usd": 1.0, "liquidity_usd": 100}, {"price_usd": 0.25, "liquidity_usd": 50}]) == 0
    # flat price, liquidity down 60% -> LP pulled
    assert drivers.liquidity_removed_pct([{"price_usd": 1.0, "liquidity_usd": 100}, {"price_usd": 1.0, "liquidity_usd": 40}]) == 60
    assert drivers.liquidity_removed_pct([{"price_usd": 1.0, "liquidity_usd": 100}]) is None


def test_listing_headline_needs_venue_word_and_token():
    titles = ["Binance will list Hawk Tuah (HAWK) in the Innovation Zone", "Coinbase adds support for SOL staking"]
    assert drivers.listing_headline(titles, "HAWK", "Hawk Tuah").startswith("Binance")
    assert drivers.listing_headline(titles, "WIF", "dogwifhat") is None
    assert drivers.listing_headline(["Upbit listing: $ab"], "AB", "") is None  # too short to match reliably


def test_max_holder_pct():
    assert drivers.max_holder_pct(json.dumps([{"pct": 2.5}, {"pct": 7.25}])) == 7.25
    assert drivers.max_holder_pct("not json") is None


def _with(d):
    inp = copy.deepcopy(STRONG)
    inp["drivers"] = d
    return scoring.evaluate(inp, CFG, RISK, now=1000)


def test_old_inputs_without_drivers_score_the_same():
    a = scoring.evaluate(STRONG, CFG, RISK, now=1000)
    assert _with({})["score"] == a["score"] and _with(None)["verdict"] == a["verdict"]


def test_liquidity_withdrawal_is_a_risk_then_a_veto():
    r = _with({"liq_removed_pct_1h": 25})
    assert any("withdrawn" in x for x in r["risks"]) and r["subscores"]["safety"] < _with({})["subscores"]["safety"]
    r = _with({"liq_removed_pct_1h": 60})
    assert r["verdict"] == "AVOID" and any("withdrawn" in v for v in r["vetoes"])


def test_concentration_dev_selling_and_serial_launcher_cut_safety():
    base = _with({})["subscores"]["safety"]
    for d, msg in (({"max_holder_pct": 12}, "one wallet holds"), ({"top10_chg_pts_1h": 8}, "concentrating"),
                   ({"dev_sells_15m": 2, "dev_sold_sol_15m": 3.1}, "dev wallet sold"),
                   ({"deployer_launches_7d": 9}, "serial launcher"), ({"liq_mcap_ratio": 0.01}, "thin liquidity")):
        r = _with(d)
        assert r["subscores"]["safety"] < base and any(msg in x for x in r["risks"]), d


def test_social_volume_drives_narrative_even_without_a_narrative():
    inp = copy.deepcopy(STRONG)
    inp["narrative"] = None
    assert scoring.evaluate(inp, CFG, RISK)["subscores"]["narrative"] is None
    inp["drivers"] = {"mentions_1h": 40, "mentions_prev_1h": 10, "mention_authors_1h": 25}
    r = scoring.evaluate(inp, CFG, RISK)
    assert r["subscores"]["narrative"] > 80 and any("accelerating" in x for x in r["reasons"])
    inp["drivers"] = {"mentions_1h": 2, "mentions_prev_1h": 20}
    r = scoring.evaluate(inp, CFG, RISK)
    assert r["subscores"]["narrative"] < 30 and any("fading" in x for x in r["reasons"])


def test_token_listings_are_catalysts():
    inp = copy.deepcopy(STRONG)
    inp["narrative"] = None
    assert scoring.evaluate(inp, CFG, RISK)["subscores"]["catalyst"] is None
    inp["drivers"] = {"graduated_h_ago": 1.5}
    assert scoring.evaluate(inp, CFG, RISK)["subscores"]["catalyst"] == CFG["catalyst"]["graduation"]
    inp["drivers"] = {"graduated_h_ago": 30}
    assert scoring.evaluate(inp, CFG, RISK)["subscores"]["catalyst"] is None
    inp["drivers"] = {"cex_listing": "Binance will list HAWK", "coingecko_trending_rank": 3}
    r = scoring.evaluate(inp, CFG, RISK)
    assert r["subscores"]["catalyst"] == CFG["catalyst"]["cex_listing"]
    assert any("CoinGecko" in x for x in r["reasons"]) and any("exchange listing" in x for x in r["reasons"])


def test_collect_reads_drivers_from_the_database(tmp_path):
    async def run():
        db = DB(tmp_path / "r.db")
        await db.open()
        a, dev = "Hawk1111111111111111111111111111pump", "Dev111111111111111111111111111111"
        await db.exec("INSERT INTO tokens (address, symbol, name, deployer, first_seen) VALUES (?,?,?,?,?)", (a, "HAWK", "Hawk Tuah", dev, NOW - 600))
        for i in range(5):
            await db.exec("INSERT INTO tokens (address, deployer, first_seen) VALUES (?,?,?)", (f"other{i}", dev, NOW - 86400))
        await db.exec("INSERT INTO safety_reports (token_address, as_of, top_holders_json) VALUES (?,?,?)", (a, NOW, json.dumps([{"pct": 9.0}])))
        await db.exec("INSERT INTO holder_snapshots (token_address, ts, holders, top10_pct) VALUES (?,?,?,?)", (a, NOW - 3000, 100, 20))
        await db.exec("INSERT INTO holder_snapshots (token_address, ts, holders, top10_pct) VALUES (?,?,?,?)", (a, NOW - 60, 300, 14))
        posts = [(NOW - 100, json.dumps([a]), "[]"), (NOW - 200, "[]", json.dumps(["HAWK"])), (NOW - 5000, json.dumps([a]), "[]"),
                 (NOW - 300, "[]", json.dumps(["HAWKX"]))]
        for i, (ts, cas, tags) in enumerate(posts):
            await db.exec("INSERT INTO social_events (id, source, author_id, ts, ingested, cas_json, cashtags_json) VALUES (?,?,?,?,?,?,?)",
                          (f"p{i}", "x", f"x:u{i}", ts, ts, cas, tags))
        await db.exec("INSERT INTO pump_trades (mint, ts, side, sol, trader, signature) VALUES (?,?,?,?,?,?)", (a, NOW - 120, "sell", 2.5, dev, "s1"))
        await db.exec("INSERT INTO news (id, title, fetched) VALUES (?,?,?)", ("n1", "Upbit will list Hawk Tuah (HAWK)", NOW - 3600))
        await db.exec("INSERT INTO trending (source, list, rank, symbol, name, as_of) VALUES (?,?,?,?,?,?)", ("coingecko", "trending", 4, "hawk", "Hawk Tuah", NOW))
        tok = {"symbol": "HAWK", "name": "Hawk Tuah", "deployer": dev, "market_cap": 1_000_000, "liquidity_usd": 50_000, "graduated_at": NOW - 7200}
        ticks = [{"price_usd": 1.0, "liquidity_usd": 100_000}, {"price_usd": 1.0, "liquidity_usd": 50_000}]
        out = await drivers.collect(db, a, tok, ticks, now=NOW)
        await db.close()
        return out
    d = asyncio.run(run())
    assert d["liq_mcap_ratio"] == 0.05 and d["liq_removed_pct_1h"] == 50
    assert d["max_holder_pct"] == 9.0 and d["top10_chg_pts_1h"] == -6
    assert d["mentions_1h"] == 1.5 and d["ca_mentions_1h"] == 1 and d["mentions_prev_1h"] == 1.0 and d["mention_authors_1h"] == 2
    assert d["dev_sells_15m"] == 1 and d["dev_sold_sol_15m"] == 2.5 and d["deployer_launches_7d"] == 6
    assert d["cex_listing"].startswith("Upbit") and d["graduated_h_ago"] == 2 and d["coingecko_trending_rank"] == 4
