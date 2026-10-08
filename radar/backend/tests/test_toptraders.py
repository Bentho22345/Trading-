import asyncio
import time

import httpx

from radar.adapters.geckoterminal import SOL_MINT, parse_trades
from radar.db import DB
from radar.leaderboard import Leaderboard
from radar.toptraders import TopTraders, parse_gainers, parse_token_traders

TOKEN = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"


def gt(kind, wallet, sol, tokens, ts, tx):
    frm, to = (SOL_MINT, TOKEN) if kind == "buy" else (TOKEN, SOL_MINT)
    fa, ta = (sol, tokens) if kind == "buy" else (tokens, sol)
    return {"id": f"solana_{tx}", "type": "trade", "attributes": {
        "block_number": 1, "tx_hash": tx, "tx_from_address": wallet, "from_token_amount": str(fa), "to_token_amount": str(ta),
        "price_from_in_usd": "1", "price_to_in_usd": "1", "block_timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)),
        "kind": kind, "volume_in_usd": str(sol * 150), "from_token_address": frm, "to_token_address": to}}


def test_parse_gecko_trades_keeps_sol_legs_only():
    now = time.time()
    payload = {"data": [gt("buy", "W1", 1.5, 1000, now, "t1"), gt("sell", "W1", 3, 1000, now, "t2"),
                        {"attributes": {"kind": "buy", "from_token_address": "USDC", "to_token_address": TOKEN,
                                        "from_token_amount": "10", "to_token_amount": "5", "tx_from_address": "W2"}}]}
    rows = parse_trades(payload, TOKEN)
    assert [(r["side"], r["sol"], r["tokens"], r["signature"]) for r in rows] == [("buy", 1.5, 1000, "t1"), ("sell", 3, 1000, "t2")]
    assert abs(rows[0]["ts"] - now) < 2


def test_parse_birdeye():
    g = parse_gainers({"success": True, "data": {"items": [{"network": "solana", "address": "A", "pnl": 5000.5, "trade_count": 12,
                                                            "volume": 90000}]}})
    assert g == [{"wallet": "A", "pnl_usd": 5000.5, "volume_usd": 90000, "trades": 12}]
    t = parse_token_traders({"data": {"items": [{"owner": "B", "volume": 1000, "trade": 4, "tags": []},
                                                {"owner": "BOT", "volume": 9e9, "trade": 999, "tags": ["bot"]}]}})
    assert [r["wallet"] for r in t] == ["B"]


class Cfg:
    scoring = {"leaderboard": {"follow": 3, "min_basis_sol": {"1d": 0.5}, "min_closes": {"1d": 1},
                               "sources": {"birdeye_pages": 2, "birdeye_token_traders": 1, "follow_external": 2}}}


class Conn:
    def __init__(self, key):
        self.key = key

    async def values(self, cid):
        return {"api_key": self.key} if cid == "birdeye" and self.key else {}


def test_gecko_trades_feed_ledger_and_birdeye_leaders_get_followed():
    async def run():
        db = DB(":memory:")
        await db.open()
        now = time.time()
        await db.exec("INSERT INTO pairs (pair_address, token_address, chain, quote_symbol, vol_h1, as_of) "
                      "VALUES ('POOL', ?, 'solana', 'SOL', 1e6, ?)", (TOKEN, now))

        class Gecko:
            calls = 0

            async def trades(self, pool, token):
                Gecko.calls += 1
                return parse_trades({"data": [gt("sell", "W1", 3, 1000, now - 10, "t2"), gt("buy", "W1", 1, 1000, now - 60, "t1")]}, token)

        class Tracker:
            gecko = Gecko()

        lb = Leaderboard(db, Cfg())
        tt = TopTraders(db, Cfg(), Tracker(), lb, Conn("KEY"))
        lb.sources = tt
        assert await tt.gecko_tick() == 2
        assert await tt.gecko_tick() == 0  # same trades again: nothing new
        await lb.flush()
        pos = await db.one("SELECT realized_sol FROM wallet_positions WHERE wallet='W1'")
        assert abs(pos["realized_sol"] - 2) < 1e-9

        seen = []

        def handler(req: httpx.Request) -> httpx.Response:
            seen.append((req.url.path, dict(req.url.params), req.headers.get("x-api-key")))
            if req.url.path == "/trader/gainers-losers":
                off = int(req.url.params["offset"])
                items = [{"address": f"BE{req.url.params['type']}{off + i}", "pnl": 1000 - off - i, "trade_count": 3, "volume": 5}
                         for i in range(10)] if off == 0 else []
                return httpx.Response(200, json={"success": True, "data": {"items": items}})
            return httpx.Response(200, json={"data": {"items": [{"owner": "HOT1", "volume": 50, "trade": 2, "tags": []}]}})

        tt.client = httpx.AsyncClient(transport=httpx.MockTransport(handler), headers={"x-chain": "solana"})
        import radar.toptraders as mod
        orig_sleep, mod.asyncio.sleep = mod.asyncio.sleep, (lambda s: orig_sleep(0))
        try:
            n = await tt.birdeye_round()
        finally:
            mod.asyncio.sleep = orig_sleep
        assert n == 31 and all(k == "KEY" for *_, k in seen)
        assert (await db.one("SELECT COUNT(*) n FROM wallet_external WHERE period='7d'"))["n"] == 10
        ext = await lb.external("birdeye", "today", 5, 0)
        assert ext["rows"][0]["wallet"] == "BEtoday0" and ext["rows"][0]["rank"] == 1
        await lb.refresh()
        # follow=3: 2 external leaders (rank 1 on their lists) + the best Radar wallet
        assert len(lb.followed) == 3 and "W1" in lb.followed
        assert (await lb.board("1d"))["rows"][0]["external"] == []
        assert await TopTraders(db, Cfg(), Tracker(), lb, Conn(None)).birdeye_round() == 0  # no key: nothing called
        await db.close()
    asyncio.run(run())
