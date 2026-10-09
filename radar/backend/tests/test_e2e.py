"""End to end: fake upstreams -> real app -> REST + live WebSocket to the UI."""
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
import websockets

from .fixtures import MINT, MINT_BAD

ROOT = Path(__file__).resolve().parents[1]


_UPSTREAM: list[str] = []


def stack_upstream() -> str:
    return _UPSTREAM[0]


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def wait_http(url: str, timeout: float = 20) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            httpx.get(url, timeout=1)
            return
        except httpx.HTTPError:
            time.sleep(0.2)
    raise TimeoutError(url)


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    up_http, up_ws, app_port = free_port(), free_port(), free_port()
    fake = subprocess.Popen([sys.executable, "tests/fake_upstream.py", str(up_http), str(up_ws), "0.5"], cwd=ROOT)
    env = {**os.environ, "PORT": str(app_port), "HOST": "127.0.0.1",
           "RADAR_DB_PATH": str(tmp_path_factory.mktemp("db") / "radar.db"),
           "PUMPPORTAL_WS_URL": f"ws://127.0.0.1:{up_ws}", "COINBASE_WS_URL": "ws://127.0.0.1:9",
           "DEXSCREENER_URL": f"http://127.0.0.1:{up_http}/dex", "GECKOTERMINAL_URL": f"http://127.0.0.1:{up_http}/gecko",
           "RUGCHECK_URL": f"http://127.0.0.1:{up_http}/rug", "TIER3_EVERY": "1", "LOG_LEVEL": "WARNING",
           "RADAR_WEB_DIR": "/nonexistent", "HTTPS_PROXY": "", "https_proxy": "", "RADAR_ENABLE_FIXTURES": "1",
           "RADAR_DISABLE_FIREHOSE": "1", "TELEGRAM_API_URL": f"http://127.0.0.1:{up_http}/tg", "SIGNAL_EVERY": "2",
           "TRADER_COMPUTE_EVERY": "2", "TRADER_HARVEST_EVERY": "0.3", "TRADER_GECKO_RPM": "600"}
    app = subprocess.Popen([sys.executable, "-m", "radar"], cwd=ROOT, env=env)
    wait_http(f"http://127.0.0.1:{up_http}/dex/token-profiles/latest/v1")
    _UPSTREAM.append(f"127.0.0.1:{up_http}")
    wait_http(f"http://127.0.0.1:{app_port}/api/health")
    yield f"127.0.0.1:{app_port}"

    app.terminate()
    fake.terminate()
    app.wait(10)
    fake.wait(10)


def test_live_launch_reaches_ui_and_gets_market_data(stack):
    async def run():
        seen: dict[str, list] = {}
        async with websockets.connect(f"ws://{stack}/ws") as ws:
            await ws.send(json.dumps({"view": [MINT]}))
            t0 = time.time()
            def done() -> bool:
                return ("launch" in seen and any(t["address"] == MINT and t["liquidity_usd"] for rows in seen.get("tokens", []) for t in rows)
                        and any(t["mint"] == MINT for t in seen.get("trade", [])))
            while time.time() - t0 < 30 and not done():
                msg = json.loads(await asyncio.wait_for(ws.recv(), 30))
                seen.setdefault(msg["ch"], []).append(msg["data"])
        return seen
    seen = asyncio.run(run())
    assert all(l["address"] and l["symbol"] for l in seen["launch"])
    assert any(l["address"] == MINT and l["symbol"] == "HAWKTUAH" for l in httpx.get(f"http://{stack}/api/launches").json())
    assert any(t["address"] == MINT and t["liquidity_usd"] for rows in seen["tokens"] for t in rows)
    assert any(t["mint"] == MINT for t in seen["trade"])

    detail = httpx.get(f"http://{stack}/api/token/{MINT}").json()
    assert detail["token"]["symbol"] == "HAWKTUAH" and detail["token"]["price_usd"] > 0
    assert detail["safety"]["mint_authority"] == "" and detail["safety"]["lp_locked_pct"] == 100
    assert detail["trades"] and "Most memecoins go to zero" in detail["disclaimer"]
    assert httpx.get(f"http://{stack}/api/token/{MINT}/ohlcv?tf=5m").json()["candles"]
    assert httpx.get(f"http://{stack}/api/launches").json()
    health = {a["name"]: a for a in httpx.get(f"http://{stack}/api/health").json()["adapters"]}
    assert health["pumpportal"]["status"] == "ok" and health["dexscreener"]["status"] == "ok"


