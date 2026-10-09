"""News intelligence: every headline from the RSS/Google News/Reddit feeds is tagged on arrival.

  publisher  split out of Google News titles ("Headline - Publisher")
  tags       listing, delisting, hack, regulation, etf, launch, airdrop, partnership, whale, celebrity, politics, macro, ...
  sentiment  -1 (bearish) .. 1 (bullish), from wording
  metas      which memecoin metas (config/metas.yaml) the headline touches
  tickers    cashtags, known memecoin names ("Dogecoin" -> DOGE), and ALL-CAPS symbols of liquid coins Radar tracks
  story_id   near-duplicate headlines from different outlets collapse into one story with a coverage count
  impact     0-100: how likely the item is to move memecoins (group, tags, tickers, coverage, recency)

High-impact items (a memecoin listing on a major exchange, a hack, an official token launch) raise an alert.
"""
from __future__ import annotations

import hashlib
import logging
import re
import time
from collections import deque
from typing import Any

from .detect import detect

log = logging.getLogger("radar.news")

TAGS: dict[str, re.Pattern[str]] = {k: re.compile(v, re.I) for k, v in {
    "listing": r"\b(will list|lists|listing|listed on|to list|adds? support for|launches? trading|now (?:available|live) on|"
               r"roadmap|perpetuals? for|futures for|spot trading)\b",
    "delisting": r"\b(delist|delisting|delisted|removes? support|suspends? trading)\b",
    "hack": r"\b(hack(?:ed|er|s)?|exploit(?:ed)?|drain(?:ed)?|rug ?pull(?:ed)?|rugged|stolen|phishing|attacker|breach)\b",
    "regulation": r"\b(sec|cftc|lawsuit|sued|sues|court|judge|ruling|regulat\w*|ban(?:s|ned)?|bill|senate|congress|subpoena|"
                  r"settle(?:s|ment)?|genius act|clarity act|doj)\b",
    "etf": r"\b(etfs?|blackrock|grayscale|21shares|vaneck|bitwise|canary capital|spot fund)\b",
    "launch": r"\b(launch(?:es|ed)? (?:a |its |his |her |an |the )?(?:official )?(?:meme ?coin|token|coin)|official (?:meme ?coin|token)|"
              r"memecoin launch|token launch|tge)\b",
    "airdrop": r"\b(airdrops?|claim(?:s|able)?|snapshot|points program)\b",
    "partnership": r"\b(partner(?:s|ship)?|integrat(?:es|ion)|teams? up|collaborat\w+|acquir(?:es|ed|ition))\b",
    "whale": r"\b(whales?|smart money|wallet (?:buys|sells|bought|sold)|accumulat\w+|dumps?|dumped)\b",
    "celebrity": r"\b(elon|musk|kanye|drake|snoop|kardashian|celebrit\w+|influencer|streamer|mrbeast|ishowspeed)\b",
    "politics": r"\b(trump|melania|vance|white house|biden|election|tariffs?|president|congress|senate)\b",
    "macro": r"\b(fed|fomc|powell|cpi|inflation|recession|rate cut|rate hike|jobs report|treasury yields?)\b",
    "market": r"\b(surge[sd]?|soar(?:s|ed)?|rall(?:y|ies|ied)|plunge[sd]?|crash(?:es|ed)?|tumble[sd]?|spike[sd]?|"
              r"all-time high|ath|liquidat\w+|pump(?:s|ed)?)\b",
}.items()}

BULL = re.compile(r"\b(surge[sd]?|soar(?:s|ed)?|rall(?:y|ies|ied)|jump(?:s|ed)?|record|all-time high|ath|approv\w+|"
                  r"list(?:s|ing|ed)?|launch(?:es|ed)?|partner\w*|adopt\w*|bull\w*|gain(?:s|ed)?|spike[sd]?|rockets?|moon\w*|"
                  r"breakout|wins?|inflows?|buys?|bought|accumulat\w+)\b", re.I)
BEAR = re.compile(r"\b(crash(?:es|ed)?|plunge[sd]?|tumble[sd]?|slip(?:s|ped)?|sink(?:s)?|sank|drop(?:s|ped)?|fall(?:s|en)?|fell|slump\w*|hack\w*|exploit\w*|"
                  r"drain\w*|sue[sd]?|lawsuit|ban(?:s|ned)?|delist\w*|dump(?:s|ed)?|rug\w*|scam\w*|fraud|bear\w*|liquidat\w+|"
                  r"outflows?|sells?|sold|warn(?:s|ing)?|probe|investigat\w+|arrest\w*|loss(?:es)?)\b", re.I)

