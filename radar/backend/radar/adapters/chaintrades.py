"""pump.fun trades straight from the chain — the free fallback for PumpPortal's trade feed.

Since May 2026 PumpPortal streams trades only to connections with a PumpPortal API key (and a funded linked wallet);
its new-launch feed stays free. Without trades every coin looks buyer-less and the sniper / Autopilot have nothing to
act on. This reads the trades from Solana itself instead: one `logsSubscribe` on the pump.fun program (Helius when its
key is connected, else SOLANA_WS_URL / the public mainnet RPC), decoding the program's own `TradeEvent` from the
"Program data:" log line — mint, SOL and token amounts, side, trader, and the curve's virtual reserves (so price and
market cap are exact). Only coins Radar is watching are forwarded, in the same shape as a PumpPortal trade message.
"""
from __future__ import annotations

import base64
import logging
import os
import struct
import time
from collections import deque
from typing import Any, Awaitable, Callable

from ..health import Health, register
from .stream import Stream

log = logging.getLogger("radar.chaintrades")
health = register(Health("chaintrades", "stream", "pump.fun trades decoded from Solana logs (free fallback for PumpPortal trades)"))
health.stale_after = 120

PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
TRADE_DISC = bytes.fromhex("bddb7fd34ee661ee")          # sha256("event:TradeEvent")[:8] (Anchor event discriminator)
_T = struct.Struct("<QQ?32sqQQ")                       # sol_amount, token_amount, is_buy, user, timestamp, v_sol, v_token


def b58(raw: bytes) -> str:
    from solders.pubkey import Pubkey
    return str(Pubkey.from_bytes(raw))


def decode_trade(data: bytes) -> dict[str, Any] | None:
    """A pump.fun TradeEvent → a PumpPortal-shaped trade message (None if it isn't one)."""
    if len(data) < 8 + 32 + _T.size or data[:8] != TRADE_DISC:
        return None
    mint = b58(data[8:40])
    sol, tok, is_buy, user, ts, vsr, vtr = _T.unpack_from(data, 40)
    v_sol, v_tok = vsr / 1e9, vtr / 1e6
    return {"mint": mint, "txType": "buy" if is_buy else "sell", "solAmount": sol / 1e9, "tokenAmount": tok / 1e6,
            "traderPublicKey": b58(user), "vSolInBondingCurve": v_sol, "vTokensInBondingCurve": v_tok,
            "marketCapSol": (v_sol / v_tok) * 1e9 if v_tok else None, "pool": "pump", "chain_ts": ts}


def ws_url(helius_key: str | None) -> str:
    if os.environ.get("SOLANA_WS_URL"):
        return os.environ["SOLANA_WS_URL"]
    if helius_key:
        return f"wss://mainnet.helius-rpc.com/?api-key={helius_key}"
    return "wss://api.mainnet-beta.solana.com"


class ChainTrades(Stream):
    def __init__(self, on_trade: Callable[[dict[str, Any]], Awaitable[None]], wanted: Callable[[], set[str]], helius_key: str | None = None):
        super().__init__(ws_url(helius_key), health)
        self.on_trade, self.wanted = on_trade, wanted
        self.decoded = 0
        self.forwarded = 0
        self.recent: deque[float] = deque(maxlen=20000)

    def set_helius(self, key: str | None) -> None:
        url = ws_url(key)
        if url != self.url:
            self.url = url
            if self.ws is not None:                      # reconnect on the new endpoint
                __import__("asyncio").get_running_loop().create_task(self.ws.close())

    async def on_open(self) -> None:
        await self.send({"jsonrpc": "2.0", "id": 1, "method": "logsSubscribe",
                         "params": [{"mentions": [PUMP_PROGRAM]}, {"commitment": "processed"}]})

    async def on_message(self, msg: Any) -> None:
        if not isinstance(msg, dict) or msg.get("method") != "logsNotification":
            return
        v = ((msg.get("params") or {}).get("result") or {}).get("value") or {}
        if v.get("err"):
            return
        want = None
        k = 0
        for line in v.get("logs") or ():
            if not line.startswith("Program data: "):
                continue
            try:
                data = base64.b64decode(line[14:])
            except ValueError:
                continue
            if data[:8] != TRADE_DISC:
                continue
            t = decode_trade(data)
            if not t:
                continue
            self.decoded += 1
            want = want if want is not None else self.wanted()
            if t["mint"] not in want:
                continue
            t["signature"] = v.get("signature") if not k else f"{v.get('signature')}:{k}"   # same id PumpPortal uses → no double count
            k += 1
            self.forwarded += 1
            self.recent.append(time.time())
            await self.on_trade(t)

    def rate(self, window: float = 60) -> int:
        cut = time.time() - window
        return sum(1 for t in self.recent if t >= cut)

    def snapshot(self) -> dict[str, Any]:
        return {"connected": self.ws is not None, "endpoint": self.url.split("?")[0], "decoded": self.decoded,
                "forwarded": self.forwarded, "per_min": self.rate()}
