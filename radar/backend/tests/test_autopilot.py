"""Autopilot: demo trading end to end against the live-scoring objects, exits, limits, real-mode safety, and wallet signing
(all offline — no transaction ever leaves the test)."""
import asyncio
import time
from types import SimpleNamespace

import pytest

from radar.autopilot import DEFAULT, REAL_PHRASE, Autopilot, merge, validate
from radar.db import DB
from radar.solwallet import TradeError, TradingWallet


class KV:
    def __init__(self):
        self.d = {}

    async def kv_get(self, k, default=None):
        return self.d.get(k, default)

    async def kv_set(self, k, v):
        self.d[k] = v


class Alerts:
    def __init__(self):
        self.sent = []

    async def send(self, kind, title, body="", **kw):
        self.sent.append((kind, title))


def launch(mint, mcap_sol=40.0, **res):
    L = SimpleNamespace(mint=mint, symbol=mint[:4].upper(), mcap_sol=mcap_sol, vsol=40.0, dev={"graduated": 0}, result=None,
                        created=time.time() - 60, deployer=res.get("deployer"))
    L.result = {"mint": mint, "symbol": L.symbol, "tier": "WATCH", "score": 50, "bundled": False, "buyers": 20, "risk": 20, "upside": 60,
                "mcap_usd": mcap_sol * 150, "age_s": 60, "scores": {"safe": 30, "balanced": 40, "degen": 55}, "metrics": {}, "flags": [],
                "strategies": [], "x": None, **res}
    return L


class Sniper:
    def __init__(self, launches):
        self.launches = {L.mint: L for L in launches}

    def board(self, appetite="", limit=25, max_age_min=30, **kw):
        rows = sorted((L.result for L in self.launches.values()), key=lambda r: -r["scores"].get(appetite, 0))
        return {"rows": rows[:limit]}

    def one(self, mint):
        L = self.launches.get(mint)
        return L.result if L else None


async def make(tmp_path, launches, **cfg):
    db = DB(tmp_path / "ap.db")
    await db.open()
    kv = KV()
    tracker = SimpleNamespace(sol_usd=150.0, launch_watch={}, token_summary=lambda m: asyncio.sleep(0, None))
    ap = Autopilot(db, kv, Sniper(launches), tracker, SimpleNamespace(ranked={}, followed=set()), None, Alerts(), None)
    await ap.load()
    if cfg:
        await ap.save(cfg)
    return ap, db


def test_config_merge_and_validation_clamps():
    c = validate(merge(DEFAULT, {"size": {"buy_sol": 50, "max_buy_sol_hard": 0.5, "max_open": 0}, "exits": {"stop_loss_pct": 400},
                                 "bogus": 1, "mode": "yolo"}))
    assert c["size"]["buy_sol"] == 0.5 and c["size"]["max_open"] == 1 and c["exits"]["stop_loss_pct"] == 95 and c["mode"] == "off"
    assert "bogus" not in c


def test_demo_buys_on_signal_then_takes_profit_and_stops_out(tmp_path):
    async def run():
        a, b = launch("AAAAmint" + "1" * 32), launch("BBBBmint" + "2" * 32, bundled=True)
        ap, db = await make(tmp_path, [a, b], size={"buy_sol": 0.1, "cooldown_s": 0})
        await ap.set_mode("demo")
        await ap.scan()
        assert len(ap.open) == 1                                             # the bundled one is filtered out
        p = next(iter(ap.open.values()))
        assert p["mint"] == a.mint and p["trigger"] == "snipe" and p["mode"] == "demo"
        assert await ap.demo_balance() == pytest.approx(10 - 0.1 - 0.0005)
        a.mcap_sol = 40.0 * 2.2                                              # 2× → first take-profit sells half
        await ap.manage()
        assert p["tp_done"] == [0] and p["tokens_left"] == pytest.approx(p["tokens"] / 2) and p["sol_out"] > 0.09
        a.mcap_sol = 40.0 * 0.5                                              # then it dumps → trailing stop / stop loss closes it
        await ap.manage()
        assert p["status"] == "closed" and not ap.open
        row = await db.one("SELECT * FROM auto_positions WHERE id=?", (p["id"],))
        assert row["status"] == "closed" and row["exit_reason"].startswith(("trailing", "stop")) and row["pnl_sol"] is not None
        orders = await db.all("SELECT side, status, reason FROM auto_orders ORDER BY id")
        assert [o["side"] for o in orders] == ["buy", "sell", "sell"] and all(o["status"] == "filled" for o in orders)
        await ap.scan()
        assert not ap.open                                                   # never re-enters the same coin
        await db.close()
    asyncio.run(run())


