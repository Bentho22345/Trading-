"""Self-driving Autopilot, v2: Radar's own trading algorithm. Runs on its own demo money, and can drive real money
under your hard limits once you switch it on there.

What changed from v1 (which almost never bought: a typical coin scored ~29 against a fixed bar of 62)

  Calibrated entries   The bar is a PERCENTILE of what the brain is seeing right now (top ~8% at "aggressive"), so it
                       always trades the best of the current market instead of waiting for a perfect coin.
  ~28 signals          Adds bonding-curve progress (the strongest graduation predictor in the 2026 Pump.fun study),
                       net SOL flow, curve SOL/min, copy signal from the best wallets, social spread, socials, X
                       community, dev sold, sniper / bundle / top-10 concentration, bot wallets.
  Shadow learning      Every coin it scores is a lesson, not just the ones it buys: it notes the features, watches the
                       coin for 20 minutes and learns whether it ran (peaked ≥ 1.8×). Hundreds of labels an hour,
                       so the weights adapt to the market in hours, not weeks. Real trades still teach the most.
  Copy-trading         It follows the wallets Radar ranks (Top Traders), smart wallets and the ones you follow: one
                       top-20 wallet, or two top-100 wallets buying within 10 minutes = it copies, on new launches
                       AND on graduated coins. It MIRRORS their sells: a leader selling cuts the position.
  Kelly sizing         Once it has ≥10 closed trades, size = half-Kelly from its real win rate and win/loss ratio,
                       clamped 1-8% of the balance and scaled by conviction (until then ~3%).
  Exits                -30% stop (−40% at degen) · 40% off at 2.5× · stop to break-even after 1.8× · trailing stop
                       tightening 35/25/18% · "stalled" exit (no new high for 8 min under 1.3×) · sellers took over ·
                       30-min time stop · leader sold · instant rug exits.
  Speed                Ticks every 0.5 s straight off the live scoring objects (no board copies).

Real money: it only drives real money if you pick "Real money uses: Self-driving brain", and then every buy is still
capped by your SOL-per-buy hard cap, max open positions, daily SOL limit and daily loss limit.
"""
from __future__ import annotations

import json
import math
import random
import time
from collections import deque
from typing import Any

PRIORS: dict[str, float] = {
    "upside": 2.4, "risk": -2.0, "alpha": 1.4, "copy": 2.0, "velocity": 1.0, "progress": 0.8, "flow": 1.0, "sol_rate": 0.8,
    "buy_pressure": 0.7, "buyers": 0.8, "organic": 0.7, "meme": 0.9, "tweet": 1.4, "youtube": 0.6, "trend": 0.5,
    "social": 0.8, "socials": 0.4, "x_comm": 0.3, "dev": 0.6, "dev_sold": 0.3, "insiders": -1.8, "fresh": -0.5,
    "snipers": -0.8, "bundle": -1.0, "top10": -0.8, "bots": -0.4, "young": 0.4, "small": 0.4,
    # v3 — narrative first: memecoins trade on stories, so what the rest of Radar is finding gets real weight
    "narrative": 1.6, "ignition": 1.0, "mention_speed": 1.0, "x_calls": 1.5, "hype_bots": -1.0,
}
LABELS = {"upside": "Upside score", "risk": "Risk score", "alpha": "Top wallets in", "copy": "Best wallets buying now",
          "velocity": "Graduation pace", "progress": "Bonding-curve progress", "flow": "Net SOL flowing in", "sol_rate": "Curve SOL / min",
          "buy_pressure": "Buy pressure", "buyers": "Buyer count", "organic": "Organic flow", "meme": "Claude meme score",
          "tweet": "Spawned by a tracked tweet", "youtube": "YouTube buzz", "trend": "Off-crypto trend", "social": "People posting it",
          "socials": "Social links", "x_comm": "X community", "dev": "Dev's graduations", "dev_sold": "Dev already sold",
          "insiders": "Insiders holding", "fresh": "Fresh wallets", "snipers": "Snipers holding", "bundle": "Bundlers holding",
          "top10": "Top-10 concentration", "bots": "Bot wallets", "young": "Earliness", "small": "Small market cap",
          "narrative": "Live narrative strength", "ignition": "Narrative igniting", "mention_speed": "Mention speed (σ)",
          "x_calls": "Called by tracked X accounts", "hype_bots": "Bot-driven hype"}
