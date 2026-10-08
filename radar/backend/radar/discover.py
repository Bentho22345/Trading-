"""Discovery read-models: steady climbers (Trending), explosive launches (Launching), emerging narratives that could
become coins, market-cap sparklines, universal search, and Launch Watch (alert when a coin for a narrative launches)."""
from __future__ import annotations

import json
import math
import re
import time
from typing import Any

from .hub import hub
from .tracker import TOKEN_SUMMARY_SQL


def _downsample(xs: list[float], n: int = 32) -> list[float]:
    if len(xs) <= n:
        return xs
    step = len(xs) / n
    return [xs[int(i * step)] for i in range(n - 1)] + [xs[-1]]


def regress(points: list[tuple[float, float]]) -> tuple[float, float]:
    """Least squares on (t_hours, ln(mcap)). Returns (slope % per hour, r²)."""
    n = len(points)
    if n < 3:
        return 0.0, 0.0
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return 0.0, 0.0
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx
    ss_tot = sum((y - my) ** 2 for y in ys)
    ss_res = sum((y - (my + b * (x - mx))) ** 2 for x, y in zip(xs, ys))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
    return (math.exp(b) - 1) * 100, max(0.0, r2)


def max_drawdown(xs: list[float]) -> float:
    peak, dd = xs[0], 0.0
    for x in xs:
        peak = max(peak, x)
        dd = min(dd, x / peak - 1)
    return dd * 100


