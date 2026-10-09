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
from fastapi.responses import JSONResponse
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


WALLETS = [f"Trader{i}{'x' * 30}"[:40] for i in range(8)]


@api.get("/gecko/networks/{net}/pools/{pool}/trades")
def gecko_trades(net: str, pool: str):
    """Deterministic round trips: wallets 0-5 win (sell 2-4x higher), 6-7 lose."""
    import time
    now = time.time()
    rows = []
    for i, w in enumerate(WALLETS):
        mult = [3.0, 2.5, 4.0, 2.0, 1.6, 3.2, 0.4, 0.5][i]
        buy_usd = 500 + i * 100
        tokens = 1_000_000.0
        for kind, usd, ago in (("buy", buy_usd, 3000), ("sell", buy_usd * mult, 600)):
            ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - ago))
            rows.append({"id": f"t{pool[:6]}{i}{kind}", "type": "trade", "attributes": {
                "tx_hash": f"{pool[:8]}-{i}-{kind}", "tx_from_address": w, "kind": kind, "volume_in_usd": str(usd),
                "from_token_amount": str(tokens) if kind == "sell" else "1.0", "to_token_amount": str(tokens) if kind == "buy" else "1.0",
                "block_timestamp": ts}})
    return {"data": rows}


@api.get("/meta/{mint}")
def coin_meta(mint: str):
    """pump.fun-style metadata JSON; every other coin has socials (one an X community)."""
    h = sum(map(ord, mint))
    md = {"name": f"Fake {mint[:4]}", "symbol": mint[:5].upper(), "description": "the dog that runs the internet" if h % 3 == 0 else "gm",
          "image": "https://example.invalid/img.png"}
    if h % 2 == 0:
        md.update(twitter="https://x.com/i/communities/1888" if h % 4 == 0 else "https://x.com/fakecoin", telegram="https://t.me/fake",
                  website="https://fake.example")
    return md


@api.get("/rug/tokens/{mint}/report")
def rug(mint: str):
    rep = copy.deepcopy(fx.RUG_REPORT_MINTABLE if mint == fx.MINT_BAD else fx.RUG_REPORT)
    rep["mint"] = mint
    return rep


TG_LOG: list[dict] = []
SWAP_N = [0]


def _funder(w: str) -> str | None:
    """Rocket buyers Fan{n}x{i} with i < 6 are brand-new wallets all funded by Insider{n} (an insider cluster)."""
    import re
    m = re.match(r"Fan(\d+)x(\d+)", w)
    return f"Insider{m.group(1)}{'q' * 34}"[:40] if m and int(m.group(2)) < 6 else None


@api.post("/helius")
async def helius_rpc(body: dict):
    """Solana JSON-RPC as Helius serves it: signatures, parsed transactions, largest token accounts."""
    import time
    method, params = body.get("method"), body.get("params") or []
    now = int(time.time())
    if method == "getSignaturesForAddress":
        w, opts = params[0], (params[1] if len(params) > 1 else {})
        if w.startswith("Trader") and opts.get("until"):          # a followed wallet: one new swap per check
            SWAP_N[0] += 1
            return {"result": [{"signature": f"sw{SWAP_N[0]}-{w}", "blockTime": now, "err": None}]}
        if _funder(w):
            return {"result": [{"signature": f"buy-{w}", "blockTime": now - 30, "err": None},
                               {"signature": f"first-{w}", "blockTime": now - 900, "err": None}]}
        return {"result": [{"signature": f"old{i}-{w[:8]}", "blockTime": now - 86400 * (i + 1), "err": None}
                           for i in range(min(40, int(opts.get("limit", 40))))]}
    if method == "getTransaction":
        sig = params[0]
        if sig.startswith("first-"):
            w = sig[6:]
            f = _funder(w)
            return {"result": {"blockTime": now - 900, "meta": {"err": None, "fee": 5000, "innerInstructions": [],
                                                                "preBalances": [5e9, 0], "postBalances": [4e9, 1e9]},
                               "transaction": {"message": {"accountKeys": [{"pubkey": f}, {"pubkey": w}], "instructions": [
                                   {"program": "system", "parsed": {"type": "transfer", "info": {"source": f, "destination": w,
                                                                                                "lamports": 1_000_000_000}}}]}}}}
        if sig.startswith("sw"):
            w = sig.split("-", 1)[1]
            mint = "SWAPmint" + "s" * 32 + "pump"
            return {"result": {"blockTime": now, "meta": {"err": None, "fee": 5000, "preBalances": [3_000_005_000], "postBalances": [1_000_000_000],
                                                          "preTokenBalances": [], "postTokenBalances": [
                                                              {"owner": w, "mint": mint, "uiTokenAmount": {"uiAmount": 1234567.0}}]},
                               "transaction": {"message": {"accountKeys": [{"pubkey": w}], "instructions": []}}}}
        return {"result": None}
    if method == "getTokenLargestAccounts":
        return {"result": {"value": [{"address": "CurveATA", "uiAmount": 7.5e8}] +
                           [{"address": f"H{i}", "uiAmount": 2.0e7 - i * 1e6} for i in range(12)]}}
    if method == "getHealth":
        return {"result": "ok"}
    return {"result": None}