BIAS0 = -3.0
AGGRESSION = {   # top-share of what it sees that it will buy, max positions, stop loss, base size of balance
    "careful": {"top": 0.03, "max_open": 3, "stop": 0.25, "base": 0.02, "floor": 35, "cooldown": 6, "copy_rank": 10},
    "aggressive": {"top": 0.08, "max_open": 6, "stop": 0.30, "base": 0.03, "floor": 25, "cooldown": 3, "copy_rank": 25},
    "degen": {"top": 0.15, "max_open": 10, "stop": 0.40, "base": 0.03, "floor": 18, "cooldown": 2, "copy_rank": 50},
    # demo default: lots of small bets — volume is how it learns and how it finds the runners
    "hyper": {"top": 0.25, "max_open": 20, "stop": 0.40, "base": 0.015, "floor": 12, "cooldown": 1, "copy_rank": 50},
}
LR_TRADE, LR_SHADOW = 0.12, 0.03


def _sig(z: float) -> float:
    return 1 / (1 + math.exp(-max(-30.0, min(30.0, z))))


def features(r: dict[str, Any], copy_n: float = 0.0, ctx: dict[str, Any] | None = None) -> dict[str, float]:
    mx = r.get("metrics") or {}
    n = (ctx or {}).get("narr") or {}
    xc = (ctx or {}).get("x_calls") or 0
    eta = r.get("eta_min")
    mc = r.get("mcap_usd") or 0
    return {
        "upside": (r.get("upside") or 0) / 100,
        "risk": (r.get("risk") or 0) / 100,
        "alpha": min(1.0, len(r.get("alpha") or []) / 3),
        "copy": min(1.0, copy_n / 3),
        "velocity": 1.0 if r.get("graduated_at") else (1.0 if eta is not None and eta <= 5 else 0.7 if eta is not None and eta <= 10
                                                       else 0.4 if eta is not None and eta <= 20 else 0.1 if eta is not None else 0.0),
        "progress": min(1.0, (r.get("progress") or 0) / 100),
        "flow": max(-1.0, min(1.0, (r.get("net_sol_1m") or 0) / 10)),
        "sol_rate": max(0.0, min(1.0, (r.get("sol_per_min") or 0) / 5)),
        "buy_pressure": min(1.0, (mx.get("buy_ratio_1m") or 0) / 4),
        "buyers": min(1.0, math.log10(1 + (r.get("buyers") or 0)) / 2.5),
        "organic": ((r.get("organic") if r.get("organic") is not None else 50) or 0) / 100,
        "meme": (mx["ai_meme_score"] / 10) if mx.get("ai_meme_score") is not None else 0.4,
        "tweet": (mx.get("x_tweet_score") or 0) / 100,
        "youtube": min(1.0, (mx.get("yt_videos") or 0) / 3),
        "trend": 1.0 if mx.get("web_trend") else 0.0,
        "social": min(1.0, (mx.get("social_authors") or 0) / 5),
        "socials": min(1.0, (mx.get("socials") or 0) / 3),
        "x_comm": 1.0 if mx.get("x_community") else 0.0,
        "dev": min(1.0, (mx.get("dev_graduated") or 0) / 3),
        "dev_sold": 1.0 if mx.get("dev_sold") else 0.0,
        "insiders": min(1.0, (mx.get("insider_hold_pct") or 0) / 25),
        "fresh": (mx.get("fresh_pct") or 0) / 100,
        "snipers": min(1.0, (mx.get("snipers_hold_pct") or 0) / 40),
        "bundle": min(1.0, (mx.get("bundle_hold_pct") or 0) / 30),
        "top10": min(1.0, (mx.get("chain_top10_pct") if mx.get("chain_top10_pct") is not None else mx.get("top10_pct") or 0) / 60),
        "bots": min(1.0, (mx.get("bot_wallets") or 0) / 5),
        "young": 1 - min(1.0, (r.get("age_s") or 0) / 1200),
        "small": 1 - min(1.0, mc / 100_000) if mc else 0.5,
        "narrative": min(1.0, (n.get("strength") or 0) / 100),
        "ignition": 1.0 if n.get("stage") == "ignition" else 0.5 if n.get("stage") == "peak" else 0.0,
        "mention_speed": max(0.0, min(1.0, (n.get("z") or 0) / 5)),
        "x_calls": min(1.0, xc / 2),
        "hype_bots": min(1.0, (n.get("bot_share") or 0) * 1.5),
    }


