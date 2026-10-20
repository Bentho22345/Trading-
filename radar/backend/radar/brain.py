"""Self-driving Autopilot: Radar's own trading algorithm, running on its own demo money, learning from every trade.

How it values a coin
  Every live launch is turned into ~16 features Radar already measures (upside, risk, top-wallet entries, graduation
  pace, buy pressure, buyer count, organic flow, Claude's meme score, the tweet it came from, YouTube, off-crypto
  trends, insider holdings, fresh wallets, the dev's record, age, size). A logistic model turns them into a 0-100
  "value". It buys the best coins above its entry bar, sizing by conviction (how far above the bar).

How it trades
  Its own exits, not the manual ladder: -30% stop · sell 40% at 2.5× · trailing stop that tightens as the gain grows
  (35% → 25% → 18%) · sell when sellers take over · 30-minute time stop if it isn't working · instant rug exits.
  Max 5 positions, ~3% of its balance per trade, never two from the same dev.

How it learns
  When a position closes, the features it bought on and the result (win = closed ≥ 1.15×) update the weights with an
  online gradient step — features that keep showing up in losers lose weight, winners' features gain it. Its entry bar
  rises after a losing streak (pickier) and eases after a good run. ~10% of buys are small "explore" bets just under the
  bar so it keeps learning about coins it would otherwise never try. Everything it thinks is streamed to the page.

Demo money only. It never touches the trading wallet.
"""
from __future__ import annotations

import json
import math
import random
import time
from collections import deque
from typing import Any

from . import feed
from .hub import hub

PRIORS: dict[str, float] = {
    "upside": 3.0, "risk": -2.5, "alpha": 1.5, "velocity": 1.2, "buy_pressure": 0.8, "buyers": 0.8, "organic": 0.8,
    "meme": 1.0, "tweet": 1.5, "youtube": 0.7, "trend": 0.6, "insiders": -2.0, "fresh": -0.6, "dev": 0.7, "young": 0.5, "small": 0.5,
}
LABELS = {"upside": "Upside score", "risk": "Risk score", "alpha": "Top wallets in", "velocity": "Graduation pace", "buy_pressure": "Buy pressure",
          "buyers": "Buyer count", "organic": "Organic flow", "meme": "Claude meme score", "tweet": "Spawned by a tracked tweet",
          "youtube": "YouTube buzz", "trend": "Off-crypto trend", "insiders": "Insiders holding", "fresh": "Fresh wallets",
          "dev": "Dev's graduations", "young": "Earliness", "small": "Small market cap"}
BIAS0 = -3.4
MAX_OPEN = 5
LR = 0.15


def _sig(z: float) -> float:
    return 1 / (1 + math.exp(-max(-30.0, min(30.0, z))))


def features(r: dict[str, Any]) -> dict[str, float]:
    mx = r.get("metrics") or {}
    eta = r.get("eta_min")
    mc = r.get("mcap_usd") or 0
    return {
        "upside": (r.get("upside") or 0) / 100,
        "risk": (r.get("risk") or 0) / 100,
        "alpha": min(1.0, len(r.get("alpha") or []) / 3),
        "velocity": 1.0 if r.get("graduated_at") else (1.0 if eta is not None and eta <= 5 else 0.7 if eta is not None and eta <= 10
                                                       else 0.4 if eta is not None and eta <= 20 else 0.1 if eta is not None else 0.0),
        "buy_pressure": min(1.0, (mx.get("buy_ratio_1m") or 0) / 4),
        "buyers": min(1.0, math.log10(1 + (r.get("buyers") or 0)) / 2.5),
        "organic": ((r.get("organic") if r.get("organic") is not None else 50) or 0) / 100,
        "meme": (mx["ai_meme_score"] / 10) if mx.get("ai_meme_score") is not None else 0.4,
        "tweet": (mx.get("x_tweet_score") or 0) / 100,
        "youtube": min(1.0, (mx.get("yt_videos") or 0) / 3),
        "trend": 1.0 if mx.get("web_trend") else 0.0,
        "insiders": min(1.0, (mx.get("insider_hold_pct") or 0) / 25),
        "fresh": (mx.get("fresh_pct") or 0) / 100,
        "dev": min(1.0, (mx.get("dev_graduated") or 0) / 3),
        "young": 1 - min(1.0, (r.get("age_s") or 0) / 1200),
        "small": 1 - min(1.0, mc / 100_000) if mc else 0.5,
    }