@api.get("/yt/search")
def yt_search(q: str = "", order: str = ""):
    if order == "date":     # buzz search: fresh memecoin videos, one about the live HAWKTUAH launch
        return {"items": [{"id": {"videoId": "buzz1"}}, {"id": {"videoId": "buzz2"}}]}
    return {"items": [{"id": {"videoId": f"strat{abs(hash(q)) % 5}"}}]}


@api.get("/yt/videos")
def yt_videos(id: str = "", chart: str = ""):
    out = []
    for vid in (id.split(",") if id else []):
        if vid == "buzz1":
            sn = {"title": "$HAWKTUAH is the next 100x memecoin?!", "description": f"CA: {fx.MINT}", "channelTitle": "Degen TV",
                  "channelId": "UCdegen", "publishedAt": "2026-10-09T00:00:00Z"}
        elif vid == "buzz2":
            sn = {"title": "Solana memecoins today: $WIF $BONK and $ZORP", "description": "", "channelTitle": "Coin Daily",
                  "channelId": "UCdaily", "publishedAt": "2026-10-09T00:00:00Z"}
        else:
            sn = {"title": f"My memecoin sniping filters ({vid})", "description": "I only buy when top 10 holders are under 25% and there are at least 60 holders.",
                  "channelTitle": "Trench Coach", "channelId": "UCcoach", "publishedAt": "2026-10-01T00:00:00Z"}
        out.append({"id": vid, "snippet": sn, "statistics": {"viewCount": "42000", "likeCount": "900", "commentCount": "120"}})
    return {"items": out}


@api.get("/yt/commentThreads")
def yt_comments(videoId: str = ""):
    return {"items": [{"snippet": {"topLevelComment": {"snippet": {"textDisplay": "Pinned: my settings — snipers under 15%, dev holding under 4%"}}}}]}


@api.get("/yt/playlistItems")
def yt_uploads(playlistId: str = ""):
    return {"items": [{"contentDetails": {"videoId": "upload1"}}]}


X_STATE = {"users_by": 0, "following": 0}


def _xuser(h: str) -> dict:
    name = h
    if h.lower() == "elonmusk" and X_STATE["users_by"] >= 2:
        name = "Zorblax Maximus"            # the Kekius move: a profile rename
    return {"id": f"u{h.lower()}", "username": h, "name": name, "description": f"bio of {h}",
            "profile_image_url": f"https://pbs.example/{h}.jpg", "public_metrics": {"followers_count": 1_000_000}}


@api.get("/x/2/users/by")
def x_users_by(usernames: str = ""):
    X_STATE["users_by"] += 1
    return {"data": [_xuser(h) for h in usernames.split(",") if h]}


@api.get("/x/2/users/{uid}/following")
def x_following(uid: str):
    X_STATE["following"] += 1
    base = [{"id": "f1", "username": "nasa", "name": "NASA", "description": "space", "public_metrics": {"followers_count": 9e7}}]
    if X_STATE["following"] >= 2:
        base.insert(0, {"id": "f2", "username": "ZorpCoinSol", "name": "Zorp", "description": "$ZORP the alien coin. CA soon on pump",
                        "public_metrics": {"followers_count": 812}})
    return {"data": base}


@api.get("/x/2/tweets/search/recent")
def x_search(query: str = "", since_id: str = ""):
    import datetime
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    posts, users = [], []
    if "from:elonmusk" in query and not since_id:
        posts.append({"id": "9001", "author_id": "uelonmusk", "created_at": now, "text": "My new dog is named Zorblax 🐕",
                      "public_metrics": {"like_count": 90000, "retweet_count": 12000, "reply_count": 8000, "quote_count": 3000},
                      "attachments": {"media_keys": ["m1"]}})
        users.append(_xuser("elonmusk"))
    if "from:blknoiz06" in query and not since_id:
        posts.append({"id": "9002", "author_id": "ublknoiz06", "created_at": now, "text": "$ZORBLAX is the only play today",
                      "public_metrics": {"like_count": 900, "retweet_count": 100, "reply_count": 50, "quote_count": 10}})
        users.append(_xuser("blknoiz06"))
    if not posts:
        return {"meta": {"result_count": 0}}
    return {"data": posts, "includes": {"users": users, "media": [{"media_key": "m1", "type": "photo", "url": "https://pbs.example/dog.jpg"}]},
            "meta": {"newest_id": max(p["id"] for p in posts), "result_count": len(posts)}}


