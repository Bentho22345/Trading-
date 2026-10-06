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
           "PUMPPORTAL_WS_URL": f"ws://127.0.0.1:{up_ws}", "COINBASE_WS_URL": f"ws://127.0.0.1:{up_ws}",
           "DEXSCREENER_URL": f"http://127.0.0.1:{up_http}/dex", "GECKOTERMINAL_URL": f"http://127.0.0.1:{up_http}/gecko",
           "RUGCHECK_URL": f"http://127.0.0.1:{up_http}/rug", "TIER3_EVERY": "1", "LOG_LEVEL": "WARNING",
           "RADAR_WEB_DIR": "/nonexistent", "HTTPS_PROXY": "", "https_proxy": ""}
    app = subprocess.Popen([sys.executable, "-m", "radar"], cwd=ROOT, env=env)
    wait_http(f"http://127.0.0.1:{up_http}/dex/token-profiles/latest/v1")
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
            while time.time() - t0 < 15 and not {"launch", "tokens", "trade"} <= seen.keys():
                msg = json.loads(await asyncio.wait_for(ws.recv(), 15))
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