def test_mint_authority_surfaces_in_safety(stack):
    httpx.post(f"http://{stack}/api/token/{MINT_BAD}/safety")
    for _ in range(40):
        rep = httpx.get(f"http://{stack}/api/token/{MINT_BAD}")
        if rep.status_code == 200 and rep.json()["safety"]:
            break
        time.sleep(0.25)
    s = rep.json()["safety"]
    assert s["mint_authority"].startswith("Auth")
    assert any("Mint" in r["name"] for r in s["risks"])


def test_connectors_and_custom_sources(stack):
    c = httpx.get(f"http://{stack}/api/connectors").json()
    ids = {x["id"]: x for x in c["connectors"]}
    assert ids["dexscreener"]["kind"] == "keyless" and ids["x"]["state"] == "needs_key"
    r = httpx.post(f"http://{stack}/api/connectors/wallet", json={"values": {"address": "not-valid"}}).json()
    assert r["status"] == "error"
    r = httpx.post(f"http://{stack}/api/connectors/wallet", json={"values": {"address": MINT}}).json()
    assert r["status"] == "ok"
    assert httpx.post(f"http://{stack}/api/sources", json={"url": "ftp://x"}).status_code == 400


def test_flash_vip_ca_under_5s_on_screen_and_telegram(stack):
    r = httpx.post(f"http://{stack}/api/connectors/telegram_bot", json={"values": {"bot_token": "123:abc", "chat_id": "42"}}).json()
    assert r["status"] == "ok", r
    ca = "FLaSH1111111111111111111111111111111111pump"

    async def run():
        async with websockets.connect(f"ws://{stack}/ws") as ws:
            t0 = time.time()
            httpx.post(f"http://{stack}/api/dev/simulate-vip-post",
                       json={"author": "realDonaldTrump", "text": f"My NEW Official Meme is HERE! CA: {ca}"})
            while time.time() - t0 < 5:
                msg = json.loads(await asyncio.wait_for(ws.recv(), 5))
                if msg["ch"] == "flash" and msg["data"].get("token_address") == ca:
                    return time.time() - t0, msg["data"]
        raise AssertionError("no flash within 5s")
    elapsed, flash = asyncio.run(run())
    assert elapsed < 5 and flash["latency_ms"] < 5000 and flash["links"]["axiom"].endswith(ca)
    fake = stack_upstream()
    for _ in range(50):
        log = httpx.get(f"http://{fake}/tg/log").json()
        hit = [x for x in log if ca in x["text"]]
        if hit:
            break
        time.sleep(0.1)
    assert hit and hit[0]["ts"] - flash["post_ts"] < 5
    f = httpx.get(f"http://{stack}/api/flash").json()
    assert f["events"][0]["token_address"] == ca and f["events"][0]["is_fixture"] == 1


def test_signals_are_logged_and_paper_traded(stack):
    for _ in range(60):
        sigs = httpx.get(f"http://{stack}/api/signals?include_avoid=true").json()
        if sigs:
            break
        time.sleep(0.5)
    assert sigs and all(s["verdict"] in ("BUY", "WATCH", "AVOID") for s in sigs)
    full = httpx.get(f"http://{stack}/api/signal/{sigs[0]['id']}").json()
    assert full["inputs"]["token"]["address"] == sigs[0]["token_address"]
    paper = httpx.get(f"http://{stack}/api/paper").json()
    assert paper and paper[0]["signal_id"]
    sc = httpx.get(f"http://{stack}/api/scorecard").json()
    assert sc["overall"]["n"] >= 1 and "verdict" in sc
    bt = httpx.post(f"http://{stack}/api/backtest", json={"hours": 1}).json()
    assert bt["signals"] >= 1


def test_mint_authority_token_signal_is_avoid(stack):
    httpx.post(f"http://{stack}/api/watchlist/{MINT_BAD}")
    for _ in range(40):
        r = httpx.post(f"http://{stack}/api/token/{MINT_BAD}/evaluate")
        if r.status_code == 200 and httpx.get(f"http://{stack}/api/token/{MINT_BAD}").json()["safety"]:
            r = httpx.post(f"http://{stack}/api/token/{MINT_BAD}/evaluate")
            break
        time.sleep(0.5)
    assert r.status_code == 200, r.text
    assert r.json()["verdict"] == "AVOID" and "Mint authority is active" in r.json()["vetoes"]