@api.get("/x/2/tweets")
def x_tweets(ids: str = ""):
    return {"data": [{"id": i, "public_metrics": {"like_count": 150000, "retweet_count": 20000, "reply_count": 9000, "quote_count": 4000}}
                     for i in ids.split(",") if i]}


@api.get("/dune/api/v1/query/{qid}/results")
def dune_results(qid: int):
    if qid == 404:
        return JSONResponse({"error": "Query not found"}, status_code=404)
    return {"execution_ended_at": "2026-10-09T00:00:00Z", "result": {"rows": [
        {"trader": f"Dune{i + 1}{'w' * 36}"[:40], "name": f"whale {i}", "pnl_usd": 250000.0 - i * 1000, "win_rate": 0.6} for i in range(5)]}}


@api.post("/tg/bot{token}/sendMessage")
async def tg_send(token: str, body: dict):
    import time
    TG_LOG.append({"ts": time.time(), "text": body.get("text", ""), "chat_id": body.get("chat_id"),
                   "buttons": bool(body.get("reply_markup"))})
    return {"ok": True, "result": {"message_id": len(TG_LOG)}}


TG_UPDATES: list[dict] = []


@api.get("/tg/bot{token}/getUpdates")
def tg_updates(token: str, offset: int = 0):
    if token.startswith("bad"):
        return JSONResponse({"ok": False, "description": "Unauthorized"}, status_code=401)
    base = [{"update_id": 1, "message": {"chat": {"id": 555123, "type": "private"}, "text": "/start"}}]
    return {"ok": True, "result": [u for u in base + TG_UPDATES if u["update_id"] >= offset]}


@api.post("/tg/push_update")
def tg_push_update(body: dict):
    """Test hook: the user typed a command in the bot chat."""
    TG_UPDATES.append({"update_id": 100 + len(TG_UPDATES), "message": {"chat": {"id": int(body.get("chat", 555123))}, "text": body["text"]}})
    return {"ok": True}


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

    async def rocket(mint: str, n: int, bundled: bool) -> None:
        """A launch that behaves like a real runner (distinct buyers, rising curve, a top wallet in early) or a bundle."""
        vsol = 31.0
        if bundled:
            for i in range(7):
                vsol += 3
                await ws.send(json.dumps({**fx.PUMP_TRADE, "mint": mint, "signature": f"b{n}{i}", "txType": "buy",
                                          "traderPublicKey": f"Bundle{i}{'y' * 33}"[:40], "solAmount": 2.0, "tokenAmount": 5e7,
                                          "vSolInBondingCurve": vsol, "marketCapSol": vsol * 0.97}))
            return
        for i in range(30):
            await asyncio.sleep(0.9)
            sol = round(random.uniform(0.3, 1.8), 3)
            side = "buy" if i % 6 else "sell"
            vsol += sol if side == "buy" else -sol      # the curve moves by exactly the SOL traded, like the real one
            who = WALLETS[0] if i == 3 else f"Fan{n}x{i}{'z' * 32}"[:40]
            await ws.send(json.dumps({**fx.PUMP_TRADE, "mint": mint, "signature": f"r{n}{i}", "txType": side,
                                      "traderPublicKey": who, "solAmount": sol,
                                      "tokenAmount": random.uniform(1e6, 2e7), "vSolInBondingCurve": vsol, "marketCapSol": vsol * 0.97}))

    async def writer():
        n = 0
        while True:
            await asyncio.sleep(float(sys.argv[3]) if len(sys.argv) > 3 else 1.0)
            n += 1
            mint = fx.MINT if n == 1 else mint_id()
            if mint not in created:
                created.append(mint)
            ev = {**fx.PUMP_CREATE, "mint": mint, "signature": f"sig{n}",
                  "name": fx.PUMP_CREATE["name"] if n == 1 else f"Fake {mint[:4]}", "symbol": fx.PUMP_CREATE["symbol"] if n == 1 else mint[:5].upper(),
                  **({} if n == 1 else {"traderPublicKey": f"Dev{n % 7}{'d' * 36}"[:40]}),
                  "uri": f"http://127.0.0.1:{sys.argv[1]}/meta/{mint}"}
            if n > 1 and n % 6 == 3:   # deployers racing to tokenize the tweet the fake X serves ("Zorblax")
                ev["name"], ev["symbol"] = "Zorblax", "ZORBLAX"
            if n > 1 and n % 9 == 0:   # a Mayhem Mode launch: 2B supply, so market cap is twice the 1B-supply value
                ev["marketCapSol"] = ev["vSolInBondingCurve"] / ev["vTokensInBondingCurve"] * 2e9
                ev["symbol"] = "MAYHM"
            await ws.send(json.dumps(ev))
            if n > 1 and n % 5 in (2, 4):
                asyncio.get_running_loop().create_task(rocket(mint, n, bundled=n % 5 == 4))
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
