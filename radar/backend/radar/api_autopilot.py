"""Autopilot endpoints: settings, mode (demo / real with confirmation), trading wallet, positions, manual trades, panic."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import auth
from .app import S
from .autopilot import DEFAULT, REAL_PHRASE
from .solwallet import TradeError

router = APIRouter(prefix="/api/autopilot")
_BAL: dict[str, tuple[float, float | None, str | None]] = {}


async def _pw(request: Request, given: str | None) -> bool:
    """Sensitive actions re-check your password (your account's, or RADAR_PASSWORD). Unlocked local installs pass."""
    return await auth.reauth(getattr(request.state, "user", None), given, request.client.host if request.client else "?")


@router.get("")
async def overview() -> dict[str, Any]:
    ap = S.autopilot
    pub = await S.wallet.pubkey()
    bal = None
    bal_err = None
    if pub:   # one RPC read per 15 s, not one per page poll
        hit = _BAL.get(pub)
        if hit and time.time() - hit[0] < 15:
            bal, bal_err = hit[1], hit[2]
        else:
            try:
                bal = await S.chain.sol_balance(pub)
            except Exception as e:  # noqa: BLE001
                bal_err = str(e)[:120]
            _BAL[pub] = (time.time(), bal, bal_err)
    return {"config": ap.c, "defaults": DEFAULT, "real_phrase": REAL_PHRASE, "password_set": auth.protected(),
            "wallet": {"pubkey": pub, "sol": bal, "error": bal_err, "payout": (await S.cfg.kv_get("autopilot:payout"))},
            "demo_balance": await ap.demo_balance(), **(await ap.snapshot()),
            "summary": {"demo": await ap.summary("demo"), "auto": await ap.summary("auto"), "real": await ap.summary("real")}}


@router.get("/brain")
async def brain() -> dict[str, Any]:
    """Self-driving mode: what it's looking at, what it thinks, what it has learned, and its equity curve."""
    return {**(await S.autopilot.brain.snapshot()), "mode": S.autopilot.c["mode"],
            "open": [p for p in (await S.autopilot.snapshot())["open"] if p["mode"] == "auto"]}


class AggBody(BaseModel):
    level: str


@router.post("/brain/aggression")
async def brain_aggression(b: AggBody) -> dict[str, Any]:
    await S.autopilot.brain.set_aggression(b.level)
    if S.autopilot.c["mode"] in ("off", "demo"):             # picking a brain level means "go": self-driving on demo money
        await S.autopilot.set_mode("auto")                   # (real money is never switched on or off from here)
    return await S.autopilot.brain.snapshot()


class EngineBody(BaseModel):
    engine: str


@router.post("/real-engine")
async def real_engine(b: EngineBody) -> dict[str, Any]:
    """What drives real money: your rules, or the self-driving brain (still capped by your size & daily limits)."""
    if b.engine not in ("rules", "brain"):
        raise HTTPException(400, "engine must be rules or brain")
    S.autopilot.c["real_engine"] = b.engine
    await S.cfg.kv_set("autopilot:cfg", S.autopilot.c)
    return S.autopilot.c


@router.post("/brain/reset")
async def brain_reset() -> dict[str, Any]:
    for p in [p for p in S.autopilot.open.values() if p["mode"] == "auto"]:
        await S.autopilot.sell(p, 1.0, "reset")
    await S.autopilot.brain.reset()
    return await S.autopilot.brain.snapshot()


@router.post("/config")
async def config(patch: dict[str, Any]) -> dict[str, Any]:
    try:
        return await S.autopilot.save(patch)
    except (TypeError, ValueError, KeyError) as e:
        raise HTTPException(400, f"Invalid setting: {e}") from e


class ModeBody(BaseModel):
    mode: str
    confirm: str = ""
    password: str | None = None


@router.post("/mode")
async def mode(b: ModeBody, request: Request) -> dict[str, Any]:
    try:
        return await S.autopilot.set_mode(b.mode, b.confirm, (await _pw(request, b.password)) if b.mode == "real" else True)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/panic")
async def panic() -> dict[str, Any]:
    return {"sold": await S.autopilot.panic()}


class BuyBody(BaseModel):
    mint: str
    sol: float | None = None
    mode: str | None = None


@router.post("/buy")
async def manual_buy(b: BuyBody) -> dict[str, Any]:
    """Quick-buy from a card: uses the current mode (demo when Autopilot is off). Real needs real mode switched on."""
    mode = b.mode or (S.autopilot.c["mode"] if S.autopilot.c["mode"] not in ("off", "auto") else "demo")
    if mode == "auto":
        mode = "demo"                       # the self-driving brain's pot is its own: your quick-buys go to your demo book
    if mode == "real" and S.autopilot.c["mode"] != "real":
        raise HTTPException(400, "Switch Autopilot to REAL first (that's where the safety confirmation lives)")
    if b.mint in S.autopilot.busy:
        raise HTTPException(409, "An order for this coin is already in flight")
    try:
        p = await S.autopilot.buy(b.mint.strip(), "manual", "quick buy", S.sniper.one(b.mint.strip()), sol=b.sol, mode=mode)
    except TradeError as e:
        raise HTTPException(400, str(e)) from e
    return {"position": {k: p[k] for k in ("id", "mode", "mint", "symbol", "sol_in", "tokens")}}


class SellBody(BaseModel):
    fraction: float = 1.0


@router.post("/positions/{pid}/sell")
async def manual_sell(pid: int, b: SellBody) -> dict[str, Any]:
    p = S.autopilot.open.get(pid)
    if not p:
        raise HTTPException(404, "No open position with that id")
    await S.autopilot.sell(p, max(0.01, min(1.0, b.fraction)), "manual")
    return await S.autopilot.snapshot()


@router.get("/history")
async def history(mode: str = "", limit: int = 200) -> dict[str, Any]:
    q, args = "SELECT * FROM auto_positions WHERE status='closed'", []
    if mode:
        q += " AND mode=?"
        args.append(mode)
    pos = await S.db.all(q + " ORDER BY closed DESC LIMIT ?", [*args, min(limit, 1000)])
    oq, oargs = "SELECT * FROM auto_orders", []
    if mode:
        oq += " WHERE mode=?"
        oargs.append(mode)
    orders = await S.db.all(oq + " ORDER BY ts DESC LIMIT ?", [*oargs, min(limit, 1000)])
    return {"positions": pos, "orders": orders}


@router.post("/demo/reset")
async def demo_reset() -> dict[str, Any]:
    await S.autopilot.reset_demo()
    return {"balance": await S.autopilot.demo_balance()}


# ---------------- trading wallet ----------------
@router.post("/wallet")
async def wallet_create() -> dict[str, Any]:
    try:
        return await S.wallet.create()
    except TradeError as e:
        raise HTTPException(400, str(e)) from e


class PayoutBody(BaseModel):
    address: str


@router.post("/wallet/payout")
async def wallet_payout(b: PayoutBody) -> dict[str, Any]:
    """Your own wallet (watch-only): where withdrawals go. Radar never needs its private key."""
    import re
    a = b.address.strip()
    if not re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}", a):
        raise HTTPException(400, "That isn't a Solana address")
    await S.cfg.kv_set("autopilot:payout", a)
    return {"payout": a}


