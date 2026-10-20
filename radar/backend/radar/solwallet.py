"""Radar's trading wallet and trade execution — the way Telegram sniping bots work, with tighter limits.

Radar NEVER asks for your main wallet's seed phrase. Instead it creates a separate trading wallet, keeps its private key
encrypted at rest (AES-256-GCM with RADAR_SECRET), and only ever holds what you deposit into it. You can withdraw to your
own wallet, or export the key into Phantom, at any time (both need your Radar password).

Execution
  pump.fun / PumpSwap / Raydium coins  PumpPortal's Local Transaction API builds the swap; Radar signs it here and sends
                                       it through your RPC (Helius when connected). PumpPortal charges a small fee per
                                       trade (0.5% per third-party docs; check pumpportal.fun).
  anything else                        Jupiter's swap API (quote → transaction) as a fallback.
Confirmation is read back from the chain (signature status, then the wallet's real token and SOL balances), so the
position book records what actually happened, not what was hoped for.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import time
from typing import Any

import httpx

from . import secrets
from .health import Health, register

log = logging.getLogger("radar.wallet")
exec_h = register(Health("trade_exec", "rest", "Autopilot trade execution (PumpPortal local tx / Jupiter + your RPC)"))
exec_h.stale_after = 86400
WSOL = "So11111111111111111111111111111111111111112"
LAMPORTS = 1_000_000_000


class TradeError(RuntimeError):
    pass


class Chain:
    """Minimal Solana JSON-RPC client (Helius when connected, else SOLANA_RPC_URL / public mainnet)."""

    def __init__(self, helius: Any = None) -> None:
        self.helius = helius
        self.client = httpx.AsyncClient(timeout=20)

    @property
    def url(self) -> str:
        if os.environ.get("SOLANA_RPC_URL"):
            return os.environ["SOLANA_RPC_URL"]
        if self.helius is not None and self.helius.enabled:
            return self.helius.rpc_url
        return "https://api.mainnet-beta.solana.com"

    async def rpc(self, method: str, params: list[Any]) -> Any:
        r = await self.client.post(self.url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        r.raise_for_status()
        j = r.json()
        if j.get("error"):
            raise TradeError(f"{method}: {j['error'].get('message') if isinstance(j['error'], dict) else j['error']}")
        return j.get("result")

    async def sol_balance(self, pubkey: str) -> float:
        res = await self.rpc("getBalance", [pubkey, {"commitment": "confirmed"}])
        return (res or {}).get("value", 0) / LAMPORTS

    async def token_balance(self, owner: str, mint: str) -> float:
        res = await self.rpc("getTokenAccountsByOwner", [owner, {"mint": mint}, {"encoding": "jsonParsed", "commitment": "confirmed"}])
        total = 0.0
        for a in (res or {}).get("value") or []:
            amt = (((a.get("account") or {}).get("data") or {}).get("parsed") or {}).get("info", {}).get("tokenAmount") or {}
            total += float(amt.get("uiAmount") or 0)
        return total

    async def blockhash(self) -> str:
        res = await self.rpc("getLatestBlockhash", [{"commitment": "confirmed"}])
        return res["value"]["blockhash"]

    async def send(self, raw: bytes) -> str:
        return await self.rpc("sendTransaction", [base64.b64encode(raw).decode(), {"encoding": "base64", "skipPreflight": True,
                                                                                   "maxRetries": 3}])

    async def confirm(self, sig: str, timeout: float = 45) -> bool:
        t0 = time.time()
        while time.time() - t0 < timeout:
            res = await self.rpc("getSignatureStatuses", [[sig], {"searchTransactionHistory": False}])
            st = ((res or {}).get("value") or [None])[0]
            if st:
                if st.get("err") is not None:
                    raise TradeError(f"transaction failed on chain: {st['err']}")
                if st.get("confirmationStatus") in ("confirmed", "finalized"):
                    return True
            await asyncio.sleep(1.0)
        return False


class TradingWallet:
    def __init__(self, cfg: Any, chain: Chain) -> None:
        self.cfg, self.chain = cfg, chain
        self.client = httpx.AsyncClient(timeout=20)

    async def info(self) -> dict[str, Any] | None:
        return await self.cfg.kv_get("autopilot:wallet")

    async def pubkey(self) -> str | None:
        return ((await self.info()) or {}).get("pubkey")

    async def create(self) -> dict[str, Any]:
        """New keypair; refuses to replace a wallet that still exists (move funds out, then forget it explicitly)."""
        from solders.keypair import Keypair
        if await self.info():
            raise TradeError("A trading wallet already exists — withdraw and remove it before creating another")
        kp = Keypair()
        w = {"pubkey": str(kp.pubkey()), "secret_enc": secrets.encrypt({"sk": str(kp)}), "created": time.time()}
        await self.cfg.kv_set("autopilot:wallet", w)
        return {"pubkey": w["pubkey"], "created": w["created"]}

    async def forget(self) -> None:
        await self.cfg.kv_set("autopilot:wallet", None)

    async def _kp(self) -> Any:
        from solders.keypair import Keypair
        w = await self.info()
        if not w:
            raise TradeError("No trading wallet yet — create one on the Autopilot page")
        return Keypair.from_base58_string(secrets.decrypt(w["secret_enc"])["sk"])

    async def export_key(self) -> str:
        return str(await self._kp())

    async def sign(self, raw_unsigned: bytes) -> bytes:
        from solders.transaction import VersionedTransaction
        kp = await self._kp()
        tx = VersionedTransaction.from_bytes(raw_unsigned)
        return bytes(VersionedTransaction(tx.message, [kp]))

    async def withdraw(self, to: str, sol: float | None) -> str:
        """Send SOL to your own wallet. sol=None sends everything minus the network fee."""
        from solders.hash import Hash
        from solders.message import MessageV0
        from solders.pubkey import Pubkey
        from solders.system_program import TransferParams, transfer
        from solders.transaction import VersionedTransaction
        kp = await self._kp()
        try:
            dest = Pubkey.from_string(to.strip())
        except ValueError as e:
            raise TradeError("That isn't a Solana address") from e
        bal = await self.chain.sol_balance(str(kp.pubkey()))
        lamports = int((bal - 0.00001) * LAMPORTS) if sol is None else int(sol * LAMPORTS)
        if lamports <= 0 or lamports > bal * LAMPORTS:
            raise TradeError(f"Not enough SOL (balance {bal:.4f})")
        ix = transfer(TransferParams(from_pubkey=kp.pubkey(), to_pubkey=dest, lamports=lamports))
        msg = MessageV0.try_compile(kp.pubkey(), [ix], [], Hash.from_string(await self.chain.blockhash()))
        sig = await self.chain.send(bytes(VersionedTransaction(msg, [kp])))
        await self.chain.confirm(sig)
        return sig

    # ---------------- swaps ----------------
    async def _pumpportal(self, action: str, mint: str, amount: float | str, in_sol: bool, slippage_pct: float, prio_sol: float) -> bytes:
        url = os.environ.get("PUMPPORTAL_TRADE_URL", "https://pumpportal.fun/api/trade-local")
        r = await self.client.post(url, data={"publicKey": await self.pubkey(), "action": action, "mint": mint, "amount": amount,
                                              "denominatedInSol": "true" if in_sol else "false", "slippage": slippage_pct,
                                              "priorityFee": prio_sol, "pool": "auto"})
        if r.status_code != 200:
            raise TradeError(f"PumpPortal {r.status_code}: {r.text[:160]}")
        return r.content

    async def _jupiter(self, input_mint: str, output_mint: str, amount_raw: int, slippage_pct: float, prio_sol: float) -> bytes:
        base = os.environ.get("JUPITER_URL", "https://lite-api.jup.ag")
        q = await self.client.get(f"{base}/swap/v1/quote", params={"inputMint": input_mint, "outputMint": output_mint, "amount": amount_raw,
                                                                    "slippageBps": int(slippage_pct * 100)})
        if q.status_code != 200:
            raise TradeError(f"Jupiter quote {q.status_code}: {q.text[:160]}")
        s = await self.client.post(f"{base}/swap/v1/swap", json={"quoteResponse": q.json(), "userPublicKey": await self.pubkey(),
                                                                  "wrapAndUnwrapSol": True, "prioritizationFeeLamports": int(prio_sol * LAMPORTS)})
        if s.status_code != 200:
            raise TradeError(f"Jupiter swap {s.status_code}: {s.text[:160]}")
        return base64.b64decode(s.json()["swapTransaction"])

    async def buy(self, mint: str, sol: float, slippage_pct: float, prio_sol: float) -> dict[str, Any]:
        pub = await self.pubkey()
        if not pub:
            raise TradeError("No trading wallet")
        before_sol, before_tok = await self.chain.sol_balance(pub), await self.chain.token_balance(pub, mint)
        if before_sol < sol + prio_sol + 0.003:
            raise TradeError(f"Trading wallet has {before_sol:.4f} SOL — not enough for a {sol} SOL buy plus fees")
        try:
            raw = await self._pumpportal("buy", mint, sol, True, slippage_pct, prio_sol)
            route = "pumpportal"
        except (TradeError, httpx.HTTPError) as e:
            log.info("pumpportal buy failed (%s), trying Jupiter", e)
            raw = await self._jupiter(WSOL, mint, int(sol * LAMPORTS), slippage_pct, prio_sol)
            route = "jupiter"
        sig = await self.chain.send(await self.sign(raw))
        ok = await self.chain.confirm(sig)
        if not ok:
            raise TradeError(f"not confirmed in time (signature {sig})")
        await asyncio.sleep(1.0)
        after_sol, after_tok = await self.chain.sol_balance(pub), await self.chain.token_balance(pub, mint)
        exec_h.ok()
        return {"sig": sig, "route": route, "tokens": max(0.0, after_tok - before_tok), "sol": max(0.0, before_sol - after_sol)}

    async def sell(self, mint: str, tokens: float, all_: bool, slippage_pct: float, prio_sol: float, decimals: int = 6) -> dict[str, Any]:
        pub = await self.pubkey()
        before_sol, before_tok = await self.chain.sol_balance(pub), await self.chain.token_balance(pub, mint)
        amount: float | str = "100%" if all_ else round(min(tokens, before_tok), decimals)
        if before_tok <= 0:
            raise TradeError("the wallet holds none of this token")
        try:
            raw = await self._pumpportal("sell", mint, amount, False, slippage_pct, prio_sol)
            route = "pumpportal"
        except (TradeError, httpx.HTTPError) as e:
            log.info("pumpportal sell failed (%s), trying Jupiter", e)
            qty = before_tok if all_ else min(tokens, before_tok)
            raw = await self._jupiter(mint, WSOL, int(qty * 10 ** decimals), slippage_pct, prio_sol)
            route = "jupiter"
        sig = await self.chain.send(await self.sign(raw))
        if not await self.chain.confirm(sig):
            raise TradeError(f"not confirmed in time (signature {sig})")
        await asyncio.sleep(1.0)
        after_sol, after_tok = await self.chain.sol_balance(pub), await self.chain.token_balance(pub, mint)
        exec_h.ok()
        return {"sig": sig, "route": route, "tokens": max(0.0, before_tok - after_tok), "sol": max(0.0, after_sol - before_sol)}