def test_limits_tweet_race_and_rug_exit(tmp_path):
    async def run():
        ls = [launch(f"M{i}mint" + str(i) * 32) for i in range(5)]
        race = launch("RACEmint" + "9" * 32, scores={"safe": 0, "balanced": 0, "degen": 0},
                      x={"rank": 1, "handle": "elonmusk", "score": 80})
        ap, db = await make(tmp_path, [race, *ls], size={"buy_sol": 0.1, "max_open": 2, "cooldown_s": 0})
        await ap.set_mode("demo")
        await ap.scan()
        assert len(ap.open) == 2 and ap.paused_reason is None
        assert any(p["trigger"] == "tweet_race" for p in ap.open.values())
        await ap.scan()
        assert len(ap.open) == 2 and ap.paused_reason == "max open positions"
        victim = next(p for p in ap.open.values())
        ap.sniper.launches[victim["mint"]].result["tier"] = "TRAP"
        ap.sniper.launches[victim["mint"]].result["flags"] = ["insider cluster"]
        await ap.manage()
        assert victim["status"] == "closed" and "rug exit" in victim["exit_reason"]
        # daily loss limit stops new buys
        await ap.save({"size": {"daily_loss_limit_sol": 0.0001}})
        await db.exec("UPDATE auto_positions SET pnl_sol=-1 WHERE id=?", (victim["id"],))
        assert "loss limit" in (await ap.can_buy() or "")
        n = await ap.panic()
        assert n == 1 and not ap.open and ap.c["mode"] == "off"
        await db.close()
    asyncio.run(run())


def test_real_mode_needs_password_confirmation_and_wallet(tmp_path, monkeypatch):
    async def run():
        ap, db = await make(tmp_path, [])
        ap.wallet = TradingWallet(KV(), None)
        monkeypatch.delenv("RADAR_PASSWORD", raising=False)
        with pytest.raises(ValueError, match="locked"):
            await ap.set_mode("real", REAL_PHRASE, True)
        monkeypatch.setenv("RADAR_PASSWORD", "pw")
        with pytest.raises(ValueError, match="password"):
            await ap.set_mode("real", REAL_PHRASE, False)
        with pytest.raises(ValueError, match="Type exactly"):
            await ap.set_mode("real", "yes", True)
        with pytest.raises(ValueError, match="trading wallet"):
            await ap.set_mode("real", REAL_PHRASE, True)
        await ap.wallet.create()
        assert (await ap.set_mode("real", REAL_PHRASE.lower(), True))["mode"] == "real"
        with pytest.raises(TradeError):
            await ap.wallet.create()                                         # never silently replaces a wallet
        await db.close()
    asyncio.run(run())


def test_wallet_key_is_encrypted_and_signs_offline(tmp_path, monkeypatch):
    from solders.hash import Hash
    from solders.message import MessageV0
    from solders.pubkey import Pubkey
    from solders.system_program import TransferParams, transfer
    from solders.transaction import VersionedTransaction
    monkeypatch.setenv("RADAR_SECRET", "unit-test-secret")

    async def run():
        kv = KV()
        w = TradingWallet(kv, None)
        info = await w.create()
        stored = kv.d["autopilot:wallet"]
        sk = await w.export_key()
        assert sk not in str(stored) and info["pubkey"] == stored["pubkey"]   # only ciphertext at rest
        payer = Pubkey.from_string(info["pubkey"])
        ix = transfer(TransferParams(from_pubkey=payer, to_pubkey=Pubkey.default(), lamports=1))
        msg = MessageV0.try_compile(payer, [ix], [], Hash.default())
        unsigned = bytes(VersionedTransaction.populate(msg, [__import__("solders.signature", fromlist=["Signature"]).Signature.default()]))
        signed = VersionedTransaction.from_bytes(await w.sign(unsigned))
        assert signed.verify_with_results() == [True]
    asyncio.run(run())