def percentile(vals: list[float], q: float) -> float:
    if not vals:
        return 100.0
    s = sorted(vals)
    return s[min(len(s) - 1, max(0, int(q * (len(s) - 1))))]


class Brain:
    def __init__(self, ap: Any) -> None:
        self.ap = ap
        self.w: dict[str, float] = dict(PRIORS)
        self.b = BIAS0
        self.aggression = "hyper"
        self.narr: dict[str, dict[str, Any]] = {}        # mint -> strongest live narrative it's matched to (social engine)
        self.x_calls: dict[str, int] = {}                # mint -> calls by tracked X accounts (last 2h)
        self.last_ctx = 0.0
        self.trained = 0
        self.shadow_trained = 0
        self.shadow_hits = 0
        self.brier = deque(maxlen=500)
        self.log: deque[dict[str, Any]] = deque(maxlen=300)
        self.candidates: list[dict[str, Any]] = []
        self.vals: dict[str, tuple[float, float]] = {}      # mint -> (ts, latest value): the market the bar is a percentile of
        self.cache: dict[str, tuple[int, float, dict[str, float], float]] = {}   # mint -> (id(result), copy_n, features, value)
        self.shadow: dict[str, dict[str, Any]] = {}
        self.sampled: set[str] = set()
        self.copy_buys: dict[str, dict[str, Any]] = {}         # mint -> {wallets: {w: (rank, ts)}, ...}
        self.threshold = 50.0
        self.last_publish = self.last_skip_note = self.last_equity = self.last_buy_ts = 0.0
        self.real_balance: tuple[float, float] = (0.0, 0.0)  # (ts, SOL)
        self.diag: dict[str, Any] = {}
        self.rng = random.Random()

    # ---------------- state ----------------
    async def load(self) -> None:
        s = await self.ap.cfg.kv_get("brain:state") or {}
        self.w = {k: float((s.get("w") or {}).get(k, v)) for k, v in PRIORS.items()}
        self.b = float(s.get("b", BIAS0))
        self.trained = int(s.get("trained", 0))
        self.shadow_trained = int(s.get("shadow_trained", 0))
        self.shadow_hits = int(s.get("shadow_hits", 0))
        self.aggression = s.get("aggression") if s.get("aggression") in AGGRESSION else "hyper"
        if int(s.get("version", 0)) < 3:
            self.aggression = "hyper"                   # v3: high risk appetite on demo money by default
            self.w.update({k: v for k, v in PRIORS.items() if k not in (s.get("w") or {})})

    async def save(self) -> None:
        await self.ap.cfg.kv_set("brain:state", {"w": self.w, "b": self.b, "trained": self.trained, "shadow_trained": self.shadow_trained,
                                                 "shadow_hits": self.shadow_hits, "aggression": self.aggression, "version": 3})

    async def set_aggression(self, level: str) -> None:
        if level in AGGRESSION:
            self.aggression = level
            await self.save()
            await self.note("mode", f"🎚 Aggression → {level}: buys the top {AGGRESSION[level]['top'] * 100:.0f}% of what it sees, "
                                    f"up to {AGGRESSION[level]['max_open']} positions, stop −{AGGRESSION[level]['stop'] * 100:.0f}%.")

    async def reset(self) -> None:
        self.w, self.b, self.trained, self.shadow_trained, self.shadow_hits = dict(PRIORS), BIAS0, 0, 0, 0
        self.log.clear()
        self.shadow.clear()
        self.sampled.clear()
        self.cache.clear()
        await self.save()
        await self.ap.reset_demo("auto")
        await self.ap.db.exec("DELETE FROM auto_equity WHERE mode='auto'")
        await self.note("reset", "🧠 Fresh start: weights back to their priors, 10 SOL of demo money.")

    def z(self, f: dict[str, float]) -> float:
        return self.b + sum(self.w[k] * f.get(k, 0.0) for k in self.w)

    def value(self, f: dict[str, float]) -> float:
        return round(100 * _sig(self.z(f)), 1)

    def why(self, f: dict[str, float], n: int = 3) -> str:
        contrib = sorted(((self.w[k] * f.get(k, 0.0), k) for k in self.w), reverse=True)
        pos = [LABELS[k].lower() for c, k in contrib[:n] if c > 0.15]
        neg = [LABELS[k].lower() for c, k in contrib[::-1][:2] if c < -0.15]
        return ("+ " + ", ".join(pos) if pos else "") + (" · − " + ", ".join(neg) if neg else "")

    async def note(self, kind: str, text: str, **extra: Any) -> None:
        from .hub import hub
        ev = {"ts": time.time(), "kind": kind, "text": text, **extra}
        self.log.appendleft(ev)
        await hub.publish("brain", {"event": ev})

    # ---------------- copy-trading input (every trade by a ranked / smart / followed wallet) ----------------
    def wallet_rank(self, w: str) -> int | None:
        tr, sm = self.ap.traders, self.ap.smart
        r = tr.ranked.get(w) if tr else None
        if r and r.get("rank"):
            return int(r["rank"])
        if (tr and w in tr.followed) or (sm and w in getattr(sm, "tracked", {})):
            return 50
        return None

    async def on_trade(self, t: dict[str, Any]) -> None:
        w, mint, side = t.get("trader"), t.get("mint"), t.get("side")
        if not w or not mint or side not in ("buy", "sell"):
            return
        rank = self.wallet_rank(w)
        if rank is None:
            return
        now = time.time()
        if side == "buy":
            e = self.copy_buys.setdefault(mint, {"wallets": {}, "first": now})
            e["wallets"][w] = (rank, now)
            self.ap.kick.set()
            if len(self.copy_buys) > 3000:
                cut = now - 3600
                self.copy_buys = {m: v for m, v in self.copy_buys.items() if v["first"] > cut}
        else:  # mirror sells: a leader of one of our positions is getting out
            for p in list(self.ap.open.values()):
                if p["mint"] == mint and w in (p.get("leaders") or []) and p["mint"] not in self.ap.busy:
                    p["leaders"] = [x for x in p["leaders"] if x != w]
                    frac = 1.0 if not p["leaders"] else 0.5
                    await self.ap.sell(p, frac, f"leader {w[:4]}… sold")
                    await self.note("sell", f"🪞 Mirrored a sell: #{rank} wallet left ${p['symbol']} → sold {frac * 100:.0f}%", mint=mint)

    def copy_signal(self, mint: str) -> tuple[float, list[str], str]:
        e = self.copy_buys.get(mint)
        if not e:
            return 0.0, [], ""
        cut = time.time() - 600
        live = {w: r for w, (r, ts) in e["wallets"].items() if ts >= cut}
        if not live:
            return 0.0, [], ""
        n = sum(1.5 if r <= 20 else 1.0 if r <= 100 else 0.5 for r in live.values())
        ranks = sorted(live.values())
        return n, list(live), ", ".join(f"#{r}" for r in ranks[:4])

    # ---------------- narrative context (refreshed every 15 s, off the per-coin path) ----------------
    async def refresh_context(self, now: float) -> None:
        if now - self.last_ctx < 15:
            return
        self.last_ctx = now
        db = self.ap.db
        try:
            rows = await db.all("SELECT nt.token_address mint, n.strength, n.stage, n.zscore z, n.bot_share FROM narrative_tokens nt "
                                "JOIN narratives n ON n.id=nt.narrative_id WHERE n.last_seen > ? AND COALESCE(nt.is_likely_fake,0)=0 "
                                "AND nt.match_score >= 0.6", (now - 6 * 3600,))
            narr: dict[str, dict[str, Any]] = {}
            for r in rows:
                if r["mint"] not in narr or (r["strength"] or 0) > (narr[r["mint"]].get("strength") or 0):
                    narr[r["mint"]] = r
            self.narr = narr
            self.x_calls = {r["mint"]: r["n"] for r in await db.all("SELECT mint, COUNT(DISTINCT handle) n FROM x_calls WHERE ts > ? GROUP BY mint",
                                                                   (now - 7200,))}
            self.cache.clear()
        except Exception:  # noqa: BLE001 - tables from optional engines may be empty / missing on a fresh install
            pass

    # ---------------- main step ----------------
    async def tick(self, mode: str = "auto") -> None:
        ap = self.ap
        now = time.time()
        await self.refresh_context(now)
        agg = AGGRESSION[self.aggression]
        launches = ap.sniper.launches
        scored = []
        for L in list(launches.values()):
            r = L.result
            if not r or now - L.created > 1200:
                continue
            cn, leaders, ranks = self.copy_signal(L.mint)
            hit = self.cache.get(L.mint)
            if hit and hit[0] == id(r) and hit[1] == cn:          # unchanged since the last tick: reuse (0.5 s ticks stay cheap)
                f, v = hit[2], hit[3]
            else:
                f = features({**r, "age_s": now - L.created}, cn, {"narr": self.narr.get(L.mint), "x_calls": self.x_calls.get(L.mint, 0)})
                v = self.value(f)
                self.cache[L.mint] = (id(r), cn, f, v)
            self.vals[L.mint] = (now, v)
            scored.append({"mint": L.mint, "symbol": r.get("symbol"), "value": v, "hard": self.hard_no(r), "why": self.why(f), "f": f,
                           "mcap_usd": r.get("mcap_usd"), "age_s": round(now - L.created), "tier": r.get("tier"), "deployer": L.deployer,
                           "leaders": leaders, "copy_ranks": ranks, "mcap_sol": L.mcap_sol, "r": r})
            if L.mint not in self.sampled and (v >= 20 or self.rng.random() < 0.15) and len(self.shadow) < 1500 and L.mcap_sol:
                self.sampled.add(L.mint)
                self.shadow[L.mint] = {"ts": now, "f": f, "entry": L.mcap_sol, "peak": L.mcap_sol, "low": L.mcap_sol, "v": v}
        await self.shadow_step(now)
        if len(self.vals) > len(launches) + 500:
            self.vals = {m: tv for m, tv in self.vals.items() if tv[0] > now - 1200}
            self.cache = {m: c for m, c in self.cache.items() if m in launches}
        vals = [v for ts, v in self.vals.values() if ts > now - 1200]
        self.threshold = round(max(agg["floor"], percentile(vals, 1 - agg["top"])), 1)
        scored.sort(key=lambda c: -c["value"])
        self.candidates = scored[:14]
        self.diag = {"launches": len(launches), "scored": len(scored), "copy_watch": len(self.copy_buys), "shadow_pending": len(self.shadow)}
        if now - self.last_publish > 2:
            self.last_publish = now
            from .hub import hub
            await hub.publish("brain", {"candidates": self.public_candidates(), "threshold": self.threshold, "diag": self.diag})
        if now - self.last_buy_ts < agg["cooldown"]:
            return
        mine = [p for p in ap.open.values() if p["mode"] == mode]
        max_open = agg["max_open"] if mode == "auto" else min(agg["max_open"], ap.c["size"]["max_open"])
        if len(mine) >= max_open:
            return
        bal = await self.balance(mode)
        if bal < 0.06:
            if now - self.last_skip_note > 600:
                self.last_skip_note = now
                await self.note("skip", "💸 Out of money — reset the brain (demo) or top up the trading wallet (real).")
            return
        if mode == "real" and await ap.can_buy():
            return
        if not scored and not self.copy_buys:
            if now - self.last_skip_note > 120:
                self.last_skip_note = now
                await self.note("skip", f"📡 No live launches reaching Radar right now ({len(launches)} tracked) — check PumpPortal on the Health page.")
            return
        devs = {(launches[p["mint"]].deployer if p["mint"] in launches else None) for p in mine}
        # 1) copy-trades first (they're time-critical), including graduated coins outside the launch feed
        for mint, e in list(self.copy_buys.items()):
            if mint in ap.entered or mint in ap.busy:
                continue
            n, leaders, ranks = self.copy_signal(mint)
            best = min((r for r, _ in e["wallets"].values()), default=999)
            if not (best <= agg["copy_rank"] or n >= 2):
                continue
            L = launches.get(mint)
            if L is not None and L.result and self.hard_no(L.result):
                continue
            if L is None and not await self._tradeable(mint):
                continue
            size = self.size(bal, 0.8, mode, copy=True)
            await self._buy(mint, size, mode, "copy", f"copying {ranks} (top wallets)", L.result if L else None,
                            features({**(L.result or {}), "age_s": now - L.created}, n) if L and L.result else None,
                            None, leaders)
            return
        # 2) the best coin it can see, if it's above its (percentile) bar
        for c in scored:
            if c["mint"] in ap.entered or c["mint"] in ap.busy or c["hard"]:
                continue
            if c["deployer"] and c["deployer"] in devs:
                continue
            explore = False
            if c["value"] < self.threshold:
                if c["value"] >= self.threshold - 6 and self.rng.random() < 0.12:
                    explore = True
                else:
                    if now - self.last_skip_note > 25:
                        self.last_skip_note = now
                        await self.note("skip", f"👀 Best right now: ${c['symbol']} at {c['value']:.0f} — bar is {self.threshold:.0f} "
                                                f"(top {agg['top'] * 100:.0f}% of {len(vals)} recent reads). Waiting.", mint=c["mint"], value=c["value"])
                    break
            conv = max(0.0, min(1.0, (c["value"] - self.threshold) / max(5.0, 100 - self.threshold)))
            size = self.size(bal, 0.3 if explore else conv, mode, explore=explore)
            detail = f"value {c['value']:.0f} (bar {self.threshold:.0f}){' · explore' if explore else ''} · {c['why']}"
            await self._buy(c["mint"], size, mode, "brain", detail, c["r"], c["f"], c["value"], c["leaders"])
            return

    async def _tradeable(self, mint: str) -> bool:
        tok = await self.ap.tracker.token_summary(mint)
        return bool(tok and tok.get("price_usd") and (tok.get("liquidity_usd") or 0) >= 10_000)

    async def _buy(self, mint: str, size: float, mode: str, trig: str, detail: str, r: dict[str, Any] | None,
                   f: dict[str, float] | None, value: float | None, leaders: list[str]) -> None:
        ap = self.ap
        try:
            p = await ap.buy(mint, trig, detail, r, sol=size, mode=mode)
        except Exception as e:  # noqa: BLE001
            ap.entered[mint] = time.time()            # don't retry the same failing coin every tick
            await self.note("error", f"⚠️ Couldn't buy {(r or {}).get('symbol') or mint[:6]}: {e}", mint=mint)
            return
        p["leaders"] = list(leaders or [])
        p["features"], p["score"] = f, value
        await ap.db.exec("UPDATE auto_positions SET features_json=?, score=?, leaders_json=? WHERE id=?",
                         (json.dumps(f) if f else None, value, json.dumps(p["leaders"]), p["id"]))
        self.last_buy_ts = time.time()
        icon = "🪞" if trig == "copy" else "🧪" if "explore" in detail else "🟢"
        await self.note("buy", f"{icon} {'REAL ' if mode == 'real' else ''}Bought ${p['symbol']} for ◎{p['sol_in']:.3f} — {detail}",
                        mint=mint, value=value, sol=p["sol_in"])

    async def balance(self, mode: str) -> float:
        if mode != "real":
            return await self.ap.demo_balance("auto")
        ts, bal = self.real_balance
        if time.time() - ts > 20:
            pub = await self.ap.wallet.pubkey() if self.ap.wallet else None
            try:
                bal = await self.ap.wallet.chain.sol_balance(pub) if pub else 0.0
            except Exception:  # noqa: BLE001
                bal = bal or 0.0
            self.real_balance = (time.time(), bal)
        return bal

    def size(self, bal: float, conviction: float, mode: str, explore: bool = False, copy: bool = False) -> float:
        """Half-Kelly from its real record once it has one; conviction-scaled base size before that."""
        agg = AGGRESSION[self.aggression]
        st = self.stats_cache
        frac = agg["base"]
        if st and st["n"] >= 10 and st["avg_loss"] > 0:
            wr, ratio = st["wr"], st["avg_win"] / st["avg_loss"]
            kelly = wr - (1 - wr) / max(0.1, ratio)
            frac = max(0.01, min(0.08, kelly / 2))
        frac *= (0.5 if explore else 0.6 + 0.9 * conviction) * (1.1 if copy else 1.0)
        s = max(0.02, bal * frac)
        if mode == "real":
            s = min(s, self.ap.c["size"]["buy_sol"], self.ap.c["size"]["max_buy_sol_hard"])
        return round(min(s, bal * 0.25), 4)

    stats_cache: dict[str, Any] | None = None

    async def refresh_stats(self) -> None:
        rows = await self.ap.db.all("SELECT sol_in, sol_out FROM auto_positions WHERE mode='auto' AND status='closed' ORDER BY closed DESC LIMIT 60")
        wins = [r["sol_out"] / r["sol_in"] - 1 for r in rows if r["sol_in"] and r["sol_out"] > r["sol_in"]]
        losses = [1 - r["sol_out"] / r["sol_in"] for r in rows if r["sol_in"] and r["sol_out"] <= r["sol_in"]]
        n = len(wins) + len(losses)
        self.stats_cache = {"n": n, "wr": len(wins) / n if n else 0, "avg_win": sum(wins) / len(wins) if wins else 0,
                            "avg_loss": sum(losses) / len(losses) if losses else 0}

    @staticmethod
    def hard_no(r: dict[str, Any]) -> str | None:
        mx = r.get("metrics") or {}
        if r.get("tier") == "TRAP":
            return "TRAP"
        if r.get("bundled"):
            return "bundled"
        if (mx.get("insider_hold_pct") or 0) >= 15:
            return "insiders"
        if (r.get("mcap_usd") or 0) > 250_000:
            return "too big"
        if (r.get("buyers") or 0) < 5:
            return "too few buyers"
        if mx.get("dev_hold_pct") and mx["dev_hold_pct"] > 25 and not mx.get("dev_sold"):
            return "dev holds too much"
        return None

    # ---------------- shadow learning: every coin it scored is a lesson ----------------
    async def shadow_step(self, now: float) -> None:
        launches = self.ap.sniper.launches
        done = []
        for mint, s in self.shadow.items():
            L = launches.get(mint)
            if L is not None and L.mcap_sol:
                s["peak"] = max(s["peak"], L.mcap_sol)
                s["low"] = min(s["low"], L.mcap_sol)
            if now - s["ts"] >= 1200 or L is None:
                done.append(mint)
        for mint in done:
            s = self.shadow.pop(mint)
            if not s["entry"]:
                continue
            y = 1.0 if s["peak"] / s["entry"] >= 1.8 else 0.0
            self._step(s["f"], y, LR_SHADOW)
            if self.shadow_trained % 25 == 0:
                self.cache.clear()                                       # the weights moved: re-score everything
            self.shadow_trained += 1
            self.shadow_hits += int(y)
        if done:
            if len(self.sampled) > 20000:
                self.sampled = set(self.shadow)
            if self.shadow_trained % 50 < len(done):
                await self.save()

    def _step(self, f: dict[str, float], y: float, lr: float) -> float:
        p = _sig(self.z(f))
        err = y - p
        for k in self.w:
            self.w[k] = max(-6.0, min(6.0, self.w[k] + lr * err * f.get(k, 0.0)))
        self.b = max(-8.0, min(2.0, self.b + lr * err))
        self.brier.append((p - y) ** 2)
        return p

    # ---------------- its own exits ----------------
    def exit_for(self, p: dict[str, Any], r: dict[str, Any] | None, x: float, peak_x: float) -> tuple[float, str] | None:
        agg = AGGRESSION[self.aggression]
        age = time.time() - p["opened"]
        mx = (r or {}).get("metrics") or {}
        if r and (r.get("tier") == "TRAP" or (mx.get("insider_hold_pct") or 0) >= 20):
            return 1.0, "rug exit: " + ", ".join(r.get("flags") or ["insiders"])
        if x <= 1 - agg["stop"]:
            return 1.0, f"stop −{agg['stop'] * 100:.0f}%"
        if x >= 2.5 and 100 not in p["tp_done"]:
            p["tp_done"].append(100)
            return 0.4, "took 40% at 2.5×"
        if peak_x >= 1.8 and x <= 1.05:
            return 1.0, f"break-even stop (was {peak_x:.1f}×)"
        if peak_x >= 1.5:
            trail = 0.35 if peak_x < 2 else 0.25 if peak_x < 5 else 0.18
            if x <= peak_x * (1 - trail):
                return 1.0, f"trailing stop ({peak_x:.1f}× peak, {trail * 100:.0f}% trail)"
        if (mx.get("sells_1m") or 0) >= 6 and (mx.get("sells_1m") or 0) > 2 * (mx.get("buys_1m") or 0) and x < peak_x * 0.85:
            return 1.0, "sellers took over"
        last_high = p.setdefault("_high_ts", p["opened"])
        if x >= peak_x * 0.999:
            p["_high_ts"] = time.time()
        elif time.time() - last_high > 480 and x < 1.3 and age > 480:
            return 1.0, "stalled (no new high in 8 min)"
        if age > 1800 and x < 1.2:
            return 1.0, "30-min time stop"
        return None

    # ---------------- learning from its own trades ----------------
    async def learn(self, p: dict[str, Any]) -> None:
        await self.refresh_stats()
        f = p.get("features")
        if not f:
            row = await self.ap.db.one("SELECT features_json FROM auto_positions WHERE id=?", (p["id"],))
            f = json.loads((row or {}).get("features_json") or "null")
        mult = (p["sol_out"] / p["sol_in"]) if p["sol_in"] else 0
        if not f:
            await self.note("learn", f"{'✅' if mult >= 1 else '❌'} ${p['symbol']} closed at {mult:.2f}× ({p.get('trigger')}).", mint=p["mint"])
            return
        y = 1.0 if mult >= 1.15 else 0.0
        before = dict(self.w)
        pred = self._step(f, y, LR_TRADE)
        self.cache.clear()
        self.trained += 1
        await self.save()
        moved = sorted(((self.w[k] - before[k], k) for k in self.w), key=lambda m: -abs(m[0]))
        lesson = ", ".join(f"{LABELS[k].lower()} {'↑' if d > 0 else '↓'}" for d, k in moved[:3] if abs(d) > 0.005) or "small adjustment"
        await self.note("learn", f"{'✅' if y else '❌'} ${p['symbol']} closed at {mult:.2f}× — I gave it {pred * 100:.0f}% odds. Learned: {lesson}.",
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
        return [{k: c[k] for k in ("mint", "symbol", "value", "hard", "why", "mcap_usd", "age_s", "tier", "copy_ranks")} for c in self.candidates]

    async def snapshot(self) -> dict[str, Any]:
        eq = await self.ap.db.all("SELECT ts, equity FROM auto_equity WHERE mode='auto' ORDER BY ts DESC LIMIT 600")
        copies = []
        now = time.time()
        for mint, e in sorted(self.copy_buys.items(), key=lambda kv: -max(ts for _, ts in kv[1]["wallets"].values()))[:10]:
            L = self.ap.sniper.launches.get(mint)
            copies.append({"mint": mint, "symbol": L.symbol if L else None, "wallets": len(e["wallets"]),
                           "best_rank": min(r for r, _ in e["wallets"].values()),
                           "last": max(ts for _, ts in e["wallets"].values()), "age_s": round(now - e["first"])})
        return {"threshold": self.threshold, "trained": self.trained, "bias": round(self.b, 3), "aggression": self.aggression,
                "levels": AGGRESSION, "shadow": {"trained": self.shadow_trained, "hit_rate": round(self.shadow_hits / self.shadow_trained * 100, 1)
                                                 if self.shadow_trained else None, "pending": len(self.shadow),
                                                 "brier": round(sum(self.brier) / len(self.brier), 3) if self.brier else None},
                "weights": [{"key": k, "label": LABELS[k], "w": round(v, 3), "prior": PRIORS[k]} for k, v in
                            sorted(self.w.items(), key=lambda kv: -abs(kv[1]))],
                "candidates": self.public_candidates(), "log": list(self.log)[:150], "equity": eq[::-1], "copies": copies,
                "diag": self.diag, "sizing": self.stats_cache,
                "balance": await self.ap.demo_balance("auto"), "summary": await self.ap.summary("auto")}
