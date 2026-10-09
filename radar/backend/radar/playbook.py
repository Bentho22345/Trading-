"""Strategies and the Playbook digester.

Strategies are filter rules over the Snipe metrics (snipe_metrics.METRICS). Three kinds:
  preset    built-in trader playbooks, distilled from the filters terminal guides and trader write-ups commonly teach
  custom    your own, built in the Snipe filter builder
  playbook  "Crowd consensus": regenerated from every digested video / guide / post — the thresholds most sources agree on

Every strategy is evaluated on every live launch; the first match is logged with all metrics and graded on Proof.

The digester reads how-to-pick-coins content and turns it into rules:
  * YouTube Data API (your key): searches for new memecoin strategy / filter videos every few hours (title,
    description, channel, views). YouTube's API does not hand out other people's captions, and TikTok has no public
    API for this, so for full transcripts you paste the text (or captions) of any video, TikTok or post on the Playbook page.
  * Extraction: Claude (structured output, only metrics Radar can actually measure) when an Anthropic key is connected,
    otherwise a built-in parser for the common phrasings ("top 10 under 30%", "dev holds less than 5%", "dev sold"…).
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import statistics
import time
from typing import Any

import httpx

from .health import Health, register
from .snipe_metrics import METRICS

log = logging.getLogger("radar.playbook")
yt_h = register(Health("playbook_youtube", "rest", "YouTube search for memecoin strategy videos (Playbook digester)"))
yt_h.stale_after = 8 * 3600

R = lambda m, op, v: {"metric": m, "op": op, "value": v}  # noqa: E731

GUIDES = {
    "axiom_medium": "https://medium.com/@GEMQUEENx/axiom-trade-strategy-best-settings-filters-and-fees-for-maximum-profits-eab7504cb07d",
    "axiom_guide": "https://medium.com/@geggonen/axiom-trade-complete-guide-938e97c0a3a6",
    "axiom_publish0x": "https://www.publish0x.com/wallet-trackers-copy-trading-analysis/axiom-pro-trading-guide-sol-bnb-eth-crypto-exchange-xmgmezr",
    "mobula_snipers": "https://docs.mobula.io/almanac/detecting-snipers-bundlers",
    "solanatracker_snipers": "https://docs.solanatracker.io/guides/sniper-detection",
    "degenesis": "https://boltzmannsoul.substack.com/p/degenesis-how-to-source-memes-to",
    "moonpay_sniper": "https://support.moonpay.com/en/articles/629129-automating-the-pump-fun-hunt-a-guide-to-the-ai-memecoin-sniper",
}

PRESETS: list[dict[str, Any]] = [
    {"id": "clean-launch", "name": "Clean launch", "appetite": "safe",
     "description": "The distribution checks terminal guides repeat: top 10 ≤ 30%, dev ≤ 5%, bundlers ≤ 10%, snipers ≤ 20%, real holders and at least one social link.",
     "rules": [R("top10_pct", "<=", 30), R("dev_hold_pct", "<=", 5), R("bundle_hold_pct", "<=", 10), R("snipers_hold_pct", "<=", 20),
               R("holders", ">=", 15), R("socials", ">=", 1)], "sources": ["axiom_medium", "axiom_guide", "axiom_publish0x", "mobula_snipers"]},
    {"id": "dev-sold-early", "name": "Dev sold, before the stretch", "appetite": "balanced",
     "description": "Enter after the dev has sold (no supply left to dump on you) but before the coin nears graduation, while buyers still outnumber sellers.",
     "rules": [R("dev_sold", "==", True), R("progress", ">=", 15), R("progress", "<=", 70), R("buy_ratio_1m", ">=", 1.2), R("holders", ">=", 20)],
     "sources": ["axiom_guide", "axiom_publish0x"]},
    {"id": "first-30s", "name": "First-30-seconds momentum", "appetite": "degen",
     "description": "Most launches are noise; the few worth a small bet show it in the first seconds: 8+ distinct buyers, 2+ SOL net in, not bundled.",
     "rules": [R("age_s", "<=", 90), R("buyers", ">=", 8), R("net_sol_1m", ">=", 2), R("bundled", "==", False)], "sources": ["moonpay_sniper"]},
    {"id": "follow-pros", "name": "Follow the pros", "appetite": "balanced", "mode": "any",
     "description": "A Top-1,000 wallet or 2+ wallets from the Top Traders pool are in. Treat it as a signal, not a guarantee — wallets change behaviour once copied.",
     "rules": [R("alpha", ">=", 1), R("pro_traders", ">=", 2)], "sources": ["moonpay_sniper"]},
    {"id": "narrative-socials", "name": "Narrative + people talking", "appetite": "balanced",
     "description": "Has an X link and at least two different people are already posting the contract or ticker.",
     "rules": [R("has_twitter", "==", True), R("social_authors", ">=", 2)], "sources": ["degenesis"]},
    {"id": "hot-meta", "name": "Rides a hot meta", "appetite": "balanced",
     "description": "Name or description fits a meta that is heating right now, with real buyers and no bundle.",
     "rules": [R("meta_hot", "==", True), R("buyers", ">=", 5), R("bundled", "==", False)], "sources": ["degenesis"]},
    {"id": "final-stretch", "name": "Final stretch", "appetite": "balanced",
     "description": "70%+ of the way to graduation, still filling at 2+ SOL/min with buyers in control.",
     "rules": [R("progress", ">=", 70), R("progress", "<", 100), R("sol_per_min", ">=", 2), R("buy_ratio_1m", ">=", 1)], "sources": ["axiom_guide"]},
    {"id": "cto", "name": "Community takeover", "appetite": "balanced",
     "description": "Dev is gone, an X community link is set and holders keep coming — the classic CTO setup.",
     "rules": [R("x_community", "==", True), R("dev_sold", "==", True), R("holders", ">=", 25)], "sources": ["axiom_publish0x"]},
    {"id": "degen-lottery", "name": "Degen lottery", "appetite": "degen",
     "description": "Under 5 minutes old, under $15k market cap, showing real upside, dev not sitting on a big bag. High risk by design — size accordingly.",
     "rules": [R("age_s", "<=", 300), R("mcap_usd", "<=", 15000), R("upside", ">=", 25), R("dev_hold_pct", "<=", 20)], "sources": ["moonpay_sniper"]},
]

# ---- built-in parser: common phrasings in videos / guides -> rules ------------------------------------------------
NUM = r"(\d+(?:\.\d+)?)"
LT = r"(?:under|below|less than|lower than|max(?:imum)?|at most|no more than|<=?|≤|up to)"
GT = r"(?:over|above|more than|at least|min(?:imum)?|>=?|≥)"
PATTERNS: list[tuple[str, str, str]] = [
    (rf"top\s*-?\s*10(?:\s*holders?)?[^.\n]{{0,25}}?{LT}\s*{NUM}\s*%", "top10_pct", "<="),
    (rf"(?:dev|developer|creator)(?:'s)?\s*(?:wallet|holding|holds|hold|allocation|bag)?[^.\n]{{0,20}}?{LT}\s*{NUM}\s*%", "dev_hold_pct", "<="),
    (rf"bundl\w*[^.\n]{{0,25}}?{LT}\s*{NUM}\s*%", "bundle_hold_pct", "<="),
    (rf"snipers?[^.\n]{{0,25}}?{LT}\s*{NUM}\s*%", "snipers_hold_pct", "<="),
    (rf"{GT}\s*{NUM}\s*holders", "holders", ">="),
    (rf"holders?[^.\n]{{0,15}}?{GT}\s*{NUM}", "holders", ">="),
    (rf"(?:market\s*cap|mcap|mc)[^.\n]{{0,15}}?{LT}\s*\$?\s*{NUM}\s*k", "mcap_usd", "<=k"),
    (rf"(?:market\s*cap|mcap|mc)[^.\n]{{0,15}}?{GT}\s*\$?\s*{NUM}\s*k", "mcap_usd", ">=k"),
    (rf"(?:bonding\s*curve|curve|progress)[^.\n]{{0,15}}?{GT}\s*{NUM}\s*%", "progress", ">="),
    (rf"(?:bonding\s*curve|curve|progress)[^.\n]{{0,15}}?{LT}\s*{NUM}\s*%", "progress", "<="),
    (rf"(?:volume)[^.\n]{{0,15}}?{GT}\s*\$?\s*{NUM}\s*k", "vol_5m_usd", ">=k"),
    (rf"{GT}\s*{NUM}\s*(?:pro|smart|kol)\s*(?:traders?|wallets?|money)", "pro_traders", ">="),
    (rf"(?:younger|newer|less)\s*than\s*{NUM}\s*min", "age_s", "<=min"),
]
FLAGS: list[tuple[str, dict[str, Any]]] = [
    (r"\bdev(?:eloper)?\s*(?:has\s*)?sold\b|\bDS\b", R("dev_sold", "==", True)),
    (r"\b(?:has|have|with|check)\s*(?:a\s*)?(?:twitter|x)\b|twitter\s*link|x\s*account", R("has_twitter", "==", True)),
    (r"\btelegram\b", R("has_telegram", "==", True)),
    (r"\bwebsite\b", R("has_website", "==", True)),
    (r"\b(?:avoid|no)\s*bundl", R("bundled", "==", False)),
    (r"\bkol|smart\s*money|whale\s*wallets?|top\s*traders?\s*(?:buying|in)\b", R("alpha", ">=", 1)),
    (r"\bx\s*communit|twitter\s*communit|\bcto\b", R("x_community", "==", True)),
]


AVOID_RX = re.compile(r"(?:avoid|red flag|skip|stay away)[^.\n]{0,70}?(?:more than|over|above|>)\s*(\d+(?:\.\d+)?)\s*%")
AVOID_METRIC = [("bundl", "bundle_hold_pct"), ("snip", "snipers_hold_pct"), ("top 10", "top10_pct"), ("top10", "top10_pct"), ("dev", "dev_hold_pct")]


def heuristic_rules(text: str) -> list[dict[str, Any]]:
    low = (text or "").lower()
    out: dict[tuple[str, str], dict[str, Any]] = {}
    # "avoid tokens where bundled wallets control more than 10%" / "snipers over 20% is a red flag" -> upper limits
    for m in AVOID_RX.finditer(low):
        span = m.group(0)
        metric = next((mt for kw, mt in AVOID_METRIC if kw in span), None)
        if metric:
            out[(metric, "<=")] = {**R(metric, "<=", float(m.group(1))), "why": span.strip()}
    for m in re.finditer(r"(\w[\w\s]{0,30}?)\s+(?:holding|hold|control|own)\w*\s+(?:more than|over|above)\s*(\d+(?:\.\d+)?)\s*%[^.\n]{0,30}?red flag", low):
        metric = next((mt for kw, mt in AVOID_METRIC if kw in m.group(1)), None)
        if metric:
            out[(metric, "<=")] = {**R(metric, "<=", float(m.group(2))), "why": m.group(0).strip()}
    for rx, metric, op in PATTERNS:
        for m in re.finditer(rx, low):
            v = float(m.group(1))
            mul = 1000 if op.endswith("k") else 60 if op.endswith("min") else 1
            o = op.rstrip("kmin") or op
            if metric in ("top10_pct", "dev_hold_pct", "bundle_hold_pct", "snipers_hold_pct", "progress") and v > 100:
                continue
            out[(metric, o)] = {**R(metric, o, v * mul), "why": low[max(0, m.start() - 20):m.end() + 10].strip()}
    for rx, rule in FLAGS:
        if re.search(rx, low, re.I):
            out.setdefault((rule["metric"], rule["op"]), {**rule, "why": "mentioned"})
    return list(out.values())


EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "rules": {"type": "array", "items": {"type": "object", "properties": {
            "metric": {"type": "string", "enum": sorted(METRICS)}, "op": {"type": "string", "enum": ["<=", ">=", "==", "<", ">"]},
            "value": {"type": "number"}, "why": {"type": "string"}}, "required": ["metric", "op", "value", "why"], "additionalProperties": False}},
        "unsupported": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "rules", "unsupported"], "additionalProperties": False,
}
EXTRACT_SYSTEM = """You read memecoin trading content (video transcripts, captions, guides, posts) and extract the concrete coin-selection
filters the author recommends, mapped ONLY to these measurable metrics:
""" + "\n".join(f"- {k}: {v[0]} ({v[2]}{', unit ' + v[1] if v[1] else ''})" for k, v in METRICS.items()) + """
Rules: use booleans as 1/0 values with op "==". Percentages are 0-100. Dollar values in plain dollars (20k -> 20000). Age in seconds.
Only extract what the author actually recommends as a buy filter; skip hype, referral pitches and anything not measurable
(list those in `unsupported`). If nothing concrete is recommended, return no rules. Summary: one sentence."""


def consensus(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Weighted median threshold per (metric, direction) across every digested source; more-viewed sources weigh more."""
    by: dict[tuple[str, str], list[tuple[float, float]]] = {}
    support: dict[tuple[str, str], int] = {}
    for s in sources:
        w = 1 + min(1.5, math.log10((s.get("views") or 0) + 1) / 4)   # popular sources count more, but never dominate
        seen = set()
        for r in json.loads(s.get("rules_json") or "[]"):
            if r.get("metric") not in METRICS:
                continue
            key = (r["metric"], r["op"])
            by.setdefault(key, []).append((float(r["value"]), w))
            if key not in seen:
                support[key] = support.get(key, 0) + 1
                seen.add(key)
    need = 2 if len(sources) >= 5 else 1
    out = []
    for (metric, op), vals in by.items():
        if support[(metric, op)] < need:
            continue
        if METRICS[metric][2] == "bool":
            yes = sum(w for v, w in vals if v)
            no = sum(w for v, w in vals if not v)
            out.append({**R(metric, "==", yes >= no), "support": support[(metric, op)]})
            continue
        vals.sort()
        tot, acc, med = sum(w for _, w in vals), 0.0, vals[0][0]
        for v, w in vals:
            acc += w
            if acc >= tot / 2:
                med = v
                break
        out.append({**R(metric, op, round(med, 2)), "support": support[(metric, op)]})
    # a metric with both <= and >= keeps both (a range); conflicting duplicates are impossible by construction
    return sorted(out, key=lambda r: -r["support"])