class Discover:
    def __init__(self, db: Any, tracker: Any, social: Any, signals: Any, alerts: Any) -> None:
        self.db, self.tracker, self.social, self.signals, self.alerts = db, tracker, social, signals, alerts

    async def _series(self, addrs: list[str], since: float) -> dict[str, list[tuple[float, float, float, float]]]:
        """address -> [(ts, mcap, liquidity, price)] from Radar's own ticks."""
        out: dict[str, list] = {a: [] for a in addrs}
        if not addrs:
            return out
        for i in range(0, len(addrs), 400):
            chunk = addrs[i:i + 400]
            rows = await self.db.all(f"SELECT token_address a, ts, market_cap m, liquidity_usd l, price_usd p FROM price_ticks "
                                     f"WHERE ts > ? AND token_address IN ({','.join('?' * len(chunk))}) ORDER BY ts", [since, *chunk])
            for r in rows:
                out[r["a"]].append((r["ts"], r["m"], r["l"], r["p"]))
        return out

    async def sparks(self, addrs: list[str], hours: float = 2) -> dict[str, list[float]]:
        ser = await self._series(addrs[:300], time.time() - hours * 3600)
        return {a: _downsample([m or p or 0 for _, m, _, p in s]) for a, s in ser.items() if s}

    async def _narr(self, addrs: list[str]) -> dict[str, list[dict[str, Any]]]:
        out: dict[str, list] = {a: [] for a in addrs}
        if not addrs:
            return out
        rows = await self.db.all(
            "SELECT nt.token_address a, n.id, n.title, n.category, n.stage, n.strength, n.vel_5m, n.sources_json, nt.match_score, "
            f"nt.is_likely_fake FROM narrative_tokens nt JOIN narratives n ON n.id=nt.narrative_id WHERE nt.token_address IN "
            f"({','.join('?' * len(addrs))}) AND n.last_seen > ? ORDER BY nt.match_score * COALESCE(n.strength,0) DESC",
            [*addrs, time.time() - 48 * 3600])
        for r in rows:
            out[r["a"]].append({"id": r["id"], "title": r["title"], "category": r["category"], "stage": r["stage"],
                                "strength": r["strength"], "vel_5m": r["vel_5m"], "sources": json.loads(r["sources_json"] or "[]"),
                                "match": r["match_score"], "fake": bool(r["is_likely_fake"])})
        stories = {r["token_address"]: r for r in await self.db.all(
            f"SELECT token_address, ts, story_json, method FROM token_stories WHERE token_address IN ({','.join('?' * len(addrs))})", addrs)}
        for a in addrs:
            st = stories.get(a)
            if st:
                s = json.loads(st["story_json"] or "{}")
                for n in s.get("narratives") or []:
                    out[a].append({"title": n.get("title"), "category": n.get("category"), "stage": None, "from_story": True,
                                   "explanation": n.get("explanation"), "strength": n.get("strength"), "sources": n.get("sources") or []})
        return out

    # ---------------- Trending: steady climbers ----------------
    async def climbers(self, hours: float = 4, limit: int = 60, min_liq: float = 5000) -> list[dict[str, Any]]:
        now = time.time()
        toks = await self.db.all(TOKEN_SUMMARY_SQL + " WHERE t.best_pair IS NOT NULL AND p.as_of > ? AND COALESCE(p.liquidity_usd,0) >= ?",
                                 (now - 900, min_liq))
        by = {t["address"]: t for t in toks}
        ser = await self._series(list(by), now - hours * 3600)
        out = []
        for a, t in by.items():
            s = [(ts, m) for ts, m, _, p in ser.get(a, []) if m and m > 0]
            method = "ticks"
            if len(s) >= 8 and s[-1][0] - s[0][0] >= 1800:
                pts = [((ts - s[0][0]) / 3600, math.log(m)) for ts, m in s]
                slope, r2 = regress(pts)
                dd = max_drawdown([m for _, m in s])
                gain = (s[-1][1] / s[0][1] - 1) * 100
                span_h = (s[-1][0] - s[0][0]) / 3600
            else:
                # not enough of our own history yet: use DexScreener's windows (all up, accelerating gently)
                c1, c6, c24 = t.get("chg_h1"), t.get("chg_h6"), t.get("chg_h24")
                if None in (c1, c6, c24):
                    continue
                method = "windows"
                slope = c6 / 6
                r2 = 0.75 if 0 < c1 <= c6 <= c24 else 0.3
                dd, gain, span_h = -abs(min(0.0, t.get("chg_m5") or 0)), c6, 6
            if not (1.5 <= slope <= 80 and r2 >= 0.55 and dd >= -30 and gain > 3):
                continue
            if (t.get("chg_m5") or 0) > 40:   # vertical spike, not a slow climb
                continue
            score = round(min(100, slope * 1.2) * r2 * (1 + dd / 100) + min(20, math.log10(max(1, t.get("vol_h24") or 1)) * 3), 1)
            out.append({**t, "climb": {"slope_pct_h": round(slope, 1), "r2": round(r2, 2), "drawdown_pct": round(dd, 1),
                                       "gain_pct": round(gain, 1), "span_h": round(span_h, 1), "score": score, "method": method},
                        "spark": _downsample([m for _, m in s]) if s else []})
        out.sort(key=lambda r: -r["climb"]["score"])
        out = out[:limit]
        nar = await self._narr([r["address"] for r in out])
        for r in out:
            r["narratives"] = nar.get(r["address"], [])
        return out

    # ---------------- Launching: explosive new coins ----------------
    async def launching(self, max_age_h: float = 24, limit: int = 60) -> list[dict[str, Any]]:
        now = time.time()
        toks = await self.db.all(TOKEN_SUMMARY_SQL + " WHERE t.best_pair IS NOT NULL AND p.as_of > ? AND "
                                 "COALESCE(t.launched_at, p.pair_created_at, t.first_seen) > ?", (now - 600, now - max_age_h * 3600))
        by = {t["address"]: t for t in toks}
        ser = await self._series(list(by), now - 1800)
        out = []
        for a, t in by.items():
            v5, v1, v6 = t.get("vol_m5") or 0, t.get("vol_h1") or 0, t.get("vol_h6") or 0
            vol_accel = (v5 * 12) / max(v1, 1)        # 5-minute pace vs the last hour
            hr_accel = (v1 * 6) / max(v6, 1)          # last hour vs the last 6
            s = ser.get(a, [])
            def growth(idx: int, mins: float) -> float | None:
                pts = [x for x in s if x[idx] and x[0] >= now - mins * 60]
                return (pts[-1][idx] / pts[0][idx] - 1) * 100 if len(pts) >= 2 and pts[0][idx] else None
            mc15, liq15 = growth(1, 15), growth(2, 15)
            mc_chg = mc15 if mc15 is not None else (t.get("chg_h1") or 0)
            liq_chg = liq15 if liq15 is not None else 0
            if v5 < 2000 and v1 < 15000:
                continue
            exploding = (vol_accel >= 1.5 or hr_accel >= 2) and mc_chg >= 15 and (t.get("chg_m5") or 0) >= 0
            if not exploding:
                continue
            score = round(min(35, vol_accel * 8) + min(30, mc_chg / 4) + min(20, max(0, liq_chg) / 2) + min(15, math.log10(max(v1, 1)) * 2.5), 1)
            out.append({**t, "explosion": {"vol_accel": round(vol_accel, 2), "hour_accel": round(hr_accel, 2),
                                           "mcap_chg_15m": round(mc_chg, 1), "liq_chg_15m": round(liq_chg, 1),
                                           "score": score, "basis": "ticks" if mc15 is not None else "windows"},
                        "spark": _downsample([m or 0 for _, m, _, _ in s])})
        # pre-DEX pump.fun bonding-curve rockets (from the live trade stream)
        for r in await self.db.all(
                "SELECT mint, MIN(mcap_sol) lo, MAX(mcap_sol) hi, COUNT(*) n, COUNT(DISTINCT trader) w, SUM(CASE WHEN side='buy' THEN sol ELSE 0 END) b "
                "FROM pump_trades WHERE ts > ? GROUP BY mint HAVING n >= 15", (now - 600,)):
            if r["mint"] in by or not r["lo"]:
                continue
            mult = r["hi"] / r["lo"]
            if mult < 1.5:
                continue
            t = await self.tracker.token_summary(r["mint"]) or {"address": r["mint"]}
            usd = self.tracker.sol_usd
            out.append({**t, "explosion": {"curve_mult_10m": round(mult, 2), "trades_10m": r["n"], "wallets_10m": r["w"],
                                           "buy_sol_10m": round(r["b"] or 0, 2), "basis": "bonding_curve",
                                           "mcap_usd": round(r["hi"] * usd, 0) if usd else None,
                                           "score": round(min(60, (mult - 1) * 30) + min(40, r["w"] / 2), 1)},
                        "spark": []})
        out.sort(key=lambda r: -r["explosion"]["score"])
        out = out[:limit]
        addrs = [r["address"] for r in out]
        nar = await self._narr(addrs)
        for r in out:
            r["narratives"] = nar.get(r["address"], [])
            r["flow"] = await self.signals.flow(r["address"], r)
        return out

    # ---------------- Dashboard: narratives that could become coins ----------------
    async def emerging(self, limit: int = 30) -> dict[str, Any]:
        now = time.time()
        rows = await self.db.all("SELECT * FROM narratives WHERE last_seen > ? AND stage IN ('birth','ignition','peak') ORDER BY strength DESC LIMIT 200",
                                 (now - 6 * 3600,))
        out = []
        for n in rows:
            flags = json.loads(n["flags_json"] or "{}")
            toks = await self.db.all("SELECT nt.token_address, nt.legit_score, nt.is_likely_fake, t.symbol, p.chg_h1, p.vol_h1 FROM narrative_tokens nt "
                                     "LEFT JOIN tokens t ON t.address=nt.token_address LEFT JOIN pairs p ON p.pair_address=t.best_pair "
                                     "WHERE nt.narrative_id=? ORDER BY nt.legit_score DESC LIMIT 4", (n["id"],))
            vip = bool(flags.get("vip_mention"))
            potential = (n["strength"] or 0) * (1.35 if vip else 1) * (1.25 if not toks else 1) * \
                {"ignition": 1.3, "birth": 1.1, "peak": 0.9}.get(n["stage"], 1) * (1.15 if flags.get("breaking_news") else 1)
            posts = await self.db.all("SELECT source, author_id, author_tier, text, url, ts FROM social_events WHERE narrative_id=? ORDER BY "
                                      "CASE author_tier WHEN 'vip' THEN 0 WHEN 'news' THEN 1 ELSE 2 END, engagement DESC, ts DESC LIMIT 3", (n["id"],))
            out.append({"id": n["id"], "title": n["title"], "category": n["category"], "stage": n["stage"],
                        "first_seen": n["first_seen"], "last_seen": n["last_seen"], "posts": n["posts"], "authors": n["authors"],
                        "vel_5m": n["vel_5m"], "zscore": n["zscore"], "strength": n["strength"], "bot_share": n["bot_share"],
                        "sources": json.loads(n["sources_json"] or "[]"), "tickers": json.loads(n["tickers_json"] or "[]")[:6],
                        "flags": {k: v for k, v in flags.items() if k in ("vip_mention", "breaking_news", "exchange_listing")},
                        "flash": bool(n["flash_until"] and n["flash_until"] > now), "coins": toks, "has_coin": bool(toks),
                        "potential": round(min(100, potential), 1), "top_posts": posts,
                        "spark": await self.social.sparkline(n["id"], 30)})
        out.sort(key=lambda r: -r["potential"])
        web = await self.db.all("SELECT source, author_id, text, url, ts, author_tier, ai_json FROM social_events WHERE source IN "
                                "('google_trends','rss','polymarket','youtube') AND ts > ? ORDER BY ts DESC LIMIT 60", (now - 6 * 3600,))
        pulse = []
        for w in web:
            ai = json.loads(w.pop("ai_json") or "null") or {}
            if ai.get("tokenizable") or w["source"] in ("google_trends", "polymarket"):
                w["category"] = ai.get("category")
                w["tickers"] = (ai.get("ticker_candidates") or [])[:4]
                pulse.append(w)
        rate = await self.db.one("SELECT COUNT(*) n FROM social_events WHERE ts > ?", (now - 60,))
        return {"as_of": now, "narratives": out[:limit], "web": pulse[:25], "posts_per_min": rate["n"]}

    # ---------------- ⌘K search ----------------
    async def search(self, q: str) -> dict[str, Any]:
        q = q.strip().lstrip("$")
        if not q:
            return {"tokens": [], "narratives": []}
        like = f"%{q}%"
        toks = await self.db.all(TOKEN_SUMMARY_SQL + " WHERE t.address = ? OR t.symbol LIKE ? OR t.name LIKE ? "
                                 "ORDER BY (upper(t.symbol)=upper(?)) DESC, p.vol_h24 DESC NULLS LAST LIMIT 12", (q, like, like, q))
        if len(toks) < 5 and len(q) >= 2:
            try:
                for pr in (await self.tracker.dex.search(q))[:10]:
                    b = pr.get("baseToken") or {}
                    if b.get("address") and all(t["address"] != b["address"] for t in toks):
                        toks.append({"address": b["address"], "symbol": b.get("symbol"), "name": b.get("name"), "chain": pr.get("chainId"),
                                     "price_usd": float(pr["priceUsd"]) if pr.get("priceUsd") else None,
                                     "liquidity_usd": (pr.get("liquidity") or {}).get("usd"), "vol_h24": (pr.get("volume") or {}).get("h24"),
                                     "image": (pr.get("info") or {}).get("imageUrl"), "remote": True})
            except Exception:  # noqa: BLE001 - search fallback is best-effort
                pass
        nars = await self.db.all("SELECT id, title, category, stage, strength FROM narratives WHERE (title LIKE ? OR keywords_json LIKE ? "
                                 "OR tickers_json LIKE ?) AND last_seen > ? ORDER BY strength DESC LIMIT 8",
                                 (like, like, f'%{q.upper()}%', time.time() - 48 * 3600))
        return {"tokens": toks[:15], "narratives": nars}

    # ---------------- Launch Watch ----------------
    async def watches(self) -> list[dict[str, Any]]:
        rows = await self.db.all("SELECT * FROM launch_watches ORDER BY enabled DESC, created DESC")
        for r in rows:
            r["terms"] = json.loads(r.pop("terms_json"))
        return rows

    async def add_watch(self, terms: list[str], label: str | None, narrative_id: int | None) -> int:
        terms = [re.sub(r"[^A-Za-z0-9 ]", "", t).strip().lower() for t in terms]
        terms = [t for t in dict.fromkeys(terms) if len(t) >= 2][:12]
        if not terms:
            raise ValueError("Give at least one ticker or keyword (2+ characters)")
        return await self.db.exec("INSERT INTO launch_watches (terms_json, label, narrative_id, created) VALUES (?,?,?,?)",
                                  (json.dumps(terms), label or " / ".join(terms[:3]), narrative_id, time.time()))

    async def check_launch(self, token: dict[str, Any]) -> None:
        """Called for every new token (pump.fun create, DexScreener discovery). Alerts on Launch Watch matches."""
        sym = re.sub(r"[^a-z0-9]", "", (token.get("symbol") or "").lower())
        name = (token.get("name") or "").lower()
        if not sym and not name:
            return
        for w in await self.db.all("SELECT * FROM launch_watches WHERE enabled=1"):
            for term in json.loads(w["terms_json"]):
                compact = term.replace(" ", "")
                if sym == compact or (len(term) >= 4 and (term in name or compact in sym)):
                    now = time.time()
                    await self.db.exec("UPDATE launch_watches SET hits=hits+1, last_hit=?, last_hit_token=? WHERE id=?",
                                       (now, token.get("address"), w["id"]))
                    await self.alerts.send("flash", f"🚀 Launch Watch: {token.get('symbol')} just launched ({w['label']})",
                                           f"{token.get('name') or ''} matched '{term}'. Check safety before buying — copycats launch in bursts.",
                                           token=token.get("address"), dedupe=f"lw:{w['id']}:{token.get('address')}", ttl=86400)
                    await hub.publish("launch_watch_hit", {"watch_id": w["id"], "label": w["label"], "term": term,
                                                           "token": {k: token.get(k) for k in ("address", "symbol", "name")}})
                    break
