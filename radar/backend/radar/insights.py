"""Narrative rotation heatmap, AI daily brief (scheduled + on demand) and Ask Radar (Claude + tools over the DB)."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from .hub import hub
from .social.text import category

log = logging.getLogger("radar.insights")

BRIEF_SYSTEM = """You write a concise trading brief for a memecoin trader. Use ONLY the JSON data provided; never invent
tokens, numbers or events, and say "no data" where a section is empty. Markdown with these sections:
## Take (2-3 sentences) ## Top narratives ## Best & worst signals (24h, with paper outcomes) ## Rotation
## Upcoming catalysts ## What to watch. End with: "Signals are probabilistic. Most memecoins go to zero." """

ASK_SYSTEM = """You are Ask Radar, answering questions about the memecoin market using ONLY the app's own data via the tools.
Call tools to get facts; cite token symbols, numbers and timestamps from tool results. If the data doesn't answer the
question, say so plainly. Never give certainty about future prices. Keep answers short and concrete."""


class Insights:
    def __init__(self, db: Any, cfg: Any, ai: Any, alerts: Any, social: Any, paper: Any, tracker: Any) -> None:
        self.db, self.cfg, self.ai, self.alerts, self.social, self.paper, self.tracker = db, cfg, ai, alerts, social, paper, tracker

    async def rotation(self) -> dict[str, Any]:
        cats = self.cfg.watch.get("category_keywords") or {}
        now = time.time()
        rows = await self.db.all(
            "SELECT t.address, t.name, t.symbol, p.vol_h1, p.vol_h6, p.vol_h24, p.chg_h1, p.chg_h24, p.market_cap, "
            "(SELECT n.category FROM narrative_tokens nt JOIN narratives n ON n.id=nt.narrative_id WHERE nt.token_address=t.address "
            " ORDER BY nt.match_score DESC LIMIT 1) ncat "
            "FROM tokens t JOIN pairs p ON p.pair_address=t.best_pair WHERE p.as_of > ?", (now - 1800,))
        agg: dict[str, dict[str, Any]] = {}
        for r in rows:
            c = r["ncat"] or category(f"{r['name'] or ''} {r['symbol'] or ''}", cats)
            a = agg.setdefault(c, {"category": c, "tokens": 0, "vol_h1": 0.0, "vol_h6": 0.0, "vol_h24": 0.0, "mcap": 0.0,
                                   "chg_h1": [], "chg_h24": [], "top": []})
            a["tokens"] += 1
            for k in ("vol_h1", "vol_h6", "vol_h24"):
                a[k] += r[k] or 0
            a["mcap"] += r["market_cap"] or 0
            if r["chg_h1"] is not None:
                a["chg_h1"].append(r["chg_h1"])
            if r["chg_h24"] is not None:
                a["chg_h24"].append(r["chg_h24"])
            a["top"].append((r["vol_h1"] or 0, r["symbol"], r["address"]))
        social = {}
        for win, secs in (("h1", 3600), ("h6", 21600), ("h24", 86400)):
            for r in await self.db.all("SELECT n.category c, COUNT(*) n FROM social_events e JOIN narratives n ON n.id=e.narrative_id "
                                       "WHERE e.ts > ? GROUP BY n.category", (now - secs,)):
                social.setdefault(r["c"] or "other", {})[win] = r["n"]
        out = []
        tot = {k: sum(a[k] for a in agg.values()) or 1 for k in ("vol_h1", "vol_h6", "vol_h24")}
        for c, a in agg.items():
            a["share_h1"] = round(a["vol_h1"] / tot["vol_h1"] * 100, 1)
            a["share_h6"] = round(a["vol_h6"] / tot["vol_h6"] * 100, 1)
            a["share_h24"] = round(a["vol_h24"] / tot["vol_h24"] * 100, 1)
            a["rotation"] = round(a["share_h1"] - a["share_h24"], 1)   # >0 = capital rotating in
            a["avg_chg_h1"] = round(sum(a["chg_h1"]) / len(a["chg_h1"]), 1) if a["chg_h1"] else None
            a["avg_chg_h24"] = round(sum(a["chg_h24"]) / len(a["chg_h24"]), 1) if a["chg_h24"] else None
            a["mentions"] = social.get(c, {})
            a["top"] = [{"symbol": s, "address": ad, "vol_h1": v} for v, s, ad in sorted(a["top"], reverse=True)[:3]]
            del a["chg_h1"], a["chg_h24"]
            out.append(a)
        out.sort(key=lambda a: -a["vol_h1"])
        return {"as_of": now, "categories": out, "note": "Volume windows are DexScreener's 1h / 6h / 24h; mentions are Radar's social events."}

    async def brief_context(self) -> dict[str, Any]:
        now = time.time()
        sig = await self.db.all("SELECT s.symbol, s.verdict, s.score, s.category, pt.return_pct, pt.exit_reason, s.ts FROM signals s "
                                "LEFT JOIN paper_trades pt ON pt.signal_id=s.id WHERE s.ts > ? AND s.verdict IN ('BUY','WATCH') "
                                "AND pt.return_pct IS NOT NULL ORDER BY pt.return_pct DESC", (now - 86400,))
        markets = {r["key"]: {**json.loads(r["data_json"] or "{}"), "value": r["value"]} for r in await self.db.all("SELECT * FROM market")}
        cal = await self.db.all("SELECT data_json FROM trending WHERE source='ff_calendar' ORDER BY rank LIMIT 30")
        poly = await self.db.all("SELECT data_json FROM trending WHERE source='polymarket' ORDER BY rank LIMIT 10")
        return {
            "generated": datetime.now(ZoneInfo(self.cfg.risk.get("timezone", "UTC"))).isoformat(timespec="minutes"),
            "market": {k: markets.get(k) for k in ("px_BTC", "px_SOL", "px_ETH", "fear_greed", "sol_dex_volume", "meme_category")},
            "narratives": [{k: n.get(k) for k in ("title", "category", "stage", "vel_5m", "posts", "sources", "strength")}
                           for n in (await self.social.board(limit=10))],
            "best_signals": sig[:5], "worst_signals": sig[-5:][::-1] if len(sig) > 5 else [],
            "scorecard_24h": (await self.paper.scorecard(hours=24))["by_verdict"],
            "rotation": [{k: c.get(k) for k in ("category", "share_h1", "share_h24", "rotation", "avg_chg_h1")}
                         for c in (await self.rotation())["categories"][:8]],
            "macro_calendar": [json.loads(r["data_json"]) for r in cal],
            "prediction_markets": [json.loads(r["data_json"]) for r in poly],
            "unavailable": ["token unlock schedules (no free source)", "scheduled launches (no free source)"],
        }

    def template_brief(self, c: dict[str, Any]) -> str:
        m = c["market"]
        def px(k: str) -> str:
            v = m.get(k) or {}
            return f"{k[3:]} ${v.get('value'):,.2f} ({v.get('chg_24h'):+.1f}%)" if v.get("value") and v.get("chg_24h") is not None else f"{k[3:]} no data"
        lines = [f"# Radar brief · {c['generated']}", "", "## Market", ", ".join(px(k) for k in ("px_BTC", "px_SOL", "px_ETH")),
                 f"Fear & Greed: {(m.get('fear_greed') or {}).get('value', 'no data')}", "", "## Top narratives"]
        lines += [f"- **{n['title']}** ({n['category']}, {n['stage']}) · {n['vel_5m']}/min · {', '.join(n['sources'] or [])}"
                  for n in c["narratives"]] or ["- no data"]
        lines += ["", "## Best signals (24h, paper)"] + [f"- {s['symbol']} {s['verdict']} {s['score']} → {s['return_pct']:+.1f}%"
                                                         for s in c["best_signals"]] or ["- no data"]
        lines += ["", "## Worst signals"] + ([f"- {s['symbol']} {s['verdict']} {s['score']} → {s['return_pct']:+.1f}%"
                                              for s in c["worst_signals"]] or ["- no data"])
        lines += ["", "## Rotation (share of 1h vs 24h volume)"] + [f"- {r['category']}: {r['share_h1']}% now vs {r['share_h24']}% 24h ({r['rotation']:+.1f})"
                                                                     for r in c["rotation"]]
        lines += ["", "## Upcoming catalysts"] + ([f"- {e['date']} {e['country']} {e['title']} ({e['impact']})" for e in c["macro_calendar"][:10]]
                                                  or ["- no data"])
        lines += ["", "_Template brief (connect Anthropic for the AI-written version)._",
                  "", "Signals are probabilistic. Most memecoins go to zero."]
        return "\n".join(lines)

    async def brief(self, kind: str = "on_demand", deliver: bool = False) -> dict[str, Any]:
        ctx = await self.brief_context()
        model = "template"
        body = self.template_brief(ctx)
        if self.ai.enabled:
            try:
                from .ai import SMART_MODEL
                body = await self.ai.write(BRIEF_SYSTEM, json.dumps(ctx, default=str), "brief", max_tokens=3000, effort="medium")
                model = SMART_MODEL
            except Exception as e:  # noqa: BLE001
                log.warning("AI brief failed, using template: %s", e)
        bid = await self.db.exec("INSERT INTO briefs (ts, kind, body, model, context_json) VALUES (?,?,?,?,?)",
                                 (time.time(), kind, body, model, json.dumps(ctx, default=str)))
        out = {"id": bid, "ts": time.time(), "kind": kind, "body": body, "model": model}
        await hub.publish("brief", out)
        if deliver:
            await self.alerts.send("info", f"📰 Radar {kind} brief", body[:3500], dedupe=f"brief:{bid}")
        return out

    async def brief_scheduler(self) -> None:
        fired: set[str] = set()
        while True:
            try:
                tz = ZoneInfo(self.cfg.risk.get("timezone", "UTC"))
                now = datetime.now(tz)
                for hhmm in self.cfg.risk.get("brief_times") or []:
                    key = f"{now.date()} {hhmm}"
                    if now.strftime("%H:%M") == hhmm and key not in fired:
                        fired.add(key)
                        await self.brief("morning" if now.hour < 12 else "evening", deliver=True)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("brief scheduler: %s", e)
            await asyncio.sleep(20)

    # ---------------- Ask Radar ----------------
    TOOLS = [
        {"name": "top_tokens", "description": "Hot tokens with live market data. sort: vol_h1|vol_h24|chg_h1|chg_h24|liquidity_usd|market_cap",
         "input_schema": {"type": "object", "properties": {"sort": {"type": "string"}, "limit": {"type": "integer"}}, "required": []}},
        {"name": "find_token", "description": "Find tokens by symbol or name (case-insensitive substring).",
         "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
        {"name": "token_detail", "description": "Full detail for one token address: market data, safety, latest signal, linked narrative, recent price ticks.",
         "input_schema": {"type": "object", "properties": {"address": {"type": "string"}}, "required": ["address"]}},
        {"name": "narratives", "description": "Active narratives ranked by lifecycle and strength, optionally filtered by category.",
         "input_schema": {"type": "object", "properties": {"category": {"type": "string"}, "limit": {"type": "integer"}}, "required": []}},
        {"name": "signals", "description": "Recent BUY/WATCH/AVOID signals with scores and paper outcomes.",
         "input_schema": {"type": "object", "properties": {"hours": {"type": "number"}, "verdict": {"type": "string"}}, "required": []}},
        {"name": "social_search", "description": "Search ingested social posts/news by text.",
         "input_schema": {"type": "object", "properties": {"query": {"type": "string"}, "hours": {"type": "number"}}, "required": ["query"]}},
        {"name": "scorecard", "description": "Paper-trading scorecard (hit rate, expectancy, drawdown) by verdict/category/score bucket.",
         "input_schema": {"type": "object", "properties": {"hours": {"type": "number"}}, "required": []}},
        {"name": "market", "description": "Market regime: BTC/ETH/SOL, Fear & Greed, Solana DEX volume, meme sector, rotation.",
         "input_schema": {"type": "object", "properties": {}, "required": []}},
    ]

    async def run_tool(self, name: str, a: dict[str, Any]) -> Any:
        from .tracker import TOKEN_SUMMARY_SQL
        lim = min(int(a.get("limit") or 15), 50)
        if name == "top_tokens":
            col = a.get("sort") if a.get("sort") in ("vol_h1", "vol_h24", "chg_h1", "chg_h24", "liquidity_usd", "market_cap") else "vol_h1"
            return await self.db.all(TOKEN_SUMMARY_SQL + f" WHERE t.best_pair IS NOT NULL AND p.as_of > ? ORDER BY p.{col} DESC LIMIT ?",
                                     (time.time() - 1800, lim))
        if name == "find_token":
            q = f"%{a['query'].lstrip('$')}%"
            return await self.db.all(TOKEN_SUMMARY_SQL + " WHERE t.symbol LIKE ? OR t.name LIKE ? ORDER BY p.vol_h24 DESC LIMIT 10", (q, q))
        if name == "token_detail":
            addr = a["address"]
            sig = await self.db.one("SELECT ts, verdict, score, confidence, risk_grade, subscores_json, reasons_json, vetoes_json FROM signals "
                                    "WHERE token_address=? ORDER BY ts DESC LIMIT 1", (addr,))
            return {"token": await self.tracker.token_summary(addr), "latest_signal": sig,
                    "narrative": await self.social.narrative_for_token(addr),
                    "ticks": await self.db.all("SELECT ts, price_usd, liquidity_usd FROM price_ticks WHERE token_address=? ORDER BY ts DESC LIMIT 30", (addr,))}
        if name == "narratives":
            b = await self.social.board(limit=50)
            if a.get("category"):
                b = [n for n in b if (n.get("category") or "").lower() == a["category"].lower()]
            return b[:lim]
        if name == "signals":
            q, args = "SELECT s.ts, s.symbol, s.token_address, s.verdict, s.score, s.category, pt.return_pct FROM signals s LEFT JOIN paper_trades pt ON pt.signal_id=s.id WHERE s.ts > ?", [time.time() - float(a.get("hours") or 24) * 3600]
            if a.get("verdict"):
                q += " AND s.verdict=?"
                args.append(a["verdict"].upper())
            return await self.db.all(q + " ORDER BY s.ts DESC LIMIT 50", args)
        if name == "social_search":
            return await self.db.all("SELECT ts, source, author_id, author_tier, text, url, engagement FROM social_events WHERE text LIKE ? "
                                     "AND ts > ? ORDER BY ts DESC LIMIT 30", (f"%{a['query']}%", time.time() - float(a.get("hours") or 24) * 3600))
        if name == "scorecard":
            return await self.paper.scorecard(hours=a.get("hours"))
        if name == "market":
            return {"market": {r["key"]: {**json.loads(r["data_json"] or "{}"), "value": r["value"], "as_of": r["as_of"]}
                               for r in await self.db.all("SELECT * FROM market")}, "rotation": (await self.rotation())["categories"][:8]}
        raise ValueError(f"unknown tool {name}")

    async def ask(self, question: str, history: list[dict[str, Any]] | None = None) -> str:
        if not self.ai.enabled:
            return "Ask Radar needs the Anthropic connector (Connectors → Anthropic)."
        return await self.ai.ask(question, history or [], self.TOOLS, self.run_tool, ASK_SYSTEM)
