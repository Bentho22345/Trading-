import asyncio
import time

from radar.db import DB
from radar.traders import compute_wallet, extract_addresses, parse_gecko_trades, parse_helius_swaps, score
from radar.tracker import curve_progress

W = "Wa11et1111111111111111111111111111111111"


def _t(mint, side, tokens, usd, ts):
    return {"mint": mint, "side": side, "token_amount": tokens, "usd": usd, "ts": ts}


def test_compute_wallet_average_cost_pnl():
    rows = [_t("A", "buy", 100, 100, 1), _t("A", "buy", 100, 300, 2), _t("A", "sell", 100, 400, 3),   # cost 2/token, sold half at 4
            _t("B", "buy", 10, 50, 4), _t("B", "sell", 10, 25, 5),                                     # closed loss -25
            _t("C", "sell", 5, 999, 6)]                                                                # no observed buy -> excluded
    s = compute_wallet(rows, {"A": 3.0})
    assert s["realized_usd"] == 200 - 25          # A: 400 - 2*100 ; B: -25
    assert s["unrealized_usd"] == 100             # A: 100 left × (3 - 2)
    assert s["tokens"] == 2 and s["wins"] == 0 and s["losses"] == 1   # A is not closed (only half sold)
    assert s["invested_usd"] == 450 and s["best_token"] == "A"
    assert s["volume_usd"] == 100 + 300 + 400 + 50 + 25 + 999


def test_score_filters_and_orders():
    now = time.time()
    good = {"tokens": 12, "trades": 40, "avg_hold_s": 3600, "pnl_usd": 50_000, "wins": 9, "closed": 11, "median_roi": 80}
    meh = {**good, "pnl_usd": 500, "wins": 4, "median_roi": 5}
    bot = {**good, "trades": 4000, "tokens": 10}
    few = {**good, "tokens": 2}
    assert score(good, now, now)[0] > score(meh, now, now)[0] > 0
    assert score(bot, now, now)[0] is None and "bot" in score(bot, now, now)[1][0]
    assert score(few, now, now)[0] is None
    assert score(good, now - 40 * 86400, now)[0] < score(good, now, now)[0]


def test_parsers():
    g = parse_gecko_trades({"data": [{"attributes": {"tx_hash": "x", "tx_from_address": W, "kind": "buy", "volume_in_usd": "250.5",
                                                      "to_token_amount": "1000", "from_token_amount": "1.2",
                                                      "block_timestamp": "2026-10-08T12:00:00Z"}}]}, "MINT")
    assert g[0]["wallet"] == W and g[0]["usd"] == 250.5 and g[0]["token_amount"] == 1000 and g[0]["side"] == "buy"
    txs = [{"signature": "s1", "timestamp": 100, "events": {"swap": {
        "nativeInput": {"account": W, "amount": 2_000_000_000},
        "tokenOutputs": [{"userAccount": W, "mint": "MEME", "rawTokenAmount": {"tokenAmount": "5000000", "decimals": 6}}]}}},
        {"signature": "s2", "timestamp": 200, "events": {"swap": {
            "tokenInputs": [{"userAccount": W, "mint": "MEME", "rawTokenAmount": {"tokenAmount": "5000000", "decimals": 6}}],
            "tokenOutputs": [{"userAccount": W, "mint": "So11111111111111111111111111111111111111112",
                              "rawTokenAmount": {"tokenAmount": "6000000000", "decimals": 9}}]}}}]
    legs = parse_helius_swaps(txs, W)
    assert [(l["side"], l["mint"], l["token_amount"], l["sol"]) for l in legs] == [("buy", "MEME", 5.0, 2.0), ("sell", "MEME", 5.0, 6.0)]
    rows = extract_addresses(f"{W}, alpha whale\nnot an address\n{W}\nGJR1111111111111111111111111111111111111 kol")
    assert rows == [(W, "alpha whale"), ("GJR1111111111111111111111111111111111111", "kol")]
    assert curve_progress(30) == 0 and curve_progress(115) == 100 and curve_progress(72.5) == 50 and curve_progress(None) is None


def test_record_admission_and_ranking(tmp_path):
    from radar.traders import Traders

    class Tr:
        sol_usd = 150.0

        class pump:
            account_subs = set()

            @staticmethod
            async def set_account_trades(s):
                Tr.pump.account_subs = s

    async def run():
        db = DB(tmp_path / "t.db")
        await db.open()
        tr = Traders(db, Tr, None, None, None)
        now = time.time()
        trades = []
        for i in range(6):
            w = f"W{i}" + "1" * 38
            for m in range(4):
                trades.append({"id": f"{i}{m}b", "wallet": w, "mint": f"M{m}", "ts": now - 900, "side": "buy", "token_amount": 1000,
                               "usd": 200.0, "source": "geckoterminal"})
                trades.append({"id": f"{i}{m}s", "wallet": w, "mint": f"M{m}", "ts": now - 300, "side": "sell", "token_amount": 1000,
                               "usd": 200.0 * (i + 1) / 2, "source": "geckoterminal"})
        trades.append({"id": "tiny", "wallet": "Tiny" + "1" * 36, "mint": "M0", "ts": now, "side": "buy", "token_amount": 1, "usd": 5.0,
                       "source": "pumpportal"})
        await tr.record(trades)
        counts = await tr.compute()
        lb = await tr.leaderboard("7d")
        s = await tr.summary()
        await db.close()
        return counts, lb, s
    counts, lb, s = asyncio.run(run())
    assert counts["7d"] == 6 and lb["pool"] == 6          # the $5 wallet was not admitted
    assert [r["address"][:2] for r in lb["rows"]] == ["W5", "W4", "W3", "W2", "W1", "W0"]
    assert lb["rows"][0]["pnl_usd"] == 4 * (600 - 200) and lb["rows"][-1]["pnl_usd"] < 0
    assert s["ranked"] == 6 and s["trades_24h"] == 48
