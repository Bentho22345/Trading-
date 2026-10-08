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
           "RADAR_DISABLE_FIREHOSE": "1", "TELEGRAM_API_URL": f"http://127.0.0.1:{up_http}/tg", "SIGNAL_EVERY": "2"}
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
            while time.time() - t0 < 30 and not {"launch", "tokens", "trade"} <= seen.keys():
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