# Common memecoin names that headlines spell out instead of using a cashtag.
NAMES: dict[str, str] = {
    "dogecoin": "DOGE", "shiba inu": "SHIB", "pepe": "PEPE", "pepecoin": "PEPE", "bonk": "BONK", "dogwifhat": "WIF",
    "floki": "FLOKI", "popcat": "POPCAT", "fartcoin": "FARTCOIN", "pudgy penguins": "PENGU", "pengu": "PENGU",
    "official trump": "TRUMP", "trump coin": "TRUMP", "trump memecoin": "TRUMP", "trump meme coin": "TRUMP",
    "melania coin": "MELANIA", "melania memecoin": "MELANIA", "brett": "BRETT", "mog coin": "MOG", "spx6900": "SPX",
    "peanut the squirrel": "PNUT", "moo deng": "MOODENG", "ai16z": "AI16Z", "goatseus": "GOAT", "turbo": "TURBO",
    "neiro": "NEIRO", "book of meme": "BOME", "cat in a dogs world": "MEW", "myro": "MYRO", "gigachad": "GIGA",
    "dogs": "DOGS", "notcoin": "NOT", "hamster kombat": "HMSTR", "baby doge": "BABYDOGE", "toshi": "TOSHI",
    "pump.fun": "PUMP", "pumpfun": "PUMP", "aixbt": "AIXBT", "virtuals": "VIRTUAL", "useless coin": "USELESS",
}
NAMES_RX = re.compile(r"(?<![a-z0-9])(" + "|".join(re.escape(k) for k in sorted(NAMES, key=len, reverse=True)) + r")(?![a-z0-9])")
CAPS = re.compile(r"(?<![A-Za-z0-9$])([A-Z][A-Z0-9]{2,9})(?![A-Za-z0-9])")
NOT_SYMBOLS = {"THE", "AND", "FOR", "NEW", "CEO", "USA", "SEC", "ETF", "NFT", "USD", "API", "CPI", "FED", "GDP", "IPO", "UK", "EU",
               "BREAKING", "JUST", "NEWS", "LIVE", "WATCH", "UPDATE", "CFTC", "DOJ", "FBI", "IRS", "AI", "ATH", "DEX", "CEX", "TVL",
               "USDT", "USDC", "BTC", "ETH", "SOL", "BNB", "XRP", "DAO", "DEFI", "FOMC", "OKX", "MEME", "WEB"}
GROUP_BASE = {"listings": 55, "memecoin": 45, "breaking": 40, "solana": 35, "crypto": 30, "politics": 30, "celebrity": 30,
              "viral": 25, "regulation": 30, "hacks": 40, "macro": 20, "trends": 20, "reddit": 15, "social": 10}
TAG_W = {"listing": 25, "hack": 20, "launch": 25, "delisting": 15, "etf": 12, "regulation": 8, "airdrop": 8, "whale": 8,
         "celebrity": 8, "politics": 6, "partnership": 6, "macro": 5, "market": 5}
STOP = set("a an the and or of to in on at by for with from as is are was were be it its this that new says said after over "
           "into about amid as how why what will can could may just now up down vs report reports".split())


def clean_title(title: str, source: str) -> tuple[str, str | None]:
    """Google News titles end in ' - Publisher'. Return (headline, publisher)."""
    t = re.sub(r"\s+", " ", title or "").strip()
    if source.startswith("GNews") or " - " in t[-60:]:
        head, sep, pub = t.rpartition(" - ")
        if sep and 2 <= len(pub) <= 60 and len(head) >= 15:
            return head.strip(), pub.strip()
    return t, None


