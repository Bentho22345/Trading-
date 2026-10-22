"""The trade feed: PumpPortal API key wiring, and the free on-chain fallback (pump.fun TradeEvent decoded from logs)."""
import asyncio
import base64
import json
import os
import struct

import websockets

from radar.adapters.chaintrades import PUMP_PROGRAM, TRADE_DISC, ChainTrades, decode_trade


def _pk(seed: int) -> bytes:
    return bytes([seed]) * 32


def trade_event(mint=_pk(7), user=_pk(9), sol=1.5, tokens=12_345.678, buy=True, vsr=40.0, vtr=800_000_000.0) -> bytes:
    """Bytes laid out like pump.fun's Anchor TradeEvent (discriminator, then the fields), plus a trailing tail of the
    newer fields (fee recipient, fees, creator…) that the decoder must ignore."""
    return (TRADE_DISC + mint + struct.pack("<QQ?32sqQQ", int(sol * 1e9), int(tokens * 1e6), buy, user, 1_790_000_000,
                                            int(vsr * 1e9), int(vtr * 1e6)) + b"\x00" * 120)


def test_decode_trade_event():
    from solders.pubkey import Pubkey
    t = decode_trade(trade_event())
    assert t["mint"] == str(Pubkey.from_bytes(_pk(7))) and t["traderPublicKey"] == str(Pubkey.from_bytes(_pk(9)))
    assert t["txType"] == "buy" and abs(t["solAmount"] - 1.5) < 1e-9 and abs(t["tokenAmount"] - 12_345.678) < 1e-6
    assert abs(t["vSolInBondingCurve"] - 40.0) < 1e-9 and abs(t["marketCapSol"] - 40.0 / 800_000_000.0 * 1e9) < 1e-6
    assert decode_trade(trade_event(buy=False))["txType"] == "sell"
    assert decode_trade(b"\x01" * 200) is None and decode_trade(TRADE_DISC + b"\x00" * 10) is None


