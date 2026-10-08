"""Signal engine (Radar Score -> BUY/WATCH/AVOID, logged with exact inputs), Rug Shield and the Risk & Exit Manager."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from . import scoring
from .hub import hub

log = logging.getLogger("radar.signals")
DISCLAIMER = "Signals are probabilistic. Most memecoins go to zero. Only risk money you can lose."

WRITEUP_SYSTEM = """You write the one-paragraph reason on a memecoin signal card for an experienced trader.
Use ONLY the data provided; never invent numbers, names or events. Plain English, 3-5 sentences, no hype.
State the verdict, the strongest supporting evidence, the biggest risk, and what would invalidate it."""


class SignalEngine:
    def __init__(self, db: Any, cfg: Any, tracker: Any, social: Any, smart: Any, paper: Any, alerts: Any, ai: Any) -> None:
        self.db, self.cfg, self.tracker, self.social, self.smart = db, cfg, tracker, social, smart
        self.paper, self.alerts, self.ai = paper, alerts, ai
        self.last: dict[str, tuple[str, float]] = {}
        self.prev_liq: dict[str, float] = {}
        self.prev_safety: dict[str, dict[str, Any]] = {}

    async def regime(self) -> dict[str, Any] | None:
        rows = {r["key"]: r for r in await self.db.all("SELECT key, value, data_json, as_of FROM market")}
        if not rows:
            return None
        def chg(k: str) -> float | None:
            r = rows.get(k)
            return json.loads(r["data_json"] or "{}").get("chg_24h") if r and time.time() - r["as_of"] < 600 else None
        fg = rows.get("fear_greed")
        out = {"btc_chg_24h": chg("px_BTC"), "sol_chg_24h": chg("px_SOL"),
               "fear_greed": fg["value"] if fg and time.time() - fg["as_of"] < 2 * 86400 else None}
        return out if any(v is not None for v in out.values()) else None

    async def inputs(self, addr: str) -> dict[str, Any]:
        tok = await self.tracker.token_summary(addr)
        safety = await self.db.one("SELECT * FROM safety_reports WHERE token_address=?", (addr,))
        if safety:
            safety = {k: v for k, v in safety.items() if k not in ("risks_json", "top_holders_json")}
        ticks = await self.db.all("SELECT ts, price_usd, liquidity_usd, market_cap FROM price_ticks WHERE token_address=? "
                                  "AND ts > ? ORDER BY ts", (addr, time.time() - 3600))
        return {"token": tok, "safety": safety, "narrative": await self.social.narrative_for_token(addr),
                "smart_money": await self.smart.input_for(addr), "regime": await self.regime(),
                "dev": await self.social.deployer_history((tok or {}).get("deployer")), "ticks": ticks[-60:]}

    async def evaluate(self, addr: str, force: bool = False) -> dict[str, Any] | None:
        inp = await self.inputs(addr)
        if not inp["token"] or inp["token"].get("price_usd") is None:
            return None
        risk = self.cfg.risk
        res = scoring.evaluate(inp, self.cfg.scoring, risk)
        prev = self.last.get(addr)
        resig = self.cfg.scoring["engine"]["resignal_after_s"]
        if not force and prev and prev[0] == res["verdict"] and (res["verdict"] != "BUY" or time.time() - prev[1] < resig):
            return res
        self.last[addr] = (res["verdict"], time.time())
        await self.apply_risk_limits(res)
        n = inp["narrative"]
        cat = (n or {}).get("category") or await self.category_of(inp["token"])
        sid = await self.db.exec(
            "INSERT INTO signals (ts, token_address, symbol, verdict, score, confidence, risk_grade, subscores_json, vetoes_json, "
            "reasons_json, plan_json, inputs_json, narrative_id, category, writeup, config_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (res["ts"], addr, inp["token"].get("symbol"), res["verdict"], res["score"], res["confidence"], res["risk_grade"],
             json.dumps(res["subscores"]), json.dumps(res["vetoes"]), json.dumps({"why": res["reasons"], "risks": res["risks"]}),
             json.dumps(res["plan"]), json.dumps(inp, default=str), (n or {}).get("id"), cat, self.template(res, inp),
             str(self.cfg.scoring.get("version"))))
        sig = {**res, "id": sid, "token_address": addr, "symbol": inp["token"].get("symbol"), "name": inp["token"].get("name"),
               "category": cat, "narrative_title": (n or {}).get("title"), "writeup": self.template(res, inp),
               "price_usd": inp["token"].get("price_usd"), "disclaimer": DISCLAIMER}
        if res["verdict"] in self.cfg.scoring["engine"].get("paper_trade_verdicts", ["BUY"]):
            await self.paper.open(sig, inp["token"])
        await hub.publish("signal", sig)
        if res["verdict"] == "BUY":
            asyncio.create_task(self._buy_followups(sig, inp))
        return sig

    async def _buy_followups(self, sig: dict[str, Any], inp: dict[str, Any]) -> None:
        if self.ai.enabled:
            try:
                prompt = json.dumps({"verdict": sig["verdict"], "score": sig["score"], "confidence": sig["confidence"],
                                     "risk_grade": sig["risk_grade"], "subscores": sig["subscores"], "reasons": sig["reasons"],
                                     "risks": sig["risks"], "plan": sig["plan"], "token": {k: inp["token"].get(k) for k in (
                                         "symbol", "name", "price_usd", "market_cap", "liquidity_usd", "vol_h1", "vol_h24",
                                         "chg_m5", "chg_h1", "buys_m5", "sells_m5")},
                                     "narrative": {k: (inp["narrative"] or {}).get(k) for k in ("title", "category", "stage", "vel_5m",
                                                                                                "sources")}}, default=str)
                text = await self.ai.write(WRITEUP_SYSTEM, prompt, "writeup", max_tokens=600)
                await self.db.exec("UPDATE signals SET writeup=? WHERE id=?", (text, sig["id"]))
                sig["writeup"] = text
                await hub.publish("signal_writeup", {"id": sig["id"], "writeup": text})
            except Exception as e:  # noqa: BLE001
                log.debug("writeup: %s", e)
        p = sig.get("plan") or {}
        await self.alerts.send("buy", f"🟢 BUY SIGNAL {sig.get('symbol')} · score {sig['score']} · {sig['confidence']} conf · grade {sig['risk_grade']}",
                               f"{sig['writeup'][:600]}\nSize ${p.get('size_usd')} · stop -{p.get('stop_pct')}% · "
                               f"time stop {p.get('time_stop_hours')}h\n{DISCLAIMER}",
                               token=sig["token_address"], dedupe=f"buy:{sig['token_address']}",
                               ttl=self.cfg.scoring["engine"]["resignal_after_s"])

    def template(self, res: dict[str, Any], inp: dict[str, Any]) -> str:
        t = inp["token"] or {}
        bits = [f"{res['verdict']} on {t.get('symbol') or 'this token'}: Radar Score {res['score']} "
                f"({res['confidence']} confidence, risk grade {res['risk_grade']})."]
        if res["vetoes"]:
            bits.append("Hard veto: " + "; ".join(res["vetoes"]) + ".")
        if res["reasons"]:
            bits.append("Supporting: " + "; ".join(res["reasons"][:4]) + ".")
        if res["risks"]:
            bits.append("Risks: " + "; ".join(res["risks"][:3]) + ".")
        return " ".join(bits)

    async def category_of(self, tok: dict[str, Any]) -> str:
        from .social.text import category
        return category(f"{tok.get('name') or ''} {tok.get('symbol') or ''}", self.cfg.watch.get("category_keywords") or {})

    async def apply_risk_limits(self, res: dict[str, Any]) -> None:
        if res["verdict"] != "BUY" or not res.get("plan"):
            return
        cd = float(await self.cfg.kv_get("risk:cooldown_until", 0) or 0)
        openp = await self.db.one("SELECT COUNT(*) n FROM positions WHERE closed IS NULL")
        notes = []
        if cd > time.time():
            notes.append(f"cooldown active until {time.strftime('%H:%M', time.localtime(cd))} (daily loss limit hit)")
        if openp["n"] >= int(self.cfg.risk.get("max_open_positions", 5)):
            notes.append(f"max open positions reached ({openp['n']})")
        if notes:
            res["plan"]["size_usd"] = 0
            res["plan"]["blocked"] = notes
            res["risks"].extend(notes)

    async def loop(self) -> None:
        every = float(__import__("os").environ.get("SIGNAL_EVERY") or self.cfg.scoring["engine"]["evaluate_every_s"])
        while True:
            try:
                rows = await self.db.all("SELECT address FROM tokens WHERE last_refresh > ? ORDER BY last_refresh DESC LIMIT 400",
                                         (time.time() - 180,))
                for r in rows:
                    await self.evaluate(r["address"])
                await self.paper.update()
                await self.position_exits()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("signal loop: %s", e)
            await asyncio.sleep(every)

    # ---------------- Rug Shield ----------------
    async def monitored(self) -> set[str]:
        out = {r["address"] for r in await self.db.all("SELECT address FROM watchlist")}
        out |= {r["token_address"] for r in await self.db.all("SELECT token_address FROM positions WHERE closed IS NULL")}
        out |= {r["token_address"] for r in await self.db.all("SELECT token_address FROM paper_trades WHERE closed IS NULL AND verdict='BUY'")}
        return out

    async def rug_shield_tokens(self, rows: list[dict[str, Any]]) -> None:
        mon = await self.monitored()
        k = self.cfg.scoring["rug_shield"]
        for t in rows:
            a = t["address"]
            liq = t.get("liquidity_usd")
            if a in mon and liq is not None:
                prev = self.prev_liq.get(a)
                if prev and prev > 2000 and liq < prev * (1 - k["liquidity_drop_pct"] / 100):
                    await self.alerts.send("rug", f"🚨 RUG SHIELD: liquidity pulled on {t.get('symbol')}",
                                           f"Liquidity ${prev:,.0f} → ${liq:,.0f} ({(liq / prev - 1) * 100:.0f}%)", token=a,
                                           dedupe=f"liq:{a}", ttl=1800)
            if liq is not None:
                self.prev_liq[a] = liq

    async def rug_shield_safety(self, rep: dict[str, Any]) -> None:
        a = rep["token_address"]
        prev = self.prev_safety.get(a)
        self.prev_safety[a] = rep
        if not prev or a not in await self.monitored():
            return
        for f, label in (("mint_authority", "Mint"), ("freeze_authority", "Freeze")):
            if rep.get(f) and not prev.get(f):
                await self.alerts.send("rug", f"🚨 RUG SHIELD: {label} authority re-enabled", rep.get(f) or "", token=a,
                                       dedupe=f"auth:{f}:{a}", ttl=86400)
        if rep.get("rugged") and not prev.get("rugged"):
            await self.alerts.send("rug", "🚨 RUG SHIELD: RugCheck now marks this token RUGGED", "", token=a, dedupe=f"rugged:{a}", ttl=86400)
        try:
            old = {h["address"]: h["pct"] for h in json.loads(prev.get("top_holders_json") or "[]")}
            new = {h["address"]: h["pct"] for h in json.loads(rep.get("top_holders_json") or "[]")}
            for addr, pct in old.items():
                drop = (pct or 0) - (new.get(addr) or 0)
                if drop >= self.cfg.scoring["rug_shield"]["top_holder_drop_pct"]:
                    await self.alerts.send("rug", f"🚨 RUG SHIELD: top holder dumped {drop:.1f}% of supply",
                                           f"holder {addr[:6]}… {pct:.1f}% → {new.get(addr) or 0:.1f}%", token=a,
                                           dedupe=f"holder:{a}:{addr}", ttl=3600)
        except (ValueError, TypeError):
            pass

    async def rug_shield_trade(self, trade: dict[str, Any]) -> None:
        if trade.get("side") != "sell":
            return
        tok = await self.db.one("SELECT deployer, symbol FROM tokens WHERE address=?", (trade["mint"],))
        if tok and tok["deployer"] and tok["deployer"] == trade.get("trader") and trade["mint"] in await self.monitored():
            await self.alerts.send("rug", f"🚨 RUG SHIELD: dev wallet is selling {tok['symbol']}",
                                   f"Deployer sold {trade.get('sol') or 0:.2f} SOL worth", token=trade["mint"],
                                   dedupe=f"devsell:{trade['mint']}", ttl=900)

    async def rug_refresh_loop(self) -> None:
        while True:
            for a in await self.monitored():
                await self.db.exec("UPDATE safety_reports SET as_of=0 WHERE token_address=?", (a,))
                self.tracker.queue_rug(a)
            await asyncio.sleep(300)

    # ---------------- Risk & Exit Manager ----------------
    async def position_exits(self) -> None:
        for p in await self.db.all("SELECT * FROM positions WHERE closed IS NULL"):
            tok = await self.tracker.token_summary(p["token_address"])
            px = (tok or {}).get("price_usd")
            if not px or not p["entry_price"]:
                continue
            fills = json.loads(p["fills_json"] or "[]")
            done = {f["multiple"] for f in fills}
            for step in json.loads(p["ladder_json"] or "[]"):
                if step["multiple"] not in done and px >= p["entry_price"] * step["multiple"]:
                    fills.append({"multiple": step["multiple"], "alerted": time.time(), "price": px})
                    await self.alerts.send("exit", f"🎯 Take profit: {p['symbol']} hit {step['multiple']}x",
                                           f"Plan: sell {step['sell_fraction'] * 100:.0f}% of the original position at ~${px:.10g}",
                                           token=p["token_address"], dedupe=f"tp:{p['id']}:{step['multiple']}", ttl=86400)
            if p["stop_price"] and px <= p["stop_price"]:
                await self.alerts.send("exit", f"🛑 Stop hit: {p['symbol']}", f"Price ${px:.10g} ≤ stop ${p['stop_price']:.10g}",
                                       token=p["token_address"], dedupe=f"stop:{p['id']}", ttl=86400)
            await self.db.exec("UPDATE positions SET fills_json=? WHERE id=?", (json.dumps(fills), p["id"]))

    async def check_daily_loss(self) -> dict[str, Any]:
        day = time.time() - 86400
        r = await self.db.one("SELECT COALESCE(SUM(realized_usd),0) pnl FROM positions WHERE closed > ?", (day,))
        bank = float(self.cfg.risk.get("bankroll_usd", 0) or 0)
        limit = bank * float(self.cfg.risk.get("daily_loss_limit_pct", 5)) / 100
        out = {"realized_24h": r["pnl"], "limit_usd": limit, "cooldown_until": float(await self.cfg.kv_get("risk:cooldown_until", 0) or 0)}
        if bank and r["pnl"] <= -limit and out["cooldown_until"] < time.time():
            until = time.time() + float(self.cfg.risk.get("cooldown_hours", 12)) * 3600
            await self.cfg.kv_set("risk:cooldown_until", until)
            out["cooldown_until"] = until
            await self.alerts.send("exit", "🧊 Daily loss limit hit: cooldown lock on",
                                   f"Realized {r['pnl']:.2f} USD in 24h. BUY signals muted for {self.cfg.risk.get('cooldown_hours')}h.",
                                   dedupe="cooldown", ttl=3600)
        return out