class WithdrawBody(BaseModel):
    sol: float | None = None
    to: str | None = None
    password: str | None = None


@router.post("/wallet/withdraw")
async def wallet_withdraw(b: WithdrawBody, request: Request) -> dict[str, Any]:
    if not await _pw(request, b.password):
        raise HTTPException(403, "Wrong password")
    to = b.to or await S.cfg.kv_get("autopilot:payout")
    if not to:
        raise HTTPException(400, "Set your payout wallet first")
    try:
        sig = await S.wallet.withdraw(to, b.sol)
    except TradeError as e:
        raise HTTPException(400, str(e)) from e
    await S.db.exec("INSERT INTO auto_orders (ts, mode, side, sol, sig, status, reason) VALUES (?,?,?,?,?,?,?)",
                    (time.time(), "real", "withdraw", b.sol, sig, "filled", f"to {to}"))
    return {"signature": sig, "to": to}


class PwBody(BaseModel):
    password: str | None = None


@router.post("/wallet/export")
async def wallet_export(b: PwBody, request: Request) -> dict[str, Any]:
    if not auth.protected():
        raise HTTPException(400, "Create an account (or set RADAR_PASSWORD) before exporting a key")
    if not await _pw(request, b.password):
        raise HTTPException(403, "Wrong password")
    try:
        return {"private_key": await S.wallet.export_key(), "note": "Import into Phantom: Add wallet → Import private key. Never share it."}
    except TradeError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/wallet/forget")