class Brain:
    def __init__(self, ap: Any) -> None:
        self.ap = ap
        self.w: dict[str, float] = dict(PRIORS)
        self.b = BIAS0
        self.threshold = 62.0
        self.trained = 0
        self.log: deque[dict[str, Any]] = deque(maxlen=250)
        self.candidates: list[dict[str, Any]] = []
        self.last_publish = 0.0
        self.last_skip_note = 0.0
        self.last_equity = 0.0
        self.last_buy_ts = 0.0
        self.rng = random.Random()

    # ---------------- state ----------------
    async def load(self) -> None:
        s = await self.ap.cfg.kv_get("brain:state") or {}
        self.w = {k: float(s.get("w", {}).get(k, v)) for k, v in PRIORS.items()}
        self.b = float(s.get("b", BIAS0))
        self.threshold = float(s.get("threshold", 62.0))
        self.trained = int(s.get("trained", 0))

    async def save(self) -> None:
        await self.ap.cfg.kv_set("brain:state", {"w": self.w, "b": self.b, "threshold": self.threshold, "trained": self.trained})

    async def reset(self) -> None:
        self.w, self.b, self.threshold, self.trained = dict(PRIORS), BIAS0, 62.0, 0
        self.log.clear()
        await self.save()
        await self.ap.reset_demo("auto")
        await self.ap.db.exec("DELETE FROM auto_equity WHERE mode='auto'")
        await self.note("reset", "🧠 Fresh start: weights back to their priors, 10 SOL of demo money.")

    def value(self, f: dict[str, float]) -> float:
        return round(100 * _sig(self.b + sum(self.w[k] * f.get(k, 0.0) for k in self.w)), 1)

    def why(self, f: dict[str, float], n: int = 3) -> str:
        contrib = sorted(((self.w[k] * f.get(k, 0.0), k) for k in self.w), reverse=True)
        pos = [f"{LABELS[k].lower()}" for c, k in contrib[:n] if c > 0.15]
        neg = [f"{LABELS[k].lower()}" for c, k in contrib[::-1][:2] if c < -0.15]
        return ("+ " + ", ".join(pos) if pos else "") + (" · − " + ", ".join(neg) if neg else "")

    async def note(self, kind: str, text: str, **extra: Any) -> None:
        ev = {"ts": time.time(), "kind": kind, "text": text, **extra}
        self.log.appendleft(ev)
        await hub.publish("brain", {"event": ev})

    # ---------------- the loop step (called every second by Autopilot in self-driving mode) ----------------
    async def tick(self) -> None:
        ap = self.ap
        now = time.time()
        rows = ap.sniper.board(appetite="degen", limit=80, max_age_min=20)["rows"]
        scored = []
        for r in rows:
            f = features(r)
            v = self.value(f)
            hard = self.hard_no(r)
            scored.append({"mint": r["mint"], "symbol": r.get("symbol"), "value": v, "hard": hard, "why": self.why(f), "f": f,
                           "mcap_usd": r.get("mcap_usd"), "age_s": r.get("age_s"), "tier": r.get("tier"), "deployer": r.get("deployer")})
        scored.sort(key=lambda c: -c["value"])
        self.candidates = scored[:12]
        if now - self.last_publish > 3:
            self.last_publish = now
            await hub.publish("brain", {"candidates": self.public_candidates(), "threshold": self.threshold})
        open_auto = [p for p in ap.open.values() if p["mode"] == "auto"]
        if len(open_auto) >= MAX_OPEN:
            return
        bal = await ap.demo_balance("auto")
        if bal < 0.2:
            if now - self.last_skip_note > 600:
                self.last_skip_note = now
                await self.note("skip", "💸 Out of demo money — reset the brain to start over.")
            return
        if now - self.last_buy_ts < 8:
            return
        devs = {(ap.sniper.launches.get(p["mint"]).deployer if ap.sniper.launches.get(p["mint"]) else None) for p in open_auto}
        for c in scored:
            if c["mint"] in ap.entered or c["mint"] in ap.busy or c["hard"]:
                continue
            if c["deployer"] and c["deployer"] in devs:
                continue
            explore = False
            if c["value"] < self.threshold:
                if c["value"] >= self.threshold - 8 and self.rng.random() < 0.10:
                    explore = True
                else:
                    if c is scored[0] or c["value"] >= self.threshold - 3:
                        if now - self.last_skip_note > 20:
                            self.last_skip_note = now
                            await self.note("skip", f"👀 Best right now is ${c['symbol']} at {c['value']:.0f} — under my bar of "
                                                    f"{self.threshold:.0f}, waiting.", mint=c["mint"], value=c["value"])
                    break
            conv = max(0.0, min(1.0, (c["value"] - self.threshold) / max(5.0, 100 - self.threshold)))
            base = max(0.05, min(1.0, bal * 0.03))
            size = round(base * (0.5 if explore else 0.6 + 0.9 * conv), 4)
            detail = f"value {c['value']:.0f} (bar {self.threshold:.0f}){' · explore' if explore else ''} · {c['why']}"
            try:
                p = await ap.buy(c["mint"], "brain", detail, ap.sniper.one(c["mint"]), sol=size, mode="auto")
            except Exception as e:  # noqa: BLE001
                await self.note("error", f"⚠️ Couldn't buy ${c['symbol']}: {e}", mint=c["mint"])
                continue
            await ap.db.exec("UPDATE auto_positions SET features_json=?, score=? WHERE id=?", (json.dumps(c["f"]), c["value"], p["id"]))
            p["features"], p["score"] = c["f"], c["value"]
            self.last_buy_ts = now
            await self.note("buy", f"{'🧪' if explore else '🟢'} Bought ${c['symbol']} for ◎{size:.3f} — {detail}", mint=c["mint"],
                            value=c["value"], sol=size)
            return                                                  # one buy per tick: watchable, and no pile-ins

    @staticmethod
    def hard_no(r: dict[str, Any]) -> str | None:
        mx = r.get("metrics") or {}
        if r.get("tier") == "TRAP":
            return "TRAP"
        if r.get("bundled"):
            return "bundled"
        if (mx.get("insider_hold_pct") or 0) >= 15:
            return "insiders"
        if (r.get("mcap_usd") or 0) > 150_000:
            return "too big"
        if (r.get("buyers") or 0) < 6:
            return "too few buyers"
        if (mx.get("ai_derivative") is True) and (mx.get("ai_meme_score") or 5) <= 2:
            return "low-effort copy"
        return None

    # ---------------- its own exits ----------------
    def exit_for(self, p: dict[str, Any], r: dict[str, Any] | None, x: float, peak_x: float) -> tuple[float, str] | None:
        age = time.time() - p["opened"]
        mx = (r or {}).get("metrics") or {}
        if r and (r.get("tier") == "TRAP" or (mx.get("insider_hold_pct") or 0) >= 20):
            return 1.0, "rug exit: " + ", ".join(r.get("flags") or ["insiders"])
        if x <= 0.70:
            return 1.0, "stop -30%"
        if x >= 2.5 and 100 not in p["tp_done"]:
            p["tp_done"].append(100)
            return 0.4, "took 40% at 2.5×"
        if peak_x >= 1.5:
            trail = 0.35 if peak_x < 2 else 0.25 if peak_x < 5 else 0.18
            if x <= peak_x * (1 - trail):
                return 1.0, f"trailing stop ({peak_x:.1f}× peak, {trail * 100:.0f}% trail)"
        if (mx.get("sells_1m") or 0) >= 6 and (mx.get("sells_1m") or 0) > 2 * (mx.get("buys_1m") or 0) and x < peak_x * 0.85:
            return 1.0, "sellers took over"
        if age > 1800 and x < 1.2:
            return 1.0, "30-min time stop"
        return None

    # ---------------- learning ----------------
    async def learn(self, p: dict[str, Any]) -> None:
        f = p.get("features")
        if not f:
            row = await self.ap.db.one("SELECT features_json FROM auto_positions WHERE id=?", (p["id"],))
            f = json.loads((row or {}).get("features_json") or "null")
        if not f:
            return
        mult = (p["sol_out"] / p["sol_in"]) if p["sol_in"] else 0
        y = 1.0 if mult >= 1.15 else 0.0
        pred = _sig(self.b + sum(self.w[k] * f.get(k, 0.0) for k in self.w))
        err = y - pred
        moved = []
        for k in self.w:
            d = LR * err * f.get(k, 0.0)
            if abs(d) > 0.02:
                moved.append((d, k))
            self.w[k] = max(-6.0, min(6.0, self.w[k] + d))
        self.b = max(-8.0, min(2.0, self.b + LR * err))
        self.trained += 1
        recent = await self.ap.db.all("SELECT pnl_sol FROM auto_positions WHERE mode='auto' AND status='closed' ORDER BY closed DESC LIMIT 20")
        old = self.threshold
        if len(recent) >= 8:
            wr = sum(1 for r in recent if (r["pnl_sol"] or 0) > 0) / len(recent)
            if wr < 0.30:
                self.threshold = min(88.0, self.threshold + 2)
            elif wr > 0.50:
                self.threshold = max(45.0, self.threshold - 1)
        await self.save()
        moved.sort(key=lambda m: -abs(m[0]))
        lesson = ", ".join(f"{LABELS[k].lower()} {'↑' if d > 0 else '↓'}" for d, k in moved[:3]) or "small adjustment"
        await self.note("learn", f"{'✅' if y else '❌'} ${p['symbol']} closed at {mult:.2f}× — I expected {pred * 100:.0f}% odds. "
                                 f"Learned: {lesson}." + (f" Entry bar {old:.0f} → {self.threshold:.0f}." if self.threshold != old else ""),
                        mint=p["mint"])

    # ---------------- equity curve ----------------
    async def equity_tick(self) -> None:
        now = time.time()
        if now - self.last_equity < 30:
            return
        self.last_equity = now
        bal = await self.ap.demo_balance("auto")
        held = sum(p["tokens_left"] * p["last_price_sol"] for p in self.ap.open.values() if p["mode"] == "auto")
        await self.ap.db.exec("INSERT INTO auto_equity (ts, mode, equity) VALUES (?,?,?)", (now, "auto", round(bal + held, 6)))

    # ---------------- reads ----------------
    def public_candidates(self) -> list[dict[str, Any]]:
        return [{k: c[k] for k in ("mint", "symbol", "value", "hard", "why", "mcap_usd", "age_s", "tier")} for c in self.candidates]

    async def snapshot(self) -> dict[str, Any]:
        eq = await self.ap.db.all("SELECT ts, equity FROM auto_equity WHERE mode='auto' ORDER BY ts DESC LIMIT 600")
        return {"threshold": self.threshold, "trained": self.trained, "bias": round(self.b, 3),
                "weights": [{"key": k, "label": LABELS[k], "w": round(v, 3), "prior": PRIORS[k]} for k, v in
                            sorted(self.w.items(), key=lambda kv: -abs(kv[1]))],
                "candidates": self.public_candidates(), "log": list(self.log)[:120], "equity": eq[::-1],
                "balance": await self.ap.demo_balance("auto"), "summary": await self.ap.summary("auto")}
