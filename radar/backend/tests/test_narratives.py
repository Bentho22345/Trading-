import asyncio
import json
import time

from radar.db import DB
from radar.metas import MetaBoard, load_metas
from radar.newsintel import NewsIntel, clean_title


class _Alerts:
    def __init__(self):
        self.sent = []

    async def send(self, kind, title, body="", token=None, **kw):
        self.sent.append((kind, title))


def test_catalog_loads_and_matches_coins_and_text():
    metas = load_metas()
    assert len(metas) >= 40
    from radar.cfg import load_yaml
    for m in load_yaml("metas.yaml")["metas"]:   # an unquoted comma in a flow mapping silently splits the name
        assert set(m) <= {"id", "name", "family", "emoji", "keywords", "phrases", "tickers"}, m["id"]
    assert len({m.id for m in metas}) == len(metas)
    board = MetaBoard(None)
    assert "cats" in board.match_coin("Popcat", "POPCAT")
    assert "dogs" in board.match_coin("dogwifhat", "WIF")
    assert "dogs" in board.match_coin("Dog Wif Hat", "DOGWIF")
    assert "cats" not in board.match_coin("Education Token", "EDUCATION")
    assert "trump" in board.match_text("Trump posts about $MAGA again")
    assert "ai_agents" in board.match_text("new AI agent launchpad is live")
    assert "asia" in board.match_text("币安 人生 is pumping")
    assert board.match_text("") == []


def test_news_enrich_tags_tickers_and_story_grouping():
    board = MetaBoard(None)
    ni = NewsIntel(board)
    now = time.time()
    feed = {"name": "GNews: Binance listing", "group": "listings"}
    a = ni.enrich({"id": "a", "source": feed["name"], "title": "Binance will list Dogecoin and Popcat perpetuals - CoinDesk",
                   "link": "x", "published": now, "fetched": now}, feed)
    assert a["publisher"] == "CoinDesk" and a["title"].startswith("Binance will list")
    assert "listing" in a["tags"] and {"DOGE"} <= set(a["tickers"])
    assert "listings" in a["metas"] and a["impact"] >= 80 and a["sentiment"] > 0
    b = ni.enrich({"id": "b", "source": feed["name"], "title": "Binance will list Dogecoin and Popcat perpetuals - The Block",
                   "link": "y", "published": now, "fetched": now}, feed)
    assert b["story_id"] == "a" and b["coverage"] == 2
    c = ni.enrich({"id": "c", "source": "Decrypt", "title": "DeFi protocol drained in $40M exploit", "link": "z",
                   "published": now, "fetched": now}, {"name": "Decrypt", "group": "crypto"})
    assert c["story_id"] == "c" and "hack" in c["tags"] and c["sentiment"] < 0
    assert clean_title("Short - X", "GNews: x") == ("Short - X", None)


def test_news_alerts_only_for_fresh_high_impact():
    alerts = _Alerts()
    ni = NewsIntel(MetaBoard(None), alerts)
    now = time.time()
    feed = {"name": "GNews: Coinbase listing", "group": "listings"}
    fresh = ni.enrich({"id": "n1", "source": feed["name"], "title": "Coinbase adds support for BONK - Reuters", "link": "",
                       "published": now, "fetched": now}, feed)
    old = ni.enrich({"id": "n2", "source": feed["name"], "title": "Robinhood lists PEPE for US users - AP", "link": "",
                     "published": now - 7200, "fetched": now}, feed)
    asyncio.run(ni.on_fresh([fresh, old]))
    assert len(alerts.sent) == 1 and alerts.sent[0][0] == "flash" and "BONK" in alerts.sent[0][1] + str(fresh["tickers"])


def test_meta_board_ranks_live_activity(tmp_path):
    async def run():
        db = DB(tmp_path / "m.db")
        await db.open()
        now = time.time()
        for i in range(30):
            await db.exec("INSERT INTO social_events (id, source, text, ts, ingested) VALUES (?,?,?,?,?)",
                          (f"s{i}", "bluesky", f"this cat coin is going viral {i}", now - i * 60, now - i * 60))
        await db.exec("INSERT INTO social_events (id, source, text, ts, ingested) VALUES (?,?,?,?,?)",
                      ("old", "bluesky", "dog season", now - 5 * 3600, now - 5 * 3600))
        for i, (sym, vol, chg) in enumerate([("POPCAT", 900_000, 25.0), ("MEW", 300_000, 12.0), ("BONK", 10_000, -5.0)]):
            addr = f"addr{i}"
            await db.exec("INSERT INTO tokens (address, chain, name, symbol, first_seen, launched_at, best_pair) VALUES (?,?,?,?,?,?,?)",
                          (addr, "solana", sym.title(), sym, now - 600, now - 600, f"pair{i}"))
            await db.exec("INSERT INTO pairs (pair_address, token_address, chain, vol_h1, vol_h24, chg_h1, chg_h24, market_cap, as_of) "
                          "VALUES (?,?,?,?,?,?,?,?,?)", (f"pair{i}", addr, "solana", vol, vol * 6, chg, chg, vol * 20, now))
        try:
            await check(db)
        finally:
            await db.close()

    async def check(db):
        board = MetaBoard(db, _Alerts())
        rows = await board.refresh()
        by = {r["id"]: r for r in rows}
        cats, dogs = by["cats"], by["dogs"]
        assert rows[0]["id"] == "cats" and cats["coins"] == 2 and cats["m_1h"] >= 30 and cats["launches_1h"] == 2
        assert cats["chg_h1"] > 15 and cats["leaders"][0]["symbol"] == "POPCAT"
        assert dogs["coins"] == 1 and dogs["m_1h"] == 0 and dogs["heat"] < cats["heat"]
        assert sum(cats["spark"]) >= 30
        d = await board.detail("cats")
        assert d["coins"][0]["symbol"] == "POPCAT" and len(d["posts"]) >= 20
        assert json.dumps(board.compact())
    asyncio.run(run())