def test_real_buy_reads_fills_back_from_chain(tmp_path, monkeypatch):
    """The execution path with the chain and PumpPortal stubbed in-process: fills come from balance changes."""
    monkeypatch.setenv("RADAR_SECRET", "unit-test-secret")

    async def run():
        state = {"sol": 1.0, "tok": 0.0, "sent": []}

        class FakeChain:
            async def sol_balance(self, pub):
                return state["sol"]

            async def token_balance(self, owner, mint):
                return state["tok"]

            async def send(self, raw):
                state["sent"].append(raw)
                state["sol"] -= 0.1012
                state["tok"] += 2_000_000
                return "sig1"

            async def confirm(self, sig, timeout=45):
                return True

        w = TradingWallet(KV(), FakeChain())
        await w.create()

        async def fake_pp(*a, **k):
            from solders.hash import Hash
            from solders.message import MessageV0
            from solders.pubkey import Pubkey
            from solders.signature import Signature
            from solders.system_program import TransferParams, transfer
            from solders.transaction import VersionedTransaction
            payer = Pubkey.from_string(await w.pubkey())
            msg = MessageV0.try_compile(payer, [transfer(TransferParams(from_pubkey=payer, to_pubkey=Pubkey.default(), lamports=1))], [], Hash.default())
            return bytes(VersionedTransaction.populate(msg, [Signature.default()]))
        monkeypatch.setattr(w, "_pumpportal", fake_pp)
        r = await w.buy("MINT" + "x" * 40, 0.1, 15, 0.0005)
        assert r == {"sig": "sig1", "route": "pumpportal", "tokens": 2_000_000, "sol": pytest.approx(0.1012)} and state["sent"]
        state["sol"] = 0.05
        with pytest.raises(TradeError, match="not enough"):
            await w.buy("MINT" + "x" * 40, 0.1, 15, 0.0005)
    asyncio.run(run())


def test_brain_v2_buys_the_best_it_sees_exits_and_learns(tmp_path):
    from radar.brain import PRIORS, features

    async def run():
        great = launch("GREATmint" + "1" * 31, upside=95, risk=5, buyers=60, alpha=[{"rank": 3}, {"rank": 9}], eta_min=4, organic=90,
                       progress=55, net_sol_1m=8, sol_per_min=4,
                       metrics={"buy_ratio_1m": 4, "ai_meme_score": 9, "x_tweet_score": 80, "dev_graduated": 2}, deployer="DevA")
        meh = launch("MEHmint" + "2" * 33, upside=20, risk=60, buyers=8, deployer="DevB")
        trap = launch("TRAPmint" + "3" * 32, upside=99, risk=10, tier="TRAP", buyers=90, deployer="DevC")
        ap, db = await make(tmp_path, [great, meh, trap])
        await ap.set_mode("auto")
        b = ap.brain
        assert b.value(features(great.result)) > b.value(features(meh.result)) and b.hard_no(trap.result) == "TRAP"
        await b.tick("auto")
        auto = [p for p in ap.open.values() if p["mode"] == "auto"]
        assert len(auto) == 1 and auto[0]["mint"] == great.mint and auto[0]["trigger"] == "brain"   # the bar adapts: it trades the best it sees
        assert await ap.demo_balance("auto") < 10 and await ap.demo_balance("demo") == 10
        p = auto[0]
        assert 0.2 < p["sol_in"] < 2.6
        great.mcap_sol = 40 * 2.6
        for _ in range(4):                                              # it scales out rung by rung as the coin climbs
            await ap.manage()
        assert {101, 102, 103} <= set(p["tp_done"]) and p["tokens_left"] < p["tokens"] * 0.4 and p["status"] == "open"
        w_before = dict(b.w)
        great.mcap_sol = 40 * 1.5
        await ap.manage()
        assert p["status"] == "closed" and ("trailing" in p["exit_reason"] or "entry" in p["exit_reason"])
        assert b.trained == 1 and b.w != w_before and any(e["kind"] == "learn" for e in b.log)
        assert len((await b.snapshot())["weights"]) == len(PRIORS)
        await db.close()
    asyncio.run(run())