def test_feature_endpoints(stack):
    for path in ("/api/narratives", "/api/social", "/api/wallets", "/api/rotation", "/api/risk", "/api/settings", "/api/spend",
                 "/api/alerts", "/api/social/stats", "/api/briefs"):
        assert httpx.get(f"http://{stack}{path}").status_code == 200, path
    b = httpx.post(f"http://{stack}/api/brief").json()
    assert "Radar brief" in b["body"] and b["model"] == "template"
    p = httpx.post(f"http://{stack}/api/positions", json={"token_address": MINT, "entry_price": 0.00005, "size_usd": 20}).json()
    r = httpx.post(f"http://{stack}/api/positions/{p['id']}/close", json={"exit_price": 0.0001}).json()
    assert r["realized_usd"] == 20.0
    t = httpx.get(f"http://{stack}/api/tokens?safe_only=true&min_liq=1000&q=HAWK").json()
    assert all(x["symbol"] and "HAWK" in x["symbol"] for x in t)
    assert httpx.post(f"http://{stack}/api/ask", json={"question": "hi"}).json()["answer"].startswith("Ask Radar needs")


def test_password_gate(tmp_path):
    port = free_port()
    env = {**os.environ, "PORT": str(port), "HOST": "127.0.0.1", "RADAR_DB_PATH": str(tmp_path / "r.db"),
           "RADAR_PASSWORD": "hunter2-correct-horse", "RADAR_DISABLE_INGEST": "1", "RADAR_WEB_DIR": "/nonexistent",
           "LOG_LEVEL": "WARNING", "HTTPS_PROXY": "", "https_proxy": ""}
    p = subprocess.Popen([sys.executable, "-m", "radar"], cwd=ROOT, env=env)
    try:
        wait_http(f"http://127.0.0.1:{port}/api/healthz")
        base = f"http://127.0.0.1:{port}"
        assert httpx.get(f"{base}/api/healthz").status_code == 200
        assert httpx.get(f"{base}/api/connectors").status_code == 401
        assert httpx.get(f"{base}/api/session").json() == {"auth_required": True, "authed": False}
        assert httpx.post(f"{base}/api/login", json={"password": "nope"}).status_code == 401
        with httpx.Client(base_url=base) as c:
            assert c.post("/api/login", json={"password": "hunter2-correct-horse"}).status_code == 200
            assert c.get("/api/connectors").status_code == 200

        async def ws_denied():
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
                await ws.recv()
        with pytest.raises((websockets.exceptions.ConnectionClosed, websockets.exceptions.InvalidStatus)):
            asyncio.run(ws_denied())
    finally:
        p.terminate()
        p.wait(10)


def test_discovery_endpoints(stack):
    w = httpx.post(f"http://{stack}/api/launch-watches", json={"terms": ["fake"], "label": "fakes"}).json()
    assert w["id"]
    for path in ("/api/discover/climbers", "/api/discover/launching", "/api/discover/emerging", "/api/launch-watches"):
        r = httpx.get(f"http://{stack}{path}")
        assert r.status_code == 200, (path, r.text)
    assert httpx.get(f"http://{stack}/api/search?q=HAWK").json()["tokens"][0]["symbol"] == "HAWKTUAH"
    sp = httpx.get(f"http://{stack}/api/sparks?a={MINT}").json()
    assert MINT in sp and len(sp[MINT]) >= 1
    st = httpx.get(f"http://{stack}/api/token/{MINT}/story").json()
    assert st["method"] == "heuristic" and "narratives" in st and "linked" in st
    for _ in range(40):  # the fake feed launches "Fake xxxx" tokens every 0.5s -> Launch Watch must fire
        hits = [x for x in httpx.get(f"http://{stack}/api/launch-watches").json() if x["id"] == w["id"]]
        if hits and hits[0]["hits"]:
            break
        time.sleep(0.25)
    assert hits[0]["hits"] >= 1
    assert any("Launch Watch" in a["title"] for a in httpx.get(f"http://{stack}/api/alerts").json())


