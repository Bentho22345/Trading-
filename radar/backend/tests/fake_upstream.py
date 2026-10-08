"""TEST-ONLY fake upstreams (PumpPortal WS + DexScreener/GeckoTerminal/RugCheck REST).

Used by the end-to-end test and for offline UI development. Never used by the real app:
it only runs if you point the *_URL env vars at it.
"""
from __future__ import annotations

import asyncio
import copy
import json
import random
import sys
from pathlib import Path

import uvicorn
import websockets
from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests import fixtures as fx  # noqa: E402

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
api = FastAPI()
created: list[str] = [fx.MINT]
pairs: dict[str, dict] = {}


def mint_id() -> str:
    return "".join(random.choice(B58) for _ in range(40)) + "pump"


def pair_for(addr: str) -> dict:
    if addr not in pairs:
        p = copy.deepcopy(fx.DEX_PAIR)
        p["baseToken"] = {"address": addr, "name": f"Fake {addr[:4]}", "symbol": addr[:5].upper()}
        p["pairAddress"] = "P" + addr[1:]
        pairs[addr] = p
    p = pairs[addr]
    px = float(p["priceUsd"]) * random.uniform(0.95, 1.07)
    p["priceUsd"] = f"{px:.10f}"
    p["volume"]["m5"] = random.uniform(1000, 60000)
    p["volume"]["h1"] = p["volume"]["m5"] * random.uniform(4, 10)
    p["liquidity"]["usd"] = random.uniform(8000, 150000)
    p["marketCap"] = p["fdv"] = px * 1e9
    p["txns"]["m5"] = {"buys": random.randint(5, 200), "sells": random.randint(5, 150)}
    p["priceChange"]["m5"] = random.uniform(-20, 40)
    return p


@api.get("/dex/tokens/v1/{chain}/{addrs}")
def dex_tokens(chain: str, addrs: str):
    return [pair_for(a) for a in addrs.split(",")]


@api.get("/dex/token-profiles/latest/v1")
def profiles():
    return [{"url": "https://dexscreener.com/solana/x", "chainId": "solana", "tokenAddress": created[-1], "icon": None, "links": []}]


@api.get("/dex/token-boosts/{kind}/v1")
def boosts(kind: str):
    return [{"chainId": "solana", "tokenAddress": fx.MINT, "amount": 10, "totalAmount": 30}]


@api.get("/gecko/networks/{net}/trending_pools")
@api.get("/gecko/networks/{net}/new_pools")
def gecko_pools(net: str):
    return fx.GECKO_TRENDING


@api.get("/gecko/networks/{net}/pools/{pool}/ohlcv/{unit}")
def gecko_ohlcv(net: str, pool: str, unit: str):
    import time
    now = int(time.time()) // 300 * 300
    px, out = 1.0, []
    for i in range(120):
        o = px
        px *= random.uniform(0.94, 1.08)
        out.append([now - (119 - i) * 300, o, max(o, px) * 1.02, min(o, px) * 0.98, px, random.uniform(1e3, 5e4)])
    return {"data": {"attributes": {"ohlcv_list": out[::-1]}}}


@api.get("/rug/tokens/{mint}/report")
def rug(mint: str):
    rep = copy.deepcopy(fx.RUG_REPORT_MINTABLE if mint == fx.MINT_BAD else fx.RUG_REPORT)
    rep["mint"] = mint
    return rep


TG_LOG: list[dict] = []


@api.post("/tg/bot{token}/sendMessage")
async def tg_send(token: str, body: dict):
    import time
    TG_LOG.append({"ts": time.time(), "text": body.get("text", "")})
    return {"ok": True, "result": {"message_id": len(TG_LOG)}}


@api.get("/tg/log")
def tg_log():
    return TG_LOG


async def pump_ws(ws):
    subs: set[str] = set()

    async def reader():
        async for raw in ws:
            m = json.loads(raw)
            if m.get("method") == "subscribeTokenTrade":
                subs.update(m.get("keys") or [])
            await ws.send(json.dumps({"message": f"Successfully subscribed to {m.get('method')}"}))

    async def writer():
        n = 0
        while True:
            await asyncio.sleep(float(sys.argv[3]) if len(sys.argv) > 3 else 1.0)
            n += 1
            mint = fx.MINT if n == 1 else mint_id()
            if mint not in created:
                created.append(mint)
            ev = {**fx.PUMP_CREATE, "mint": mint, "signature": f"sig{n}",
                  "name": fx.PUMP_CREATE["name"] if n == 1 else f"Fake {mint[:4]}", "symbol": fx.PUMP_CREATE["symbol"] if n == 1 else mint[:5].upper()}
            await ws.send(json.dumps(ev))
            for s in [fx.MINT, *random.sample(sorted(subs), min(4, len(subs)))] if fx.MINT in subs else random.sample(sorted(subs), min(4, len(subs))):
                await ws.send(json.dumps({**fx.PUMP_TRADE, "mint": s, "signature": f"t{n}{s[:6]}",
                                          "txType": random.choice(["buy", "sell"]), "solAmount": random.uniform(0.05, 3)}))
            if n % 4 == 0:
                await ws.send(json.dumps({**fx.PUMP_MIGRATE, "mint": random.choice(created), "signature": f"m{n}"}))

    await asyncio.gather(reader(), writer())


async def main(http_port: int, ws_port: int) -> None:
    async with websockets.serve(pump_ws, "127.0.0.1", ws_port):
        server = uvicorn.Server(uvicorn.Config(api, host="127.0.0.1", port=http_port, log_level="warning"))
        await server.serve()


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]), int(sys.argv[2])))