def test_brain_copies_an_influx_not_one_wallet_and_copies_top_trader_sells(tmp_path):
    async def run():
        coin = launch("COPYmint" + "4" * 32, upside=10, risk=40, buyers=12, deployer="DevX")
        other = launch("OWNNmint" + "9" * 32, upside=70, risk=10, buyers=40, deployer="DevY")
        ap, db = await make(tmp_path, [coin, other])
        W = {f"W{i}" + "a" * 38: {"rank": r} for i, r in enumerate((7, 30, 60, 15))}
        ap.traders.ranked = W
        ws = list(W)
        await ap.set_mode("auto")
        b = ap.brain
        await b.on_trade({"trader": ws[0], "mint": coin.mint, "side": "buy"})          # one top wallet alone: not copied
        assert not b.influx(coin.mint)[0]
        for w in ws[1:3]:                                                             # …three in five minutes: an influx
            await b.on_trade({"trader": w, "mint": coin.mint, "side": "buy"})
        assert b.influx(coin.mint)[0]
        b.threshold = 0
        await b.tick("auto")
        auto = {p["mint"]: p for p in ap.open.values() if p["mode"] == "auto"}
        p = auto[coin.mint]
        assert p["trigger"] == "copy" and "influx" in p["detail"] and set(p["leaders"]) == set(ws[:3])
        assert other.mint in auto and auto[other.mint]["trigger"] == "brain"          # it still makes its own picks in the same tick
        left = p["tokens_left"]
        await b.on_trade({"trader": ws[0], "mint": coin.mint, "side": "sell", "sol": 1})  # a leader gets out → we sell half
        assert p["status"] == "open" and p["tokens_left"] < left
        # a top wallet we never copied dumps the coin it bought on its own → it copies the sell
        own = auto[other.mint]
        left = own["tokens_left"]
        await b.on_trade({"trader": ws[3], "mint": other.mint, "side": "sell", "sol": 2})
        assert own["tokens_left"] < left and b.copied_sells == 2 and any("Copied a top trader" in e["text"] for e in b.log)
        await b.on_trade({"trader": ws[1], "mint": other.mint, "side": "sell", "sol": 2})   # two top wallets out → all of it
        assert own["status"] == "closed" and "top wallet" in own["exit_reason"]
        assert features_of_selling(b, other) > 0
        await db.close()
    asyncio.run(run())


def features_of_selling(b, L):
    from radar.brain import features
    return features(L.result, 0, {"smart_sells": b.smart_selling(L.mint)})["smart_selling"]


def test_brain_sells_fast_as_coins_move_and_never_gets_stuck(tmp_path):
    async def run():
        coin = launch("FASTmint" + "5" * 32, upside=60, risk=10, buyers=40)
        ap, db = await make(tmp_path, [coin])
        await ap.set_mode("auto")
        b = ap.brain
        await b.tick("auto")
        p = next(p for p in ap.open.values() if p["mode"] == "auto")
        coin.mcap_sol = 40 * 1.3
        await ap.manage()
        assert 101 in p["tp_done"] and p["status"] == "open"                     # first rung: a quick partial sell at +25%
        coin.mcap_sol = 40 * 0.98
        await ap.manage()
        assert p["status"] == "closed" and "back to entry" in p["exit_reason"]   # gave it all back → out, not a loss
        assert b.post.get(coin.mint, {}).get("kind") == "trail"                  # …and it watches what happens next
        # a flat position gets recycled quickly
        await b.tick("auto")
        ap.entered.clear()
        b.last_buy_ts = 0
        await b.tick("auto")
        q = next((q for q in ap.open.values() if q["mode"] == "auto"), None)
        if q:
            q["opened"] -= 400
            q["_high_ts"] = q["opened"]
            await ap.manage()
            assert q["status"] == "closed" and ("stalled" in q["exit_reason"] or "time stop" in q["exit_reason"])
        # the coin drops out of the live feed and nothing prices it: closed after 3 minutes instead of sitting there forever
        ap.entered.clear()
        b.last_buy_ts = 0
        await b.tick("auto")
        z = next(z for z in ap.open.values() if z["mode"] == "auto")
        ap.sniper.launches.pop(coin.mint)
        await ap.manage()
        assert z["status"] == "open" and "_no_px" in z
        z["_no_px"] -= 200
        await ap.manage()
        assert z["status"] == "closed" and "price feed lost" in z["exit_reason"]
        await db.close()
    asyncio.run(run())