class Playbook:
    def __init__(self, db: Any, ai: Any, connectors: Any, sniper: Any, alerts: Any) -> None:
        self.db, self.ai, self.connectors, self.sniper, self.alerts = db, ai, connectors, sniper, alerts
        self.client = httpx.AsyncClient(timeout=15)
        self.version = 0          # bumps whenever strategies change, so cached lists never go stale

    # ---------------- strategies ----------------
    async def load(self) -> None:
        now = time.time()
        for p in PRESETS:
            await self.db.exec(
                "INSERT INTO strategies (id, name, description, rules_json, mode, appetite, source, sources_json, created, updated) "
                "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, "
                "rules_json=excluded.rules_json, mode=excluded.mode, appetite=excluded.appetite, sources_json=excluded.sources_json, updated=excluded.updated",
                (p["id"], p["name"], p["description"], json.dumps(p["rules"]), p.get("mode", "all"), p["appetite"], "preset",
                 json.dumps([GUIDES[k] for k in p["sources"]]), now, now))
        await self.seed_sources()
        await self.refresh()

    async def refresh(self) -> None:
        self.version += 1
        rows = await self.db.all("SELECT id, name, rules_json, mode FROM strategies WHERE enabled=1")
        self.sniper.strategies = [{"id": r["id"], "name": r["name"], "rules": json.loads(r["rules_json"]), "mode": r["mode"] or "all"}
                                  for r in rows if json.loads(r["rules_json"] or "[]")]

    async def list(self, hours: float = 168) -> list[dict[str, Any]]:
        rows = await self.db.all("SELECT * FROM strategies ORDER BY CASE source WHEN 'playbook' THEN 0 WHEN 'preset' THEN 1 ELSE 2 END, name")
        since = time.time() - hours * 3600
        stats = {r["strategy_id"]: r for r in await self.db.all(
            "SELECT strategy_id, COUNT(*) n, SUM(CASE WHEN peak_mcap_sol >= 2*mcap_sol THEN 1 ELSE 0 END) x2, "
            "SUM(CASE WHEN peak_mcap_sol >= 5*mcap_sol THEN 1 ELSE 0 END) x5, SUM(graduated_at IS NOT NULL) grad, "
            "SUM(CASE WHEN mcap_sol_1h IS NOT NULL THEN 1 ELSE 0 END) settled, SUM(CASE WHEN mcap_sol_1h > mcap_sol THEN 1 ELSE 0 END) up1h "
            "FROM strategy_hits WHERE ts > ? AND mcap_sol > 0 GROUP BY strategy_id", (since,))}
        peaks: dict[str, list[float]] = {}
        for r in await self.db.all("SELECT strategy_id, peak_mcap_sol / mcap_sol x FROM strategy_hits WHERE ts > ? AND mcap_sol > 0", (since,)):
            peaks.setdefault(r["strategy_id"], []).append(r["x"] or 0)
        out = []
        for r in rows:
            st = stats.get(r["id"]) or {}
            n = st.get("n") or 0
            out.append({**{k: r[k] for k in ("id", "name", "description", "mode", "appetite", "source", "enabled", "alert", "updated")},
                        "rules": json.loads(r["rules_json"] or "[]"), "sources": json.loads(r["sources_json"] or "[]"),
                        "stats": {"hits": n, "hit_2x_pct": round((st.get("x2") or 0) / n * 100, 1) if n else None,
                                  "hit_5x_pct": round((st.get("x5") or 0) / n * 100, 1) if n else None,
                                  "graduated_pct": round((st.get("grad") or 0) / n * 100, 1) if n else None,
                                  "up_1h_pct": round((st.get("up1h") or 0) / st["settled"] * 100, 1) if st.get("settled") else None,
                                  "median_peak_x": round(statistics.median(peaks[r["id"]]), 2) if peaks.get(r["id"]) else None}})
        return out

    async def save(self, d: dict[str, Any]) -> str:
        rules = [r for r in d.get("rules") or [] if r.get("metric") in METRICS and r.get("op") in ("<=", ">=", "==", "<", ">", "!=")]
        if not rules:
            raise ValueError("a strategy needs at least one rule on a known metric")
        sid = d.get("id") or "custom-" + re.sub(r"[^a-z0-9]+", "-", (d.get("name") or "strategy").lower()).strip("-")[:40]
        cur = await self.db.one("SELECT source FROM strategies WHERE id=?", (sid,))
        if cur and cur["source"] != "custom":
            raise ValueError("built-in strategies can't be edited — save a copy under a new name")
        now = time.time()
        await self.db.exec("INSERT INTO strategies (id, name, description, rules_json, mode, appetite, source, created, updated, alert) "
                           "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, "
                           "rules_json=excluded.rules_json, mode=excluded.mode, appetite=excluded.appetite, alert=excluded.alert, updated=excluded.updated",
                           (sid, d.get("name") or sid, d.get("description"), json.dumps(rules), d.get("mode") or "all",
                            d.get("appetite") or "balanced", "custom", now, now, int(bool(d.get("alert")))))
        await self.refresh()
        return sid

    async def toggle(self, sid: str, enabled: bool | None, alert: bool | None) -> None:
        if enabled is not None:
            await self.db.exec("UPDATE strategies SET enabled=? WHERE id=?", (int(enabled), sid))
        if alert is not None:
            await self.db.exec("UPDATE strategies SET alert=? WHERE id=?", (int(alert), sid))
        await self.refresh()

    async def delete(self, sid: str) -> None:
        await self.db.exec("DELETE FROM strategies WHERE id=? AND source='custom'", (sid,))
        await self.refresh()

    async def on_hit(self, sid: str, r: dict[str, Any]) -> None:
        st = await self.db.one("SELECT name, alert FROM strategies WHERE id=?", (sid,))
        if st and st["alert"]:
            await self.alerts.send("info", f"🎯 {st['name']}: {r.get('symbol') or r['mint'][:6]}",
                                   f"upside {r.get('upside')} · risk {r.get('risk')} · " + ", ".join((r.get('why_up') or [])[:3]),
                                   token=r["mint"], dedupe=f"strat:{sid}:{r['mint']}", ttl=86400)

    # ---------------- playbook sources ----------------
    async def seed_sources(self) -> None:
        """The guides behind the presets, as digestible sources, so the crowd consensus has a starting point."""
        seeds = [
            (GUIDES["axiom_medium"], "Axiom trade strategy: best settings & filters", "Top 10 holders under 30% excluding liquidity pools. "
             "Dev holding under 5% or burned. Avoid tokens where bundled wallets control more than 10% of the supply. Dev sold is usually a bullish sign."),
            (GUIDES["axiom_guide"], "Axiom Trade — complete guide", "Ideally top 10 holders under 30% combined. Check dev wallet %; dev sold (DS) "
             "is read as bullish. Enter after the developer has sold, before the token is close to graduating. Check socials: twitter and telegram."),
            (GUIDES["axiom_publish0x"], "Axiom Pro trading guide", "Multiple sniper wallets holding over 20% combined is a red flag; snipers under 20%. "
             "Bundlers under 10%. Look for at least 1 social link, an X community for community takeovers."),
            (GUIDES["moonpay_sniper"], "Automating the pump.fun hunt (AI memecoin sniper guide)", "Most tokens are noise; a few show enough signal in "
             "the first 30 seconds to be worth a small bet. Watch smart money and top traders buying, but treat wallet-following as a signal not a guarantee."),
            (GUIDES["degenesis"], "Degenesis: how to source memes, do DD and size bets", "Check holder distribution, social media presence "
             "(twitter, website), the narrative and community, and the top trader leaderboard. Size bets small."),
        ]
        now = time.time()
        for url, title, text in seeds:
            await self.db.exec("INSERT OR IGNORE INTO playbook_sources (kind, url, title, author, text, added, status) VALUES (?,?,?,?,?,?,?)",
                               ("guide", url, title, "guide", text, now, "new"))

    async def add(self, d: dict[str, Any]) -> int:
        url = (d.get("url") or "").strip() or f"note:{int(time.time() * 1000)}"
        kind = d.get("kind") or ("youtube" if "youtu" in url else "tiktok" if "tiktok.com" in url else "x" if re.search(r"(?:x|twitter)\.com", url) else "text")
        await self.db.exec("INSERT INTO playbook_sources (kind, url, title, author, text, added, status) VALUES (?,?,?,?,?,?,?) "
                           "ON CONFLICT(url) DO UPDATE SET text=COALESCE(excluded.text, playbook_sources.text), title=COALESCE(excluded.title, playbook_sources.title), status='new'",
                           (kind, url, d.get("title") or url, d.get("author"), (d.get("text") or "")[:60000] or None, time.time(), "new"))
        row = await self.db.one("SELECT id FROM playbook_sources WHERE url=?", (url,))
        asyncio.get_running_loop().create_task(self.digest(row["id"]))
        return row["id"]

    async def digest(self, sid: int) -> dict[str, Any] | None:
        s = await self.db.one("SELECT * FROM playbook_sources WHERE id=?", (sid,))
        if not s:
            return None
        text = "\n".join(x for x in (s["title"], s["text"]) if x)
        rules, unsupported, summary, extractor, err = [], [], None, "parser", None
        if self.ai and self.ai.enabled and len(text) > 40:
            try:
                resp = await self.ai._create("playbook", model=__import__("radar.ai", fromlist=["FAST_MODEL"]).FAST_MODEL, max_tokens=2000,
                                             system=[{"type": "text", "text": EXTRACT_SYSTEM, "cache_control": {"type": "ephemeral"}}],
                                             output_config={"effort": "low", "format": {"type": "json_schema", "schema": EXTRACT_SCHEMA}},
                                             messages=[{"role": "user", "content": text[:40000]}])
                d = json.loads(self.ai._text(resp))
                for r in d["rules"]:
                    if METRICS.get(r["metric"], ("", "", ""))[2] == "bool":
                        r["value"] = bool(r["value"])
                rules, unsupported, summary, extractor = d["rules"], d["unsupported"], d["summary"], "claude"
            except Exception as e:  # noqa: BLE001 - fall back to the parser
                err = str(e)[:200]
        if extractor == "parser":
            rules = heuristic_rules(text)
            summary = f"{len(rules)} filter{'s' if len(rules) != 1 else ''} found by the built-in parser" if rules else "no concrete filters found"
        await self.db.exec("UPDATE playbook_sources SET digested=?, status=?, summary=?, rules_json=?, unsupported_json=?, extractor=?, error=? WHERE id=?",
                           (time.time(), "digested", summary, json.dumps(rules), json.dumps(unsupported), extractor, err, sid))
        await self.rebuild_consensus()
        return {"id": sid, "rules": rules, "summary": summary, "extractor": extractor}

    async def rebuild_consensus(self) -> list[dict[str, Any]]:
        srcs = await self.db.all("SELECT rules_json, views FROM playbook_sources WHERE status='digested' AND rules_json NOT IN ('[]','')")
        rules = consensus(srcs)
        now = time.time()
        if rules:
            await self.db.exec(
                "INSERT INTO strategies (id, name, description, rules_json, mode, appetite, source, created, updated) VALUES (?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET rules_json=excluded.rules_json, description=excluded.description, updated=excluded.updated",
                ("crowd-consensus", "Crowd consensus",
                 f"The filters most of the {len(srcs)} digested videos / guides / posts agree on (weighted median; refreshed on every digest).",
                 json.dumps([{k: r[k] for k in ("metric", "op", "value")} for r in rules]), "all", "balanced", "playbook", now, now))
            await self.refresh()
        return rules

    async def overview(self) -> dict[str, Any]:
        rows = await self.db.all("SELECT id, kind, url, title, author, published, views, added, digested, status, summary, rules_json, "
                                 "unsupported_json, extractor, error, LENGTH(text) text_len FROM playbook_sources ORDER BY COALESCE(digested, added) DESC LIMIT 300")
        srcs = await self.db.all("SELECT rules_json, views FROM playbook_sources WHERE status='digested' AND rules_json NOT IN ('[]','')")
        yt = await self.connectors.values("youtube")
        return {"sources": [{**{k: r[k] for k in r if k not in ("rules_json", "unsupported_json")},
                             "rules": json.loads(r["rules_json"] or "[]"), "unsupported": json.loads(r["unsupported_json"] or "[]")} for r in rows],
                "consensus": consensus(srcs), "metrics": {k: {"label": v[0], "unit": v[1], "kind": v[2]} for k, v in METRICS.items()},
                "youtube_connected": bool(yt.get("api_key")), "ai_connected": bool(self.ai and self.ai.enabled)}

    # ---------------- discovery ----------------
    QUERIES = ["memecoin sniping filters", "pump.fun trading strategy", "axiom pulse filters settings", "how to find memecoins early solana",
               "gmgn trenches filters", "memecoin trading strategy 2026", "solana memecoin red flags bundles snipers"]

    async def discover(self) -> int:
        v = await self.connectors.values("youtube")
        if not v.get("api_key"):
            return 0
        added = 0
        after = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 45 * 86400))
        for q in self.QUERIES:
            t0 = time.perf_counter()
            r = await self.client.get("https://www.googleapis.com/youtube/v3/search", params={
                "part": "snippet", "q": q, "type": "video", "order": "relevance", "publishedAfter": after, "maxResults": 15,
                "relevanceLanguage": "en", "key": v["api_key"]})
            r.raise_for_status()
            yt_h.ok((time.perf_counter() - t0) * 1000)
            items = r.json().get("items", [])
            ids = [i["id"]["videoId"] for i in items if (i.get("id") or {}).get("videoId")]
            if not ids:
                continue
            det = await self.client.get("https://www.googleapis.com/youtube/v3/videos",
                                        params={"part": "snippet,statistics", "id": ",".join(ids), "key": v["api_key"]})
            det.raise_for_status()
            for it in det.json().get("items", []):
                sn, st = it.get("snippet") or {}, it.get("statistics") or {}
                url = f"https://www.youtube.com/watch?v={it['id']}"
                if await self.db.one("SELECT 1 FROM playbook_sources WHERE url=?", (url,)):
                    continue
                pub = sn.get("publishedAt")
                await self.db.exec("INSERT OR IGNORE INTO playbook_sources (kind, url, title, author, published, views, text, added, status) "
                                   "VALUES (?,?,?,?,?,?,?,?,?)", ("youtube", url, sn.get("title"), sn.get("channelTitle"),
                                                                  time.mktime(time.strptime(pub[:19], "%Y-%m-%dT%H:%M:%S")) if pub else None,
                                                                  float(st.get("viewCount") or 0), (sn.get("description") or "")[:8000],
                                                                  time.time(), "new"))
                added += 1
        return added

    async def loop(self) -> None:
        await asyncio.sleep(20)
        while True:
            try:
                await self.discover()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                yt_h.fail(f"{type(e).__name__}: {e}")
            try:
                for r in await self.db.all("SELECT id FROM playbook_sources WHERE status='new' ORDER BY views DESC LIMIT 25"):
                    await self.digest(r["id"])
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("playbook digest: %s", e)
            await asyncio.sleep(4 * 3600)   # 7 searches × 100 units × 6/day ≈ 4.2k of YouTube's 10k daily quota
