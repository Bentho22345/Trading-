"""Engines behind the user's keys: Helius budget & parsing, on-chain holder math, YouTube mentions, Claude batching, Telegram cards."""
import asyncio
import time
from types import SimpleNamespace

import pytest

from radar import feed
from radar.helius import BudgetExceeded, Helius, funding_source, wallet_swaps
from radar.narrator import Narrator
from radar.onchain import chain_top10, curve_balance
from radar.sniper import Launch, analyze
from radar.tgbot import coin_card, coin_line
from radar.traders import dune_label
from radar.ytbuzz import Quota, YouTubeBuzz, mentions

W = "Wa11et" + "x" * 34


class KV:
    def __init__(self):
        self.d = {}

    async def kv_get(self, k, default=None):
        return self.d.get(k, default)

    async def kv_set(self, k, v):
        self.d[k] = v


def test_wallet_swaps_any_dex_from_balances():
    mint = "M" * 40
    buy = {"blockTime": 1, "meta": {"err": None, "fee": 5000, "preBalances": [2_000_005_000], "postBalances": [1_000_000_000],
                                    "preTokenBalances": [], "postTokenBalances": [{"owner": W, "mint": mint, "uiTokenAmount": {"uiAmount": 500.0}}]},
           "transaction": {"message": {"accountKeys": [{"pubkey": W}], "instructions": []}}}
    legs = wallet_swaps(buy, W)
    assert legs == [{"mint": mint, "side": "buy", "tokens": 500.0, "sol": pytest.approx(1.0)}]
    # sell paid out in WSOL (router): SOL comes from the WSOL token delta
    sell = {"meta": {"err": None, "fee": 0, "preBalances": [1], "postBalances": [1],
                     "preTokenBalances": [{"owner": W, "mint": mint, "uiTokenAmount": {"uiAmount": 500.0}}],
                     "postTokenBalances": [{"owner": W, "mint": mint, "uiTokenAmount": {"uiAmount": 0.0}},
                                           {"owner": W, "mint": "So11111111111111111111111111111111111111112", "uiTokenAmount": {"uiAmount": 3.0}}]},
            "transaction": {"message": {"accountKeys": [{"pubkey": W}]}}}
    assert wallet_swaps(sell, W) == [{"mint": mint, "side": "sell", "tokens": 500.0, "sol": 3.0}]
    assert wallet_swaps({**sell, "meta": {**sell["meta"], "err": {"x": 1}}}, W) == []


def test_funding_source_from_system_transfer_or_fee_payer():
    tx = {"meta": {"innerInstructions": [{"instructions": [{"program": "system", "parsed": {"type": "transfer",
                                                                                          "info": {"source": "FUNDER", "destination": W, "lamports": 2e9}}}]}]},
          "transaction": {"message": {"accountKeys": [{"pubkey": "RELAYER"}, {"pubkey": W}], "instructions": []}}}
    assert funding_source(tx, W) == ("FUNDER", 2.0)
    tx2 = {"meta": {}, "transaction": {"message": {"accountKeys": ["PAYER", W], "instructions": []}}}
    assert funding_source(tx2, W) == ("PAYER", None)


def test_chain_top10_removes_the_bonding_curve_account():
    vsol = 40.0
    curve = curve_balance(vsol)
    assert curve == pytest.approx(30 * 1.073e9 / 40 - 73e6)
    accts = [{"uiAmount": curve}] + [{"uiAmount": 3e7} for _ in range(12)]
    r = chain_top10(accts, vsol, graduated=False)
    assert r["curve_excluded"] and r["chain_top10_pct"] == pytest.approx(30.0) and r["chain_whales"] == 12
    # unknown curve position: the ≥ 200M account is still recognised as the curve
    assert chain_top10([{"uiAmount": 6e8}, {"uiAmount": 1e7}], None, False)["chain_top10_pct"] == 1.0
    # graduated: nothing removed
    assert chain_top10([{"uiAmount": 6e8}], vsol, True)["chain_top10_pct"] == 60.0