def test_brain_shadow_learning_and_kelly_sizing(tmp_path):
    async def run():
        a = launch("SHADmint" + "5" * 32, upside=50, risk=20, buyers=30)
        ap, db = await make(tmp_path, [a])
        b = ap.brain
        await b.tick("auto")                                            # off mode? tick still scores & samples
        assert a.mint in b.shadow
        a.mcap_sol = 40 * 2.0
        b.shadow[a.mint]["ts"] -= 1300                                  # 20 minutes later…
        w0 = dict(b.w)
        await b.shadow_step(time.time())
        assert b.shadow_trained == 1 and b.shadow_hits == 1 and b.w != w0
        b.stats_cache = {"n": 20, "wr": 0.5, "avg_win": 1.5, "avg_loss": 0.3}   # wins 1.5×-sized vs losses → Kelly says bet more
        big = b.size(10, 1.0, "auto")
        b.stats_cache = {"n": 20, "wr": 0.2, "avg_win": 0.5, "avg_loss": 0.4}
        small = b.size(10, 1.0, "auto")
        assert big > small and small >= 0.02
        await ap.save({"size": {"buy_sol": 0.05, "max_buy_sol_hard": 0.05}})
        assert b.size(10, 1.0, "real") == 0.05                          # real money never exceeds your hard cap
        await b.set_aggression("degen")
        assert b.aggression == "degen"
        await db.close()
    asyncio.run(run())


def test_brain_v3_hyper_default_and_narrative_signals(tmp_path):
    from radar.brain import AGGRESSION, features

    async def run():
        coin = launch("NARRmint" + "6" * 32, upside=30, risk=30, buyers=20)
        ap, db = await make(tmp_path, [coin])
        b = ap.brain
        assert b.aggression == "hyper" and AGGRESSION["hyper"]["max_open"] >= 20
        plain = b.value(features(coin.result))
        hot = b.value(features(coin.result, 0, {"narr": {"strength": 90, "stage": "ignition", "z": 6, "bot_share": 0}, "x_calls": 2}))
        botted = b.value(features(coin.result, 0, {"narr": {"strength": 90, "stage": "ignition", "z": 6, "bot_share": 0.8}, "x_calls": 0}))
        assert hot > botted > plain - 10 and hot - plain > 15          # a live, igniting narrative + X calls move it a lot
        await db.close()
    asyncio.run(run())


def _tape_launch(mint, trades, vsol=60.0, peak=None, **res):
    from collections import deque
    L = launch(mint, mcap_sol=vsol * vsol / 30 * 0 + 40.0 * (vsol / 40.0) ** 2, **res)
    L.trades = deque(trades, maxlen=1500)
    L.vsol, L.peak_mcap_sol = vsol, peak or L.mcap_sol
    L.balances, L.buyers, L.intel, L.dev_tokens, L.dev_sold_tokens, L.dev_buy_pct, L.graduated_at = {}, {}, None, 0, 0, None, None
    for t in trades:
        if t[1] == "buy":
            L.buyers.setdefault(t[4], t[0])
            L.balances[t[4]] = L.balances.get(t[4], 0) + t[3]
        else:
            L.balances[t[4]] = max(0, L.balances.get(t[4], 0) - t[3])
    return L


def test_patterns_read_flows_and_rug_tells_off_the_tape():
    from radar import patterns as pat
    now = time.time()
    # healthy: steady buying from many wallets, liquidity climbing, higher lows
    good = [(now - 280 + i * 4, "buy", 0.3 + (i % 3) * 0.1, 1e6, f"w{i}", 32 + i * 0.4) for i in range(70)]
    g = _tape_launch("GOODmint" + "1" * 32, good, vsol=60.0)
    cg = pat.chart(g, now)
    ng = pat.normalise(cg, 300, 9000)
    assert cg["holders"] == 70 and cg["liq_delta"] > 0 and ng["staircase"] >= 0.75 and pat.rug_alarm(cg) is None
    # rug: liquidity in, then one wallet dumps most of it
    rug = good[:60] + [(now - 20, "sell", 18.0, 3e7, "whale", 40.0), (now - 10, "sell", 2.0, 2e6, "whale", 37.0)]
    r = _tape_launch("RUGGmint" + "2" * 32, rug, vsol=37.0, peak=200.0)
    cr = pat.chart(r, now)
    assert pat.rug_alarm(cr) and pat.normalise(cr, 300, 9000)["dump_candle"] == 1.0
    # bubble map from the tape: four wallets, same second, same size
    bundle = [(now - 200, "buy", 1.0, 5e7, f"b{i}", 35.0) for i in range(4)] + good[:10]
    b = _tape_launch("BUNDmint" + "3" * 32, bundle)
    cb = pat.chart(b, now)
    assert cb["coord_wallets"] == 4 and cb["coord_hold"] >= 19
    assert "coordinated-buys" in pat.tags(pat.normalise(cb, 200, 9000) | {"top10": 0.2}, "brain")


