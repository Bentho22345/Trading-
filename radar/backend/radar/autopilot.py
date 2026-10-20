"""Autopilot: Radar trades its own signals — in DEMO (simulated fills, virtual SOL) or REAL (your trading wallet).

What sniping bots (Trojan, BonkBot, Photon, BullX, Axiom, GMGN…) offer, built on Radar's own engines:

  entries   snipe score at your appetite · any strategy you pick · tweet races (first coins off a tracked tweet) ·
            copy-trading (2+ top-ranked / followed wallets buying the same coin within minutes) · proven-dev launches ·
            contract calls from S/A-tier X accounts · manual quick-buy
  filters   max market cap, min buyers, max risk, max insider holding, skip bundled / TRAP coins, max age
  sizing    SOL per buy, max open positions, max SOL per day, daily loss limit (stops for the day), cooldown, hard cap
  exits     take-profit ladder (e.g. 2× sell half, 4× a quarter, 10× the rest) · stop loss · trailing stop once up ·
            time stop · rug exits (dev dumps, insider cluster, coin turns TRAP) · panic (sell everything, stop)

Off means "no new buys" — open positions keep being managed until they exit. REAL needs: a site password, a funded
trading wallet, and an explicit typed confirmation. Every order is logged with its reason. Not financial advice:
memecoins usually go to zero; only fund the trading wallet with what you can lose.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import time
from collections import defaultdict, deque
from typing import Any

from . import feed
from .hub import hub
from .solwallet import TradeError

log = logging.getLogger("radar.autopilot")
SUPPLY = 1e9

DEFAULT: dict[str, Any] = {
    "mode": "off",
    "triggers": {
        "snipe": {"on": True, "appetite": "degen", "min_score": 38},
        "strategies": {"on": False, "ids": []},
        "tweet_race": {"on": True, "max_rank": 2, "min_tweet_score": 50},
        "copy": {"on": True, "min_wallets": 2, "window_min": 10, "top_rank": 300},
        "dev": {"on": False, "min_graduated": 2},
        "x_call": {"on": True, "tiers": ["S", "A"]},
    },
    "filters": {"max_mcap_usd": 80000, "min_buyers": 8, "max_risk": 60, "max_insider_hold_pct": 15, "skip_bundled": True,
                "skip_trap": True, "max_age_min": 30},
    "size": {"buy_sol": 0.05, "max_open": 3, "max_daily_sol": 0.5, "daily_loss_limit_sol": 0.3, "cooldown_s": 20, "max_buy_sol_hard": 1.0},
    "exits": {"tp": [{"x": 2.0, "sell": 0.5}, {"x": 4.0, "sell": 0.25}, {"x": 10.0, "sell": 1.0}], "stop_loss_pct": 35,
              "trailing_pct": 30, "trail_after_x": 1.5, "time_stop_min": 45, "rug_exit": True},
    "exec": {"slippage_pct": 15, "priority_fee_sol": 0.0005},
    "demo": {"start_sol": 10.0},
    "real_engine": "rules",          # what drives REAL money: "rules" (the settings below) or "brain" (self-driving, under the same caps)
}
REAL_PHRASE = "I UNDERSTAND THIS USES REAL MONEY"


def merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge(out[k], v)
        elif k in out:
            out[k] = v
    return out


def validate(c: dict[str, Any]) -> dict[str, Any]:
    s, e, f = c["size"], c["exits"], c["filters"]
    s["max_buy_sol_hard"] = max(0.001, min(100.0, float(s["max_buy_sol_hard"])))
    s["buy_sol"] = max(0.001, min(float(s["buy_sol"]), s["max_buy_sol_hard"]))
    s["max_open"] = max(1, min(20, int(s["max_open"])))
    s["max_daily_sol"] = max(s["buy_sol"], float(s["max_daily_sol"]))
    s["daily_loss_limit_sol"] = max(0.0, float(s["daily_loss_limit_sol"]))
    s["cooldown_s"] = max(0, int(s["cooldown_s"]))
    e["stop_loss_pct"] = max(1.0, min(95.0, float(e["stop_loss_pct"])))
    e["trailing_pct"] = max(0.0, min(95.0, float(e["trailing_pct"])))
    e["tp"] = sorted(({"x": max(1.05, float(t["x"])), "sell": max(0.01, min(1.0, float(t["sell"])))} for t in e["tp"][:6]), key=lambda t: t["x"])
    c["exec"]["slippage_pct"] = max(0.5, min(50.0, float(c["exec"]["slippage_pct"])))
    c["exec"]["priority_fee_sol"] = max(0.0, min(0.05, float(c["exec"]["priority_fee_sol"])))
    f["max_mcap_usd"] = max(1000.0, float(f["max_mcap_usd"]))
    if c["mode"] not in ("off", "demo", "auto", "real"):
        c["mode"] = "off"
    if c.get("real_engine") not in ("rules", "brain"):
        c["real_engine"] = "rules"
    return c


class Autopilot:
    def __init__(self, db: Any, cfg: Any, sniper: Any, tracker: Any, traders: Any, smart: Any, alerts: Any, wallet: Any) -> None:
        self.db, self.cfg, self.sniper, self.tracker, self.traders, self.smart = db, cfg, sniper, tracker, traders, smart
        self.alerts, self.wallet = alerts, wallet
        self.c: dict[str, Any] = copy.deepcopy(DEFAULT)
        self.open: dict[int, dict[str, Any]] = {}
        self.busy: set[str] = set()
        self.entered: dict[str, float] = {}
        self.copy_buys: dict[str, deque] = defaultdict(lambda: deque(maxlen=50))
        self.signals: deque[dict[str, Any]] = deque(maxlen=200)       # external triggers (copy / X calls) waiting for the loop
        self.last_buy = 0.0
        self.kick = asyncio.Event()                                      # set on every scoring batch / copy signal: react at once
        self.paused_reason: str | None = None
        self.stats = {"ticks": 0, "buys": 0, "sells": 0, "errors": 0, "last_error": None}
        from .brain import Brain
        self.brain = Brain(self)                                         # self-driving mode: its own algorithm, demo money

    # ---------------- config / state ----------------
    async def load(self) -> None:
        self.c = validate(merge(DEFAULT, await self.cfg.kv_get("autopilot:cfg") or {}))
        await self.brain.load()
        await self.brain.refresh_stats()
        for p in await self.db.all("SELECT * FROM auto_positions WHERE status IN ('open','closing')"):
            p = dict(p)
            p["tp_done"] = json.loads(p.get("tp_done") or "[]")
            p["features"] = json.loads(p.get("features_json") or "null")
            p["leaders"] = json.loads(p.get("leaders_json") or "[]")
            self.open[p["id"]] = p
            self.entered[p["mint"]] = p["opened"]

    async def save(self, patch: dict[str, Any]) -> dict[str, Any]:
        patch = {k: v for k, v in (patch or {}).items() if k != "mode"}       # mode only via set_mode (it has checks)
        self.c = validate(merge(self.c, patch))
        await self.cfg.kv_set("autopilot:cfg", self.c)
        return self.c

    async def set_mode(self, mode: str, confirm: str = "", password_ok: bool = False) -> dict[str, Any]:
        from . import auth
        if mode == "real":
            if not auth.protected():
                raise ValueError("Real trading needs the site locked first: create an account (or set RADAR_PASSWORD) so nobody else can trade your wallet")
            if not password_ok:
                raise ValueError("Re-enter your Radar password to switch on real trading")
            if confirm.strip().upper() != REAL_PHRASE:
                raise ValueError(f'Type exactly: {REAL_PHRASE}')
            if not await self.wallet.pubkey():
                raise ValueError("Create and fund a trading wallet first")
        self.c["mode"] = mode if mode in ("off", "demo", "auto", "real") else "off"
        await self.cfg.kv_set("autopilot:cfg", self.c)
        await feed.push("autopilot", "mode", f"🤖 Autopilot {'SELF-DRIVING' if self.c['mode'] == 'auto' else self.c['mode'].upper()}", "")
        if self.c["mode"] == "auto":
            await self.brain.note("mode", f"🚗 Self-driving on. ◎{await self.demo_balance('auto'):.2f} of demo money, entry bar "
                                          f"{self.brain.threshold:.0f}, {self.brain.trained} trades learned so far.")
        await hub.publish("autopilot", await self.snapshot())
        return self.c

    async def demo_balance(self, mode: str = "demo") -> float:
        """Virtual SOL. 'demo' is yours (manual rules); 'auto' is the self-driving brain's own pot."""
        key = f"autopilot:{'auto' if mode == 'auto' else 'demo'}"
        d = await self.cfg.kv_get(key) or {}
        if "balance" not in d:
            d = {"balance": float(self.c["demo"]["start_sol"]), "started": time.time()}
            await self.cfg.kv_set(key, d)
        return float(d["balance"])

    async def _demo_add(self, delta: float, mode: str = "demo") -> None:
        key = f"autopilot:{'auto' if mode == 'auto' else 'demo'}"
        b = await self.demo_balance(mode)
        d = await self.cfg.kv_get(key) or {}
        d["balance"] = round(b + delta, 9)
        await self.cfg.kv_set(key, d)

    async def reset_demo(self, mode: str = "demo") -> None:
        mode = "auto" if mode == "auto" else "demo"
        await self.db.exec("DELETE FROM auto_positions WHERE mode=?", (mode,))
        self.open = {k: p for k, p in self.open.items() if p["mode"] != mode}
        await self.cfg.kv_set(f"autopilot:{mode}", {"balance": float(self.c["demo"]["start_sol"]), "started": time.time()})

    # ---------------- price ----------------
    async def price(self, mint: str) -> tuple[float | None, Any]:
        """(SOL per token, live launch or None). pump.fun supply is 1B, so price = market cap in SOL / 1e9."""
        L = self.sniper.launches.get(mint)
        if L is not None and L.mcap_sol:
            return L.mcap_sol / SUPPLY, L
        tok = await self.tracker.token_summary(mint)
        sol = self.tracker.sol_usd
        if tok and tok.get("price_usd") and sol:
            return float(tok["price_usd"]) / sol, None
        return None, None

    # ---------------- external triggers ----------------
    async def on_trade(self, t: dict[str, Any]) -> None:
        """Copy-trading input: top-ranked / followed / smart wallets buying (and selling — the brain mirrors exits)."""
        try:
            await self.brain.on_trade(t)
        except Exception as e:  # noqa: BLE001
            log.debug("brain on_trade: %s", e)
        cp = self.c["triggers"]["copy"]
        if not cp["on"] or self.c["mode"] in ("off", "auto") or t.get("side") != "buy" or not t.get("trader"):
            return
        w = t["trader"]
        r = self.traders.ranked.get(w) if self.traders else None
        ok = (r and r.get("rank") and r["rank"] <= cp["top_rank"]) or (self.traders and w in self.traders.followed) or \
             (self.smart and w in self.smart.tracked)
        if not ok:
            return
        q = self.copy_buys[t["mint"]]
        q.append((t.get("ts") or time.time(), w))
        cut = time.time() - cp["window_min"] * 60
        wallets = {x for ts, x in q if ts >= cut}
        if len(wallets) >= cp["min_wallets"]:
            self.signals.append({"mint": t["mint"], "trigger": "copy", "detail": f"{len(wallets)} top wallets bought within {cp['window_min']}m"})

    async def on_x_call(self, mint: str, handle: str, tier: str) -> None:
        xc = self.c["triggers"]["x_call"]
        if xc["on"] and self.c["mode"] not in ("off", "auto") and tier in xc["tiers"]:
            self.signals.append({"mint": mint, "trigger": "x_call", "detail": f"@{handle} ({tier}) tweeted it"})

    # ---------------- the loop ----------------
    async def run(self) -> None:
        await self.load()
        while True:
            fast = self.c["mode"] == "auto" or (self.c["mode"] == "real" and self.c.get("real_engine") == "brain")
            self.kick.clear()
            try:   # event-driven: wake the moment the sniper re-scores coins (or a top wallet buys), else poll
                await asyncio.wait_for(self.kick.wait(), timeout=0.5 if fast else 1.0)
            except asyncio.TimeoutError:
                pass
            self.stats["ticks"] += 1
            try:
                await self.manage()
                if self.c["mode"] == "auto":
                    await self.brain.tick("auto")
                elif self.c["mode"] == "real" and self.c.get("real_engine") == "brain":
                    await self.brain.tick("real")
                elif self.c["mode"] != "off":
                    await self.scan()
                if self.c["mode"] == "auto" or any(p["mode"] == "auto" for p in self.open.values()):
                    await self.brain.equity_tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                self.stats["errors"] += 1
                self.stats["last_error"] = f"{type(e).__name__}: {e}"[:200]
                log.warning("autopilot: %s", e)

    async def today(self, mode: str) -> dict[str, float]:
        start = time.time() - time.time() % 86400
        r = await self.db.one("SELECT COALESCE(SUM(sol_in),0) spent, COALESCE(SUM(CASE WHEN status='closed' THEN pnl_sol END),0) pnl "
                              "FROM auto_positions WHERE mode=? AND opened >= ?", (mode, start)) or {}
        return {"spent": float(r.get("spent") or 0), "pnl": float(r.get("pnl") or 0)}

    async def can_buy(self) -> str | None:
        mode, s = self.c["mode"], self.c["size"]
        if len([p for p in self.open.values() if p["mode"] == mode]) >= s["max_open"]:
            return "max open positions"
        t = await self.today(mode)
        if t["spent"] + s["buy_sol"] > s["max_daily_sol"]:
            return "daily SOL limit reached"
        if s["daily_loss_limit_sol"] and -t["pnl"] >= s["daily_loss_limit_sol"]:
            return "daily loss limit hit — stopped for today"
        if time.time() - self.last_buy < s["cooldown_s"]:
            return "cooldown"
        if mode == "demo" and await self.demo_balance() < s["buy_sol"]:
            return "demo balance empty"
        return None

    def passes(self, r: dict[str, Any]) -> str | None:
        f = self.c["filters"]
        mx = r.get("metrics") or {}
        if f["skip_trap"] and r.get("tier") == "TRAP":
            return "TRAP"
        if f["skip_bundled"] and r.get("bundled"):
            return "bundled"
        if r.get("mcap_usd") and r["mcap_usd"] > f["max_mcap_usd"]:
            return "market cap too high"
        if (r.get("buyers") or 0) < f["min_buyers"]:
            return "too few buyers"
        if (r.get("risk") or 0) > f["max_risk"]:
            return "risk too high"
        if (mx.get("insider_hold_pct") or 0) > f["max_insider_hold_pct"]:
            return "insiders hold too much"
        if r.get("age_s", 0) > f["max_age_min"] * 60:
            return "too old"
        return None

    def triggers_for(self, r: dict[str, Any]) -> tuple[str, str] | None:
        t = self.c["triggers"]
        if t["tweet_race"]["on"] and r.get("x") and (r["x"].get("rank") or 99) <= t["tweet_race"]["max_rank"] \
                and (r["x"].get("score") or 0) >= t["tweet_race"]["min_tweet_score"]:
            return "tweet_race", f"coin #{r['x']['rank']} off @{r['x']['handle']}'s tweet"
        if t["strategies"]["on"] and set(r.get("strategies") or []) & set(t["strategies"]["ids"]):
            return "strategy", ", ".join(sorted(set(r["strategies"]) & set(t["strategies"]["ids"])))
        if t["dev"]["on"] and r.get("age_s", 999) < 90:
            L = self.sniper.launches.get(r["mint"])
            if L and (L.dev or {}).get("graduated", 0) >= t["dev"]["min_graduated"]:
                return "dev", f"dev has {L.dev['graduated']} graduated coins"
        sn = t["snipe"]
        if sn["on"] and (r.get("scores") or {}).get(sn["appetite"], 0) >= sn["min_score"]:
            return "snipe", f"{sn['appetite']} score {(r.get('scores') or {}).get(sn['appetite'], 0):.0f}"
        return None

    async def scan(self) -> None:
        why_not = await self.can_buy()
        self.paused_reason = why_not
        cands: list[tuple[str, str, str]] = []
        while self.signals:
            s = self.signals.popleft()
            cands.append((s["mint"], s["trigger"], s["detail"]))
        if not why_not:
            for r in self.sniper.board(appetite=self.c["triggers"]["snipe"]["appetite"], limit=25,
                                       max_age_min=self.c["filters"]["max_age_min"])["rows"]:
                tr = self.triggers_for(r)
                if tr:
                    cands.append((r["mint"], tr[0], tr[1]))
        prio = {"x_call": 0, "tweet_race": 1, "copy": 2, "dev": 3, "strategy": 4, "snipe": 5}
        cands.sort(key=lambda c: prio.get(c[1], 9))           # time-critical signals first: they're worth the slot
        if len(self.entered) > 5000:
            cut = time.time() - 86400
            self.entered = {m: t for m, t in self.entered.items() if t > cut or any(p["mint"] == m for p in self.open.values())}
        for mint, trig, detail in cands:
            if mint in self.entered or mint in self.busy:
                continue
            if await self.can_buy():
                return
            r = self.sniper.one(mint)
            if r is not None and self.passes(r):
                continue
            try:
                await self.buy(mint, trig, detail, r)
            except Exception as e:  # noqa: BLE001 - logged as a failed order; move on
                log.info("autopilot buy %s: %s", mint, e)

    # ---------------- orders ----------------
    async def buy(self, mint: str, trigger: str, detail: str, r: dict[str, Any] | None = None, sol: float | None = None,
                  mode: str | None = None) -> dict[str, Any]:
        mode = mode or (self.c["mode"] if self.c["mode"] != "off" else "demo")
        size = min(sol or self.c["size"]["buy_sol"], self.c["size"]["max_buy_sol_hard"])
        px, L = await self.price(mint)
        if not px:
            raise TradeError("no live price for this coin yet")
        self.busy.add(mint)
        self.entered[mint] = time.time()
        self.last_buy = time.time()
        sym = (r or {}).get("symbol") or (L.symbol if L else None) or mint[:6]
        try:
            if mode == "real":
                ex = self.c["exec"]
                res = await self.wallet.buy(mint, size, ex["slippage_pct"], ex["priority_fee_sol"])
                tokens, sol_in, sig = res["tokens"], res["sol"], res["sig"]
                if tokens <= 0:
                    raise TradeError("bought nothing (slippage?)")
            else:
                if await self.demo_balance(mode) < size:
                    raise TradeError(f"{mode} balance too low")
                impact = size / max(30.0, (L.vsol if L and L.vsol else 60.0))
                fill = px * (1 + impact + 0.005)                         # price impact + PumpPortal fee
                sol_in = size + self.c["exec"]["priority_fee_sol"]
                tokens = size * 0.99 / fill                                # pump.fun 1% fee
                sig = None
                await self._demo_add(-sol_in, mode)
            entry_px = sol_in / tokens
            pid = await self.db.exec(
                "INSERT INTO auto_positions (mode, mint, symbol, trigger, detail, opened, entry_price_sol, entry_mcap_sol, sol_in, tokens, "
                "tokens_left, sol_out, peak_price_sol, last_price_sol, tp_done, status, buy_sig) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (mode, mint, sym, trigger, detail, time.time(), entry_px, px * SUPPLY, sol_in, tokens, tokens, 0.0, px, px, "[]", "open", sig))
            p = {"id": pid, "mode": mode, "mint": mint, "symbol": sym, "trigger": trigger, "detail": detail, "opened": time.time(),
                 "entry_price_sol": entry_px, "entry_mcap_sol": px * SUPPLY, "sol_in": sol_in, "tokens": tokens, "tokens_left": tokens,
                 "sol_out": 0.0, "peak_price_sol": px, "last_price_sol": px, "tp_done": [], "status": "open", "buy_sig": sig}
            self.open[pid] = p
            await self._order(mode, pid, "buy", mint, sym, sol_in, tokens, px, sig, "filled", None, f"{trigger}: {detail}")
            self.stats["buys"] += 1
            self.tracker.launch_watch[mint] = max(self.tracker.launch_watch.get(mint, 0), time.time() + 6 * 3600)
            tag = "🤖" if mode == "real" else "🧪"
            await feed.push("autopilot", "buy", f"{tag} {mode.upper()} bought ${sym} · {sol_in:.3f} SOL", f"{trigger}: {detail}", mint)
            await self.alerts.send("buy" if mode == "real" else "info", f"{tag} Autopilot {mode} BUY ${sym}",
                                   f"{sol_in:.3f} SOL · {trigger}: {detail}", token=mint, dedupe=f"ap:buy:{pid}", ttl=86400)
            await hub.publish("autopilot", await self.snapshot())
            return p
        except Exception as e:
            await self._order(mode, None, "buy", mint, sym, size, 0, px, None, "failed", str(e)[:200], f"{trigger}: {detail}")
            self.stats["errors"] += 1
            self.stats["last_error"] = f"buy {sym}: {e}"[:200]
            raise
        finally:
            self.busy.discard(mint)

    async def sell(self, p: dict[str, Any], frac: float, reason: str) -> None:
        if p["mint"] in self.busy or p["tokens_left"] <= 0:
            return
        self.busy.add(p["mint"])
        try:
            px, _ = await self.price(p["mint"])
            px = px or p["last_price_sol"]
            qty = p["tokens_left"] if frac >= 0.999 else p["tokens_left"] * frac
            if p["mode"] == "real":
                ex = self.c["exec"]
                res = await self.wallet.sell(p["mint"], qty, frac >= 0.999, ex["slippage_pct"], ex["priority_fee_sol"])
                got, sold, sig = res["sol"], res["tokens"] or qty, res["sig"]
            else:
                L = self.sniper.launches.get(p["mint"])
                impact = qty * px / max(30.0, (L.vsol if L and L.vsol else 60.0))
                got = max(0.0, qty * px * 0.99 * (1 - impact - 0.005) - self.c["exec"]["priority_fee_sol"])
                sold, sig = qty, None
                await self._demo_add(got, p["mode"])
            p["tokens_left"] = max(0.0, p["tokens_left"] - sold)
            p["sol_out"] += got
            closing = p["tokens_left"] <= p["tokens"] * 0.001
            if closing:
                p.update(status="closed", exit_reason=reason, closed=time.time(), pnl_sol=p["sol_out"] - p["sol_in"])
                self.open.pop(p["id"], None)
                if p["mode"] == "auto" or p.get("trigger") in ("brain", "copy"):
                    try:
                        await self.brain.learn(p)
                    except Exception as e:  # noqa: BLE001
                        log.warning("brain learn: %s", e)
            await self.db.exec("UPDATE auto_positions SET tokens_left=?, sol_out=?, status=?, exit_reason=?, closed=?, pnl_sol=?, tp_done=? WHERE id=?",
                               (p["tokens_left"], p["sol_out"], p["status"], p.get("exit_reason"), p.get("closed"), p.get("pnl_sol"),
                                json.dumps(p["tp_done"]), p["id"]))
            await self._order(p["mode"], p["id"], "sell", p["mint"], p["symbol"], got, sold, px, sig, "filled", None, reason)
            self.stats["sells"] += 1
            x = px / p["entry_price_sol"] if p["entry_price_sol"] else 0
            tag = "🤖" if p["mode"] == "real" else "🧪"
            msg = f"{frac * 100:.0f}% at {x:.2f}× · +{got:.3f} SOL" + (f" · PnL {p['pnl_sol']:+.3f} SOL" if closing else "")
            await feed.push("autopilot", "sell", f"{tag} {p['mode'].upper()} sold ${p['symbol']} ({reason})", msg, p["mint"])
            await self.alerts.send("exit" if p["mode"] == "real" else "info", f"{tag} Autopilot {p['mode']} SELL ${p['symbol']} — {reason}", msg,
                                   token=p["mint"], dedupe=f"ap:sell:{p['id']}:{len(p['tp_done'])}:{reason}", ttl=86400)
            await hub.publish("autopilot", await self.snapshot())
        except Exception as e:  # noqa: BLE001
            self.stats["errors"] += 1
            self.stats["last_error"] = f"sell {p['symbol']}: {e}"[:200]
            await self._order(p["mode"], p["id"], "sell", p["mint"], p["symbol"], 0, 0, None, None, "failed", str(e)[:200], reason)
        finally:
            self.busy.discard(p["mint"])

    async def _order(self, mode: str, pid: int | None, side: str, mint: str, sym: str, sol: float, tokens: float, px: float | None,
                     sig: str | None, status: str, error: str | None, reason: str) -> None:
        await self.db.exec("INSERT INTO auto_orders (ts, mode, position_id, side, mint, symbol, sol, tokens, price_sol, sig, status, error, reason) "
                           "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (time.time(), mode, pid, side, mint, sym, sol, tokens, px, sig, status, error, reason))

    # ---------------- exits ----------------
    async def manage(self) -> None:
        e = self.c["exits"]
        now = time.time()
        for p in list(self.open.values()):
            px, L = await self.price(p["mint"])
            if not px:
                continue
            p["last_price_sol"] = px
            p["peak_price_sol"] = max(p["peak_price_sol"], px)
            x = px / p["entry_price_sol"]
            peak_x = p["peak_price_sol"] / p["entry_price_sol"]
            if p["mode"] == "auto" or p.get("trigger") in ("brain", "copy"):   # the brain runs its own exits
                ex = self.brain.exit_for(p, L.result if L is not None else None, x, peak_x)
                if ex:
                    await self.sell(p, ex[0], ex[1])
                    if p["id"] in self.open:
                        await self.brain.note("sell", f"🟡 Sold {ex[0] * 100:.0f}% of ${p['symbol']} at {x:.2f}× — {ex[1]}", mint=p["mint"])
                    else:
                        await self.brain.note("sell", f"🔴 Closed ${p['symbol']} at {x:.2f}× — {ex[1]} · PnL {p['pnl_sol']:+.3f} SOL",
                                              mint=p["mint"])
                continue
            for i, step in enumerate(e["tp"]):
                if i not in p["tp_done"] and x >= step["x"]:
                    p["tp_done"].append(i)
                    await self.sell(p, step["sell"], f"take profit {step['x']:g}×")
                    break
            else:
                if x <= 1 - e["stop_loss_pct"] / 100:
                    await self.sell(p, 1.0, f"stop loss -{e['stop_loss_pct']:.0f}%")
                elif e["trailing_pct"] and peak_x >= e["trail_after_x"] and px <= p["peak_price_sol"] * (1 - e["trailing_pct"] / 100):
                    await self.sell(p, 1.0, f"trailing stop ({peak_x:.1f}× peak)")
                elif e["time_stop_min"] and now - p["opened"] > e["time_stop_min"] * 60 and x < 1.3:
                    await self.sell(p, 1.0, f"time stop {e['time_stop_min']}m")
                elif e["rug_exit"] and L is not None and (L.result or {}).get("tier") == "TRAP":
                    await self.sell(p, 1.0, "rug exit: " + ", ".join((L.result or {}).get("flags") or ["TRAP"]))
            if p["id"] in self.open and self.stats["ticks"] % 10 == 0:
                await self.db.exec("UPDATE auto_positions SET last_price_sol=?, peak_price_sol=?, tp_done=? WHERE id=?",
                                   (px, p["peak_price_sol"], json.dumps(p["tp_done"]), p["id"]))

    async def panic(self) -> int:
        self.c["mode"] = "off"
        await self.cfg.kv_set("autopilot:cfg", self.c)
        n = 0
        for p in list(self.open.values()):
            await self.sell(p, 1.0, "panic")
            n += 1
        await feed.push("autopilot", "panic", f"🛑 Panic: sold {n} positions, Autopilot OFF", "")
        return n

    # ---------------- reads ----------------
    async def snapshot(self) -> dict[str, Any]:
        out = []
        for p in self.open.values():
            x = p["last_price_sol"] / p["entry_price_sol"] if p["entry_price_sol"] else None
            value = p["tokens_left"] * p["last_price_sol"]
            out.append({**{k: p[k] for k in ("id", "mode", "mint", "symbol", "trigger", "detail", "opened", "sol_in", "sol_out",
                                             "tokens", "tokens_left", "tp_done", "status", "buy_sig")},
                        "x": round(x, 3) if x else None, "peak_x": round(p["peak_price_sol"] / p["entry_price_sol"], 3),
                        "value_sol": round(value, 6), "pnl_sol": round(p["sol_out"] + value - p["sol_in"], 6)})
        return {"mode": self.c["mode"], "open": sorted(out, key=lambda r: -r["opened"]), "paused_reason": self.paused_reason,
                "auto_balance": await self.demo_balance("auto"),
                "stats": self.stats}

    async def summary(self, mode: str) -> dict[str, Any]:
        r = await self.db.one("SELECT COUNT(*) n, SUM(pnl_sol > 0) wins, COALESCE(SUM(pnl_sol),0) pnl, COALESCE(SUM(sol_in),0) invested, "
                              "MAX(pnl_sol) best, MIN(pnl_sol) worst FROM auto_positions WHERE mode=? AND status='closed'", (mode,)) or {}
        n = r.get("n") or 0
        return {"closed": n, "win_rate": round((r.get("wins") or 0) / n * 100, 1) if n else None, "pnl_sol": round(r.get("pnl") or 0, 4),
                "invested_sol": round(r.get("invested") or 0, 4), "best_sol": r.get("best"), "worst_sol": r.get("worst"),
                "today": await self.today(mode)}