def test_helius_budget_paces_and_splits_by_job(monkeypatch):
    async def run():
        h = Helius(KV())
        h.set_key("k")
        h.daily = 10_000
        noon = (time.time() // 86400) * 86400 + 43200
        monkeypatch.setattr("radar.helius.time.time", lambda: noon)
        h.day = int(noon // 86400)
        assert h.can("intel", 1)
        h.spent["intel"] = 4500                        # its 45% share is used
        assert not h.can("intel", 100) and h.can("smart", 100)   # day spent 45% at noon: no spare to borrow, other jobs fine
        h.spent["intel"] = 5_800                        # at the pace limit for noon (50% + 8%) -> everything waits
        assert not h.can("smart", 10)
        h.spent["intel"] = 1000
        h.spent["backfill"] = 2600                      # backfill share 2,500 used, but the day is under pace -> spare flows
        assert h.can("backfill", 100)
        h.key = None
        assert not h.can("intel", 1)
        with pytest.raises(BudgetExceeded):
            await h.rpc("getHealth", [], "intel")
        await h.set_daily(50)
        assert h.daily == 1000                          # floor
    asyncio.run(run())


def test_dune_labels_and_youtube_mentions():
    assert dune_label({"wallet": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "total_pnl": -1500.0, "winrate": 41}) == "Dune · PnL $-2k · WR 41%"
    assert dune_label({"wallet": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"}) == "Dune"
    tags, cas = mentions("Buy $ZORP and $SOL now! CA 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU $wif")
    assert tags == ["ZORP"] and cas == ["7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"]
    q = Quota()
    q.cap = 150
    assert q.can(100)
    q.spend(100, "search")
    assert not q.can(100) and q.snapshot()["by"] == {"search": 100}


def test_youtube_match_by_contract_ticker_or_name():
    b = YouTubeBuzz(None, None, None)
    v1 = {"id": "a", "title": "Zorp to the moon", "views": 1000}
    v2 = {"id": "b", "title": "the great frogcoin saga", "views": 50}
    b.by_ca = {"MINT1": [v1]}
    b.by_tag = {"ZORP": [v1]}
    b.titles = [("zorp to the moon", v1), ("the great frogcoin saga", v2)]
    assert b.match("MINT1", None, None)["videos"] == 1
    assert b.match("x", "ZORP", None)["views"] == 1000
    assert b.match("x", "FRG", "Frogcoin")["videos"] == 1
    assert b.match("x", "CAT", "cat") is None              # common ticker / short name never match


def _launch(**kw) -> Launch:
    L = Launch(mint="MINTx" + "1" * 35, created=time.time() - 120, symbol="ZORP", name="Zorp", deployer="DEV" + "d" * 37)
    for k, v in kw.items():
        setattr(L, k, v)
    return L


def test_onchain_and_buzz_detectors_change_the_read():
    now = time.time()
    clean = _launch()
    for i in range(12):
        w = f"Buyer{i}" + "b" * 34
        clean.trades.append((now - 60 + i, "buy", 0.5, 2e7, w, 32 + i))
        clean.buyers[w] = now - 60 + i
        clean.buy_sol[w] = 0.5
        clean.balances[w] = 2e7
    ins = [f"Buyer{i}" + "b" * 34 for i in range(4)]
    dirty = _launch(trades=clean.trades, buyers=clean.buyers, buy_sol=clean.buy_sol, balances={**clean.balances, ins[0]: 2e8},
                    intel={"scanned": 10, "fresh": ins, "fresh_pct": 40, "bots": 1, "insiders": ins, "dev_fresh": True,
                           "clusters": [{"funder": "F", "wallets": ins, "n": 4, "link": "dev"}], "chain_top10_pct": 33.0})
    clean.intel = {"scanned": 10, "fresh": [], "fresh_pct": 0, "bots": 0, "insiders": [], "clusters": [], "chain_top10_pct": 20.0}
    clean.ai = {"narrative": "alien frog", "category": "animal", "meme_score": 9, "derivative": False, "red_flags": [], "take": "fresh meme"}
    clean.yt = {"videos": 2, "views": 30000, "top": "Zorp to the moon"}
    rc, rd = analyze(clean, now, {"social": {}, "cashtags": {}}), analyze(dirty, now, {"social": {}, "cashtags": {}})
    assert rd["risk"] > rc["risk"] and rc["upside"] > rd["upside"]
    assert "insider cluster" in rd["flags"] and rd["tier"] == "TRAP"            # linked wallets hold ≥ 25%
    assert rd["metrics"]["insiders"] == 4 and rd["metrics"]["insider_hold_pct"] >= 25
    assert rc["metrics"]["ai_meme_score"] == 9 and rc["metrics"]["yt_videos"] == 2
    assert any(d["key"] == "buzz" and d["points"] > 0 for d in rc["detectors"])
    assert rc["intel"]["insiders"] == 0 and rc["ai"]["take"] == "fresh meme" and rc["yt"]["videos"] == 2
    card = coin_card({**rc, "mint": clean.mint})
    assert "alien frog" in card and "▶ 2 YouTube videos" in card and "<code>" in card
    assert "✦ meme 9/10" in coin_line(1, {**rc, "mint": clean.mint}, "degen")


def test_narrator_batches_once_and_feeds_the_score():
    async def run():
        calls = []

        class FakeAI:
            enabled = True

            async def label_launches(self, coins):
                calls.append(coins)
                return [{"mint": c["mint"], "narrative": "n", "category": "meme", "meme_score": 11, "derivative": False,
                         "red_flags": [], "take": "t" * 200} for c in coins]

        class DBx:
            rows = []

            async def many(self, sql, rows):
                self.rows += rows

            async def all(self, *a):
                return []

        sn = SimpleNamespace(launches={}, dirty=set())
        for i in range(7):
            L = _launch(mint=f"M{i}" + "x" * 38, name=f"Coin {i}", created=time.time() - 60)
            L.result = {"upside": 40, "scores": {"degen": 30}, "tier": "WATCH"}
            sn.launches[L.mint] = L
        n = Narrator(DBx(), FakeAI(), sn)
        assert await n.run_once() == 7 and len(calls) == 1
        assert await n.run_once() == 0                    # never pays twice for the same coin
        L = next(iter(sn.launches.values()))
        assert L.ai["meme_score"] == 10 and len(L.ai["take"]) == 120 and L.mint in sn.dirty
        assert any(e["engine"] == "claude" for e in feed.recent())
    asyncio.run(run())


def test_x_tweet_scoring_terms_and_batches():
    from radar.xradar import XRadar, coinable_terms, final_score, heuristic_score
    terms = coinable_terms('My new puppy is named "Floki Jr" — say hi to Zorblax #MarsDog https://t.co/x', {"animal": ["puppy"]})
    assert {"Floki Jr", "Zorblax", "MarsDog", "puppy"} <= set(terms)
    assert "Say" not in terms and len(terms) <= 8
    hot, v = heuristic_score("Zorblax 🐕", "S", True, {"like_count": 6000, "retweet_count": 1000}, 2, 0, 0, 2)
    meh, _ = heuristic_score("@someone thanks for the update on the market today, great discussion everyone", "B", False, {}, 30, 0, 0, 0)
    assert hot > 75 and meh < 20 and v > 1000
    assert final_score(60, {"meme_potential": 9, "coinable": True}, 2) > final_score(60, {"meme_potential": 1, "coinable": False}, 0)
    xr = XRadar.__new__(XRadar)
    xr.roster = {f"h{i}": {"handle": f"Handle{i:03d}", "tier": "A", "replies": 0} for i in range(60)}
    xr.roster["e"] = {"handle": "elonmusk", "tier": "S", "replies": 1}
    b = xr.batches()
    assert all(len(q) <= 482 for qs in b.values() for q, _ in qs)
    assert sum(len(h) for q, h in b["A"]) == 60 and len(b["A"]) >= 2
    assert b["S"][0][0] == "(from:elonmusk) -is:retweet"                 # replies kept for accounts whose replies matter
    assert all(q.endswith("-is:reply") for q, _ in b["A"])