def test_brain_v4_gets_discouraged_learns_patterns_benches_and_adapts_stops(tmp_path):
    async def run():
        coin = launch("MOODmint" + "7" * 32, upside=40, risk=20, buyers=30, deployer="DevRug")
        ap, db = await make(tmp_path, [coin])
        b = ap.brain
        f = {"upside": 0.4, "age_0_2m": 1.0, "dev_serial": 1.0, "top10": 0.2}
        mood0, size0 = b.mood_factor(), b.size(10, 0.5, "auto")
        for i in range(6):                                              # six losers in a row, all young serial-dev coins
            p = {"id": 1000 + i, "mint": coin.mint, "symbol": "MOOD", "sol_in": 1.0, "sol_out": 0.6, "exit_reason": "stop −40%",
                 "features": f, "leaders0": ["Lead" + "x" * 40], "brain_trig": "copy", "entry_mcap_sol": 40.0}
            await b.learn(p)
        assert b.mood_factor() < mood0 - 0.3 and b.size(10, 0.5, "auto") < size0 and b.streak == -6
        assert b.cool_until > time.time() and b.mood_word() == "cooling off"
        assert b.benched("Lead" + "x" * 40) and "DevRug" not in b.bad_devs          # stops, not rugs: dev not blocked yet
        # those patterns now carry a penalty on top of the model
        for i in range(6):
            await b.learn({"id": 2000 + i, "mint": "OTHER", "symbol": "WIN", "sol_in": 1.0, "sol_out": 1.6, "exit_reason": "trailing stop",
                           "features": {"upside": 0.4, "age_5_15m": 1.0, "top10": 0.2}, "brain_trig": "brain"})
        adj, worst = b.tag_adj(__import__("radar.patterns", fromlist=["tags"]).tags(f, "copy"))
        assert adj < 0 and worst and any("Pattern learned" in e["text"] for e in b.log)
        assert b.mood_factor() > 0.35                                    # wins bring it back
        # a rug burns the dev
        await b.learn({"id": 3000, "mint": coin.mint, "symbol": "MOOD", "sol_in": 1.0, "sol_out": 0.1, "exit_reason": "rug pattern: x",
                       "features": f, "brain_trig": "brain"})
        assert "DevRug" in b.bad_devs and b.veto(coin, time.time()) == "dev burnt it before"
        # adaptive stop: stopped out, then the coin ran → stops get more room
        s0 = b.stop_pct()
        b.post[coin.mint] = {"ts": time.time() - 1000, "kind": "stop", "symbol": "MOOD", "entry": 40.0, "exit": 24.0, "max": 24.0, "min": 24.0}
        coin.mcap_sol = 60.0
        lessons = b.post_mortem(time.time())
        assert b.stop_pct() > s0 and lessons and "shaken out" in lessons[0][1] and b.exit_stats["shaken"] == 1
        await db.close()
    asyncio.run(run())


def test_brain_v4_replay_memory_survives_a_restart_and_rug_model_learns(tmp_path):
    from radar.brain import Brain

    async def run():
        coin = launch("REPLmint" + "8" * 32, upside=50, risk=20, buyers=30)
        ap, db = await make(tmp_path, [coin])
        b = ap.brain
        rugish = {"upside": 0.3, "dev_serial": 1.0, "coordinated": 1.0, "liq_drain": 1.0}
        p0 = b.rug.p(rugish)
        for i in range(60):
            b._remember(rugish, 0.0, 1.0, 1.0, "shadow")
            b.rug.step(rugish, 1.0, 0.03)
        assert b.rug.p(rugish) > p0
        b.rehearse(48)
        assert b.rehearsed == 48
        await b.save()
        b2 = Brain(ap)
        await b2.load()
        assert len(b2.replay) == 60 and b2.rug.n == b.rug.n and b2.rehearsed == 48
        snap = await b.snapshot()
        assert snap["learning"]["replay"] == 60 and snap["mood"]["word"] and "rug_model" in snap and "patterns" in snap
        await db.close()
    asyncio.run(run())