def test_top_traders_pipeline(stack):
    for _ in range(60):
        lb = httpx.get(f"http://{stack}/api/traders?win=7d").json()
        if lb["total"] >= 6:
            break
        time.sleep(0.5)
    assert lb["total"] >= 6, lb
    top = lb["rows"][0]
    assert top["rank"] == 1 and top["pnl_usd"] > 0 and top["tokens"] >= 3 and "geckoterminal" in top["sources"]
    assert lb["rows"][-1]["pnl_usd"] < top["pnl_usd"]
    s = httpx.get(f"http://{stack}/api/traders/summary").json()
    assert s["ranked"] >= 6 and s["pool"] >= 6 and s["cap"] == 5000 and s["top"]
    w = httpx.get(f"http://{stack}/api/traders/{top['address']}").json()
    assert w["stats"]["7d"]["rank"] == 1 and w["positions"] and w["trades"]
    assert httpx.post(f"http://{stack}/api/traders/{top['address']}/follow", json={"on": True, "label": "whale"}).json()["followed"]
    assert httpx.get(f"http://{stack}/api/traders?followed=true&win=7d").json()["rows"][0]["label"] == "whale"
    imp = httpx.post(f"http://{stack}/api/traders/import", json={"text": "GJR1111111111111111111111111111111111111 my kol"}).json()
    assert imp["imported"] == 1
    st = httpx.get(f"http://{stack}/api/traders/status").json()
    assert st["backfill"]["pinned"] >= 1 and any(x["source"] == "geckoterminal" for x in st["sources"])
    p = httpx.get(f"http://{stack}/api/pulse").json()
    assert {"new", "final_stretch", "migrated"} <= p.keys() and p["new"]


def test_top_wallet_trade_reaches_ui_and_chart(stack):
    async def run():
        async with websockets.connect(f"ws://{stack}/ws") as ws:
            r = httpx.post(f"http://{stack}/api/dev/simulate-top-trade", json={"wallet": "TopW1", "mint": MINT, "sol": 3, "rank": 4}).json()
            t0 = time.time()
            while time.time() - t0 < 25:   # the socket is busy (every launch is re-scored live); give the event room
                msg = json.loads(await asyncio.wait_for(ws.recv(), 25))
                if msg["ch"] == "top_trade" and msg["data"]["signature"] == r["signature"]:
                    return msg["data"]
    data = asyncio.run(run())
    assert data and data["rank"] == 4 and data["side"] == "buy" and data["is_fixture"]
    assert any(t["signature"] == data["signature"] for t in httpx.get(f"http://{stack}/api/top-trades").json())
    smart = httpx.get(f"http://{stack}/api/token/{MINT}").json()["smart_trades"]
    assert any(t["wallet"] == "TopW1" for t in smart)  # drawn as a chart marker on the token page


def test_snipe_board_scores_launches_live_and_logs_calls(stack):
    """Runner launches (distinct buyers, rising curve, a ranked wallet early) climb the board; bundles are flagged TRAP."""
    async def run():
        got: list[dict] = []
        async with websockets.connect(f"ws://{stack}/ws") as ws:
            t0 = time.time()
            while time.time() - t0 < 40:
                msg = json.loads(await asyncio.wait_for(ws.recv(), 30))
                if msg["ch"] in ("snipe", "snipe_batch"):
                    got.extend(msg["data"] if msg["ch"] == "snipe_batch" else [msg["data"]])
                    tiers = {g["tier"] for g in got}
                    if "TRAP" in tiers and any(g["tier"] in ("SNIPE", "WATCH") and g["buyers"] >= 8 for g in got):
                        break
        return got
    got = asyncio.run(run())
    tiers = {g["tier"] for g in got}
    assert "TRAP" in tiers and tiers & {"SNIPE", "WATCH"}
    trap = next(g for g in got if g["tier"] == "TRAP")
    assert trap["bundled"] and "bundled launch" in trap["flags"]
    hot = max((g for g in got if g["tier"] in ("SNIPE", "WATCH") and g["buyers"] >= 8), key=lambda g: g["score"])
    assert {d["key"] for d in hot["detectors"]} >= {"velocity", "organic"} and hot["buyers"] >= 5

    board = httpx.get(f"http://{stack}/api/snipe").json()
    assert board["rows"] and board["tracking"] >= 1 and board["seen"] >= 1
    assert httpx.get(f"http://{stack}/api/snipe?hide_bundled=true").json()["rows"]
    assert not any(r["bundled"] for r in httpx.get(f"http://{stack}/api/snipe?hide_bundled=true").json()["rows"])
    one = httpx.get(f"http://{stack}/api/snipe/{hot['mint']}").json()
    assert one["mint"] == hot["mint"] and "dev" in one

    # charts merge GeckoTerminal history with Radar's own trade stream; bars strictly ascending, supply known for MCAP view
    c = httpx.get(f"http://{stack}/api/token/{hot['mint']}/ohlcv?tf=1m").json()
    assert c["candles"] and c["source"] and c["supply"] > 0
    assert all(a["time"] < b["time"] for a, b in zip(c["candles"], c["candles"][1:]))

    proof = httpx.get(f"http://{stack}/api/snipe/proof?hours=1").json()
    assert proof["stats"]["launches_seen"] >= 1
    for r in proof["calls"]:
        assert r["peak_x"] is None or r["peak_x"] >= 0.0