def title_words(t: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9$][a-z0-9.$']+", t.lower()) if w not in STOP and len(w) > 2}


class NewsIntel:
    def __init__(self, metas: Any = None, alerts: Any = None, db: Any = None) -> None:
        self.metas, self.alerts, self.db = metas, alerts, db
        self.stories: deque[tuple[float, str, set[str]]] = deque(maxlen=3000)   # (ts, story_id, words)
        self.coverage: dict[str, set[str]] = {}
        self.symbols: set[str] = set()
        self.symbols_at = 0.0

    async def load(self) -> None:
        """Rebuild story clusters from the last 12h of stored headlines so coverage counts survive restarts."""
        if not self.db:
            return
        rows = await self.db.all("SELECT title, publisher, story_id, COALESCE(published, fetched) ts FROM news WHERE fetched > ? "
                                 "AND story_id IS NOT NULL ORDER BY fetched LIMIT 3000", (time.time() - 12 * 3600,))
        for r in rows:
            self.stories.append((r["ts"], r["story_id"], title_words(r["title"] or "")))
            self.coverage.setdefault(r["story_id"], set()).add((r["publisher"] or "").lower())

    async def refresh_symbols(self) -> None:
        """ALL-CAPS words in headlines count as tickers only if a liquid coin Radar tracks has that symbol."""
        if not self.db or time.time() - self.symbols_at < 300:
            return
        self.symbols_at = time.time()
        rows = await self.db.all("SELECT DISTINCT upper(t.symbol) s FROM tokens t JOIN pairs p ON p.pair_address=t.best_pair "
                                 "WHERE p.liquidity_usd >= 50000 AND t.symbol IS NOT NULL")
        self.symbols = {r["s"] for r in rows if r["s"] and r["s"] not in NOT_SYMBOLS}

    def tickers(self, head: str) -> list[str]:
        out = list(detect(head)["cashtags"])
        out += [NAMES[m] for m in NAMES_RX.findall(head.lower())]
        out += [w for w in CAPS.findall(head) if w in self.symbols and w not in NOT_SYMBOLS]
        return list(dict.fromkeys(out))[:8]

    def _story(self, ts: float, rid: str, words: set[str], publisher: str) -> tuple[str, int]:
        best, best_sim = None, 0.0
        for sts, sid, sw in self.stories:
            if ts - sts > 12 * 3600 or not sw or not words:
                continue
            sim = len(words & sw) / len(words | sw)
            if sim > best_sim:
                best, best_sim = sid, sim
        sid = best if best and best_sim >= 0.5 else rid
        self.stories.append((ts, sid, words))
        cov = self.coverage.setdefault(sid, set())
        cov.add(publisher)
        if len(self.coverage) > 6000:
            keep = {s for _, s, _ in self.stories}
            self.coverage = {k: v for k, v in self.coverage.items() if k in keep}
        return sid, len(cov)

    def enrich(self, r: dict[str, Any], feed: dict[str, Any]) -> dict[str, Any]:
        now = time.time()
        head, pub = clean_title(r["title"], feed.get("name") or r.get("source") or "")
        publisher = pub or feed.get("name") or r.get("source") or ""
        group = feed.get("group") or "crypto"
        tags = [k for k, rx in TAGS.items() if rx.search(head)]
        if "delisting" in tags and "listing" in tags:
            tags.remove("listing")
        bull, bear = len(BULL.findall(head)), len(BEAR.findall(head))
        sentiment = round((bull - bear) / max(1, bull + bear), 2) if bull or bear else 0.0
        metas = self.metas.match_text(head) if self.metas else []
        ticks = self.tickers(head)
        ts = r.get("published") or r.get("fetched") or now
        sid, coverage = self._story(ts, r["id"], title_words(head), publisher.lower())
        impact = GROUP_BASE.get(group, 20) + sum(TAG_W.get(t, 0) for t in tags) + min(15, 5 * len(ticks)) \
            + min(10, 4 * len(metas)) + min(15, 5 * (coverage - 1))
        if ts < now - 6 * 3600:
            impact *= 0.6
        return {**r, "title": head, "publisher": publisher, "group": group, "tags": tags, "sentiment": sentiment, "metas": metas,
                "tickers": ticks, "story_id": sid, "coverage": coverage, "impact": round(min(100.0, impact), 1)}

    async def on_fresh(self, items: list[dict[str, Any]]) -> None:
        if not self.alerts:
            return
        now = time.time()
        for it in items:
            ts = it.get("published") or it.get("fetched") or now
            if ts < now - 1800 or it.get("coverage", 1) > 1:
                continue
            tags, ticks = it.get("tags") or [], it.get("tickers") or []
            kind = None
            if "listing" in tags and ticks and it.get("group") in ("listings", "memecoin", "crypto", "breaking"):
                kind, label = "flash", "Listing"
            elif "launch" in tags and ("politics" in tags or "celebrity" in tags):
                kind, label = "flash", "Official token launch"
            elif "hack" in tags and (ticks or "hacks" in (it.get("metas") or [])):
                kind, label = "info", "Hack / exploit"
            elif it.get("impact", 0) >= 85:
                kind, label = "info", "High-impact news"
            if not kind:
                continue
            tick = " ".join(f"${t}" for t in ticks[:3])
            key = hashlib.sha1(it["story_id"].encode()).hexdigest()[:12]
            await self.alerts.send(kind, f"📰 {label}: {it['title'][:140]}", f"{it['publisher']} {tick}".strip(),
                                   dedupe=f"news:{key}", ttl=6 * 3600, extra={"link": it.get("link")})
