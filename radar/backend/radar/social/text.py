"""Cheap, deterministic text features (used when Claude isn't connected, and for clustering)."""
from __future__ import annotations

import re
from typing import Any

STOP = set("""a an the and or but if of to in on at by for with from as is are was were be been being it its this that these
those i you he she we they them his her our your their my me us not no yes so do does did done have has had will would can
could should may might must just than then there here what when where who whom why how all any each few more most other some
such only own same too very s t don now new via amp rt https http www com co news says said say after over out up down into
about again also get got one two make made like just today tonight live update breaking report reports video watch""".split())

WORD = re.compile(r"[A-Za-z][A-Za-z0-9'\-]{2,}")
CAPS = re.compile(r"\b[A-Z]{3,10}\b")
PROPER = re.compile(r"\b(?:[A-Z][a-z]+(?:\s+|$)){1,3}")


def keywords(text: str, n: int = 8) -> list[str]:
    seen: dict[str, int] = {}
    for w in WORD.findall(text or ""):
        lw = w.lower().strip("'-")
        if lw in STOP or len(lw) < 3 or lw.isdigit():
            continue
        seen[lw] = seen.get(lw, 0) + 1
    return [w for w, _ in sorted(seen.items(), key=lambda kv: (-kv[1], -len(kv[0])))[:n]]


def ticker_guesses(text: str, cashtags: list[str]) -> list[str]:
    out = list(cashtags)
    for c in CAPS.findall(text or ""):
        if c.lower() not in STOP and c not in ("USD", "CEO", "USA", "NFT", "ETF", "SEC", "THE", "AND", "FOR", "NEW"):
            out.append(c)
    for p in PROPER.findall(text or ""):
        words = [w for w in p.split() if w.lower() not in STOP]
        if words:
            out.append("".join(words).upper()[:10])
    return list(dict.fromkeys(out))[:8]


def category(text: str, cats: dict[str, list[str]]) -> str:
    low = f" {(text or '').lower()} "
    best, hits = "other", 0
    for cat, words in (cats or {}).items():
        h = sum(1 for w in words if f" {w}" in low or f"${w}" in low)
        if h > hits:
            best, hits = cat, h
    return best


def heuristic_classify(text: str, cashtags: list[str], cas: list[str], cats: dict[str, list[str]],
                       listing_words: list[str]) -> dict[str, Any]:
    cat = category(text, cats)
    low = (text or "").lower()
    kws = keywords(text)
    listing = any(w in low for w in listing_words) and any(x in low for x in ("binance", "coinbase", "robinhood", "upbit", "okx", "bybit"))
    return {
        "method": "heuristic",
        "tokenizable": bool(cashtags or cas) or cat in ("animal", "celebrity", "politifi", "ai", "meme"),
        "category": cat, "title": " ".join(kws[:4]) or (text or "")[:60],
        "ticker_candidates": ticker_guesses(text, cashtags), "name_candidates": [],
        "keywords": kws, "sentiment": 0.0, "expected_life_hours": 48,
        "is_breaking_news": "breaking" in low or "just in" in low, "is_exchange_listing": listing,
    }


def jaccard(a: list[str] | set[str], b: list[str] | set[str]) -> float:
    a, b = set(a), set(b)
    return len(a & b) / len(a | b) if a and b else 0.0