def test_chain_feed_end_to_end_against_a_solana_style_websocket():
    """A local websocket that answers logsSubscribe like a Solana RPC and streams pump.fun log notifications."""
    from solders.pubkey import Pubkey
    watched = str(Pubkey.from_bytes(_pk(7)))

    async def run():
        got_sub = []

        async def rpc(ws):
            req = json.loads(await ws.recv())
            got_sub.append(req)
            await ws.send(json.dumps({"jsonrpc": "2.0", "result": 42, "id": req["id"]}))
            for i, mint in enumerate((_pk(7), _pk(8), _pk(7))):        # two for a coin we watch, one we don't
                logs = [f"Program {PUMP_PROGRAM} invoke [1]", "Program log: Instruction: Buy",
                        "Program data: " + base64.b64encode(trade_event(mint=mint, sol=0.5 + i)).decode(), f"Program {PUMP_PROGRAM} success"]
                await ws.send(json.dumps({"jsonrpc": "2.0", "method": "logsNotification",
                                          "params": {"result": {"context": {"slot": 1}, "value": {"signature": f"sig{i}", "err": None, "logs": logs}},
                                                     "subscription": 42}}))
            await ws.send(json.dumps({"jsonrpc": "2.0", "method": "logsNotification", "params": {"result": {"value": {
                "signature": "failed", "err": {"InstructionError": [0, "x"]}, "logs": ["Program data: " + base64.b64encode(trade_event()).decode()]}}}}))
            await asyncio.sleep(5)

        async with websockets.serve(rpc, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            os.environ["SOLANA_WS_URL"] = f"ws://127.0.0.1:{port}"
            try:
                out = []

                async def on_trade(t):
                    out.append(t)

                feed = ChainTrades(on_trade, lambda: {watched})
                task = asyncio.create_task(feed.run())
                for _ in range(50):
                    if len(out) >= 2:
                        break
                    await asyncio.sleep(0.05)
                feed.stop()
                task.cancel()
            finally:
                os.environ.pop("SOLANA_WS_URL", None)
        assert got_sub[0]["method"] == "logsSubscribe" and got_sub[0]["params"][0] == {"mentions": [PUMP_PROGRAM]}
        assert [t["signature"] for t in out] == ["sig0", "sig2"]                # unwatched coin and failed tx dropped
        assert all(t["mint"] == watched for t in out) and out[0]["solAmount"] == 0.5
        assert feed.decoded == 3 and feed.forwarded == 2
    asyncio.run(run())


def test_pumpportal_key_rides_on_the_url_and_counts_trades():
    from radar.adapters.pumpportal import PumpPortal

    async def noop(m):
        return None
    pp = PumpPortal(noop, noop, noop)
    base = pp.url
    pp.set_key("k" * 40)
    assert pp.url == base + "?api-key=" + "k" * 40 and pp.has_key
    pp.set_key("")
    assert pp.url == base and not pp.has_key

    async def run():
        await pp.on_message({"txType": "buy", "mint": "M", "solAmount": 1})
        await pp.on_message({"txType": "sell", "mint": "M", "solAmount": 1})
    asyncio.run(run())
    assert pp.trade_rate(90) == 2 and pp.trades_day[1] == 2 and pp.est_cost_sol_today() == 0.0


def test_tracker_drops_the_same_trade_from_both_feeds(tmp_path):
    from radar.db import DB
    from radar.tracker import Tracker

    async def run():
        db = DB(tmp_path / "t.db")
        await db.open()
        tr = Tracker(db)
        seen = []
        tr.hooks["trade"].append(lambda t: seen.append(t) or asyncio.sleep(0))
        m = {"mint": "M" * 44, "txType": "buy", "solAmount": 1.0, "tokenAmount": 10.0, "traderPublicKey": "W", "signature": "S1",
             "marketCapSol": 30.0, "vSolInBondingCurve": 31.0}
        await tr.on_trade(m)
        await tr.on_trade(dict(m))                                   # the chain feed delivers the same trade
        await tr.on_trade({**m, "signature": "S2"})
        assert len(seen) == 2
        await db.close()
    asyncio.run(run())


def test_feed_supervisor_starts_the_chain_feed_when_pumpportal_trades_are_silent(tmp_path):
    import time as _t

    from radar.db import DB
    from radar.tracker import Tracker

    async def run():
        db = DB(tmp_path / "s.db")
        await db.open()
        tr = Tracker(db)
        runs = []

        async def fake_run():
            runs.append(1)
            await asyncio.sleep(3600)
        tr.chain.run = fake_run
        extra_runs = []

        async def fake_extra():
            extra_runs.append(1)
            await asyncio.sleep(3600)
        assert tr.extras and tr.extras[0].fixed                        # a second public RPC rides alongside by default
        for f in tr.extras:
            f.run = fake_extra
        now = _t.time()
        assert await tr.feed_check(now, now - 100) == "idle"            # no launches yet: nothing to do
        tr.born = {"A": now - 5, "B": now - 20}                         # launches arriving, PumpPortal trades silent
        tr.pump.has_key = True
        assert await tr.feed_check(now, now - 10) == "idle"             # with a key, give PumpPortal 40 s after startup first
        tr.pump.has_key = False
        assert await tr.feed_check(now, now - 100) == "started"
        await asyncio.sleep(0)
        assert runs == [1] and extra_runs == [1] * len(tr.extras) and await tr.feed_check(now, now - 100) == "running"
        assert extra_runs == [1] * len(tr.extras)                       # not started twice
        tr.pump.trades_seen = [now - 1] * 50                            # PumpPortal trades come back (a key was added)
        assert await tr.feed_check(now + 400, now - 100) == "stopped"
        assert tr.feed_status()["pumpportal_trades_90s"] >= 0
        tr.chain_task.cancel()
        await db.close()
    asyncio.run(run())


def test_buyer_gate_trusts_the_curve_when_the_feed_misses_trades():
    from radar.brain import Brain
    thin = {"buyers": 2, "net_in_sol": 0.3, "metrics": {"coverage_pct": 100}}
    assert Brain.hard_no(thin) == "too few buyers"
    seen_little = {"buyers": 2, "net_in_sol": 0.3, "metrics": {"coverage_pct": 25}}   # saw a quarter of the tape: ~8 buyers
    assert Brain.hard_no(seen_little) is None and Brain.demand(seen_little)[0] == 8
    money_in = {"buyers": 0, "net_in_sol": 3.5, "metrics": {"coverage_pct": 5}}         # trades missed, but 3.5 SOL is in the curve
    assert Brain.hard_no(money_in) is None
    newborn = {"buyers": 1, "net_in_sol": 1.2, "metrics": {"coverage_pct": 100}}
    assert Brain.hard_no(newborn) == "too few buyers" and Brain.hard_no(newborn, lenient=True) is None