def test_patterns_read_the_apes_and_the_top():
    from radar import patterns as pat
    now = time.time()
    # a run that's topping: lots of buyers a minute ago, almost none now, price at the high, first buyers gone
    trades = [(now - 165 + i * 1.4, "buy", 0.5, 1e6, f"a{i}", 31 + i * 0.25) for i in range(110)]
    trades += [(now - 5, "buy", 0.1, 1e5, "late", 31 + 110 * 0.25)]
    L = _tape_launch("TOPPmint" + "1" * 32, trades, vsol=31 + 110 * 0.25)
    for w in [f"a{i}" for i in range(20)]:
        L.balances[w] = 0                                       # the first 20 buyers have sold
    c = pat.chart(L, now)
    n = pat.normalise(c, 200, 20000)
    assert n["early_exit"] == 1.0 and n["ape_accel"] < 0 and n["exhaustion"] > 0.3
    # an ape wave starting: new buyers in the last 10 seconds
    wave = [(now - 9 + i * 0.5, "buy", 0.3, 1e6, f"n{i}", 35 + i * 0.2) for i in range(16)]
    W = _tape_launch("WAVEmint" + "2" * 32, wave, vsol=38.0)
    nw = pat.normalise(pat.chart(W, now), 30, 5000)
    assert nw["ape_wave"] == 1.0 and nw["ape_accel"] > 0.5


def test_brain_v6_timing_models_learn_the_tape_and_drive_exits(tmp_path):
    async def run():
        coin = launch("TIMEmint" + "3" * 32, upside=60, risk=10, buyers=40)
        ap, db = await make(tmp_path, [coin])
        b = ap.brain
        f = {"exhaustion": 1.0, "early_exit": 1.0, "upside": 0.5}
        dn0 = b.dn.p(f)
        for i in range(30):                                         # snapshots taken, then the coin dumps −15% first
            b.tsnap[f"k{i}"] = {"mint": coin.mint, "ts": time.time(), "vec": b._vec(f), "px": 40.0, "up": None}
        coin.mcap_sol = 33.0
        b.timing_step(time.time())
        assert not b.tsnap and b.dn.p(f) > dn0 and b.dn.n == 30 and len(b.replay_t) == 30
        # once trained, a held coin with a high DOWN read gets sold — half if it's up, all of it if it isn't
        await ap.set_mode("auto")
        coin.mcap_sol = 40.0
        await b.tick("auto")
        p = next(p for p in ap.open.values() if p["mode"] == "auto")
        b.dn.n = 500
        b.cache[coin.mint]["dn"] = 0.7
        coin.mcap_sol = 40 * 1.1
        ex = b.exit_for(p, coin.result, 1.1, 1.1)
        assert ex and ex[0] == 0.5 and "timing model" in ex[1]
        p["_dn_ts"] = 0
        b.cache[coin.mint]["dn"] = 0.9
        ex = b.exit_for(p, coin.result, 1.1, 1.1)
        assert ex[0] == 1.0 and p["_exit_kind"] == "model"
        # the timing model also blocks new entries into coins it thinks are about to dump
        assert "timing model" in (b.veto(coin, time.time()) or "")
        await db.close()
    asyncio.run(run())


def test_brain_v6_sells_into_graduation_and_caps_size_by_liquidity(tmp_path):
    async def run():
        coin = launch("GRADmint" + "4" * 32, upside=60, risk=10, buyers=40)
        coin.vsol = 31.0                                            # a thin curve: ~4% impact cap ≈ ◎1.24
        ap, db = await make(tmp_path, [coin])
        b = ap.brain
        await ap.set_mode("auto")
        await b._buy(coin.mint, 5.0, "auto", "brain", "test", coin.result, {"upside": 0.6}, 50.0, [])
        p = next(p for p in ap.open.values() if p["mode"] == "auto")
        assert p["sol_in"] < 1.3 and "capped" in p["detail"]
        coin.graduated_at = time.time()
        ex = b.exit_for(p, coin.result, 1.05, 1.05)
        assert ex and ex[0] == b.grad_frac and "graduated" in ex[1] and any(k.endswith("#grad") for k in b.post)
        assert b.exit_for(p, coin.result, 1.05, 1.05) is None or "graduated" not in b.exit_for(p, coin.result, 1.05, 1.05)[1]
        # it learns from what the coin did after: it kept running → sell less into migrations next time
        k = next(k for k in b.post if k.endswith("#grad"))
        b.post[k]["ts"] -= 1000
        coin.mcap_sol = b.post[k]["exit"] * 2
        g0 = b.grad_frac
        b.post_mortem(time.time())
        assert b.grad_frac < g0
        await db.close()
    asyncio.run(run())