async def wallet_forget(b: PwBody, request: Request) -> dict[str, Any]:
    if not await _pw(request, b.password):
        raise HTTPException(403, "Wrong password")
    pub = await S.wallet.pubkey()
    if pub:
        try:
            if await S.chain.sol_balance(pub) > 0.001:
                raise HTTPException(400, "Withdraw the SOL first (or export the key) — forgetting a funded wallet would lose it")
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"Couldn't check the balance ({e}); export the key before forgetting the wallet") from e
    if S.autopilot.c["mode"] == "real":
        await S.autopilot.set_mode("off")
    await S.wallet.forget()
    return {"ok": True}


# ---------------- replay lab: backtest the brain on the tape Radar recorded ----------------
_BT: dict[str, Any] = {"proc": None, "params": None, "started": None}


def _bt_paths() -> tuple[Any, Any]:
    from .config import settings
    base = settings.db_path.parent
    return base / "backtest.json", base / "backtest.json.progress"


class BacktestBody(BaseModel):
    hours: float = 6.0
    level: str | None = None


@router.post("/backtest")
async def backtest_start(b: BacktestBody) -> dict[str, Any]:
    """Replay the last N hours of recorded launches + trades through a fresh brain, in a separate low-priority process."""
    import asyncio
    import sys

    from .config import settings
    p = _BT.get("proc")
    if p is not None and p.returncode is None:
        raise HTTPException(409, "a backtest is already running")
    hours = max(0.25, min(48.0, float(b.hours)))
    level = b.level or S.autopilot.brain.aggression
    out, prog = _bt_paths()
    for f in (out, prog):
        try:
            f.unlink()
        except FileNotFoundError:
            pass
    cmd = [sys.executable, "-m", "radar.replay", "--db", str(settings.db_path), "--hours", str(hours), "--level", level, "--out", str(out)]
    try:                                                    # low priority: the live engine always wins the CPU
        _BT["proc"] = await asyncio.create_subprocess_exec("nice", "-n", "15", *cmd)
    except FileNotFoundError:
        _BT["proc"] = await asyncio.create_subprocess_exec(*cmd)
    _BT.update(params={"hours": hours, "level": level}, started=time.time())
    return {"started": True, **_BT["params"]}


@router.get("/backtest")
async def backtest_status() -> dict[str, Any]:
    import json as _json
    out, prog = _bt_paths()
    p = _BT.get("proc")
    running = p is not None and p.returncode is None
    res = None
    if out.exists():
        try:
            res = _json.loads(out.read_text())
        except ValueError:
            res = None
    progress = None
    if running and prog.exists():
        try:
            progress = _json.loads(prog.read_text()).get("progress")
        except ValueError:
            pass
    return {"running": running, "progress": progress, "params": _BT.get("params"), "started": _BT.get("started"),
            "elapsed_s": round(time.time() - _BT["started"]) if _BT.get("started") else None, "result": res}


class TunerBody(BaseModel):
    train_h: float = 8.0
    valid_h: float = 3.0


@router.get("/tuner")
async def tuner_status() -> dict[str, Any]:
    return S.tuner.snapshot()


@router.post("/tuner/run")
async def tuner_run(b: TunerBody) -> dict[str, Any]:
    """A walk-forward tournament of brain variants on the recorded tape; the winner is adopted only if it beats the
    current settings on both the training hours and the fresh hours after them."""
    if not S.tuner.start(max(1.0, min(24.0, b.train_h)), max(0.5, min(12.0, b.valid_h))):
        raise HTTPException(409, "a tournament is already running")
    return S.tuner.snapshot()


@router.post("/tuner/reset")
async def tuner_reset() -> dict[str, Any]:
    S.autopilot.brain.tune = {}
    await S.autopilot.brain.save()
    return S.tuner.snapshot()


class AdoptBody(BaseModel):
    name: str


@router.post("/tuner/adopt")
async def tuner_adopt(b: AdoptBody) -> dict[str, Any]:
    """Adopt one variant from the last tournament by hand (e.g. while real money is on, where it never auto-adopts)."""
    last = S.tuner.state.get("last") or {}
    row = next((r for r in last.get("rows") or [] if r.get("name") == b.name), None)
    if row is None:
        raise HTTPException(404, "no such variant in the last tournament")
    S.autopilot.brain.tune = dict(row.get("tune") or {})
    await S.autopilot.brain.save()
    await S.autopilot.brain.note("mode", f"🎛 Tuner settings '{b.name}' adopted by hand.")
    return S.tuner.snapshot()