def test_mayhem_hidden_metadata_strategies_and_playbook(stack):
    t0 = time.time()
    rows: list[dict] = []
    while time.time() - t0 < 30:
        rows = httpx.get(f"http://{stack}/api/snipe?max_age_min=30&limit=300&appetite=degen").json()["rows"]
        if any(r.get("links") for r in rows) and any(r.get("strategies") for r in rows) and len(rows) >= 12:
            break
        time.sleep(1)
    # Mayhem launches (2B supply) are never shown anywhere
    assert not any(r["symbol"] == "MAYHM" for r in rows)
    assert not any(l.get("symbol") == "MAYHM" for l in httpx.get(f"http://{stack}/api/launches?limit=300").json())
    # degen ranking is by appetite score; every row carries the trader-terminal metrics
    scores = [r["scores"]["degen"] for r in rows]
    assert scores == sorted(scores, reverse=True)
    r0 = rows[0]
    assert {"holders", "top10_pct", "dev_hold_pct", "snipers_hold_pct", "bundle_hold_pct", "pro_traders", "coverage_pct"} <= set(r0["metrics"])
    assert any(r.get("links", {}).get("twitter") for r in rows) and any(r["metrics"]["x_community"] for r in rows)
    # strategies: presets loaded, matches recorded, filters work server-side
    strats = {s["id"]: s for s in httpx.get(f"http://{stack}/api/strategies").json()}
    assert {"clean-launch", "first-30s", "degen-lottery", "cto"} <= set(strats)
    hit = next(r for r in rows if r.get("strategies"))
    sid = hit["strategies"][0]
    assert any(x["mint"] == hit["mint"] for x in httpx.get(f"http://{stack}/api/snipe?strategy={sid}&limit=300").json()["rows"])
    rules = json.dumps([{"metric": "holders", "op": ">=", "value": 5}])
    for r in httpx.get(f"http://{stack}/api/snipe", params={"rules": rules, "limit": 300}).json()["rows"]:
        assert r["metrics"]["holders"] >= 5
    # custom strategy round trip
    sid2 = httpx.post(f"http://{stack}/api/strategies", json={"name": "My degen", "rules": [{"metric": "buyers", "op": ">=", "value": 3}]}).json()["id"]
    assert sid2 == "custom-my-degen" and any(s["id"] == sid2 for s in httpx.get(f"http://{stack}/api/strategies").json())
    assert httpx.post(f"http://{stack}/api/strategies", json={"id": "cto", "name": "x", "rules": [{"metric": "buyers", "op": ">=", "value": 1}]}).status_code == 400
    # playbook: seeded guides digested into a crowd consensus; a pasted transcript is digested by the parser
    pid = httpx.post(f"http://{stack}/api/playbook", json={"url": "https://www.tiktok.com/@trader/video/1", "title": "my filters",
                                                          "text": "I only buy when top 10 holders under 25% and at least 40 holders"}).json()["id"]
    t0 = time.time()
    while time.time() - t0 < 10:
        pb = httpx.get(f"http://{stack}/api/playbook").json()
        src = next(s for s in pb["sources"] if s["id"] == pid)
        if src["status"] == "digested":
            break
        time.sleep(0.3)
    assert src["kind"] == "tiktok" and {(r["metric"], r["value"]) for r in src["rules"]} >= {("top10_pct", 25), ("holders", 40)}
    assert pb["consensus"] and any(c["metric"] == "top10_pct" for c in pb["consensus"])
    assert any(s["id"] == "crowd-consensus" for s in httpx.get(f"http://{stack}/api/strategies").json())


def test_telegram_chat_id_found_automatically(stack):
    httpx.delete(f"http://{stack}/api/connectors/telegram_bot")
    bad = httpx.post(f"http://{stack}/api/connectors/telegram_bot", json={"values": {"bot_token": "bad:token"}}).json()
    assert bad["status"] == "error" and "rejected that bot token" in bad["message"]
    httpx.delete(f"http://{stack}/api/connectors/telegram_bot")
    r = httpx.post(f"http://{stack}/api/connectors/telegram_bot", json={"values": {"bot_token": "123:abc"}}).json()
    assert r["status"] == "ok", r
    conns = {c["id"]: c for c in httpx.get(f"http://{stack}/api/connectors").json()["connectors"]}
    chat = next(f for f in conns["telegram_bot"]["fields"] if f["name"] == "chat_id")
    assert chat["value"] == "555123"
