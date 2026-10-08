"""Connector catalog: every data source / destination, what it does, and how to connect it.

- keyless: wired in and running automatically.
- key: needs something only you can get (API key, account). Paste it on the Connectors page;
  it is encrypted at rest and a real test call verifies it.
- info: no usable official access; explained instead of scraped.
Custom sources (any RSS / JSON API / WebSocket link you find) live in custom_sources.
"""
from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

from . import secrets
from .db import DB
from .health import REGISTRY

Tester = Callable[[dict[str, str]], Awaitable[str]]


@dataclass
class Field:
    name: str
    label: str
    secret: bool = True
    env: str | None = None
    placeholder: str = ""
    optional: bool = False


@dataclass
class Connector:
    id: str
    name: str
    category: str
    kind: str  # keyless | key | info
    what: str
    used_for: str
    phase: int
    signup_url: str | None = None
    how: str | None = None
    cost: str = "free"
    fields: list[Field] = field(default_factory=list)
    test: Tester | None = None
    health_name: str | None = None


async def _get(url: str, **kw: Any) -> httpx.Response:
    async with httpx.AsyncClient(timeout=15) as c:
        return await c.get(url, **kw)


async def _post(url: str, **kw: Any) -> httpx.Response:
    async with httpx.AsyncClient(timeout=15) as c:
        return await c.post(url, **kw)


def _need(r: httpx.Response, ok: str) -> str:
    if r.status_code >= 400:
        raise ValueError(f"HTTP {r.status_code}: {r.text[:200]}")
    return ok


async def t_anthropic(v: dict[str, str]) -> str:
    r = await _get("https://api.anthropic.com/v1/models", headers={"x-api-key": v["api_key"], "anthropic-version": "2023-06-01"})
    return _need(r, f"Key valid · {len(r.json().get('data', []))} models available")


async def t_x(v: dict[str, str]) -> str:
    r = await _get("https://api.x.com/2/usage/tweets", headers={"Authorization": f"Bearer {v['bearer_token']}"})
    return _need(r, "Bearer token accepted (usage endpoint, no post reads charged)")


async def t_telegram_bot(v: dict[str, str]) -> str:
    r = await _post(f"{os.environ.get('TELEGRAM_API_URL', 'https://api.telegram.org')}/bot{v['bot_token']}/sendMessage",
                    json={"chat_id": v["chat_id"], "text": "✅ Memecoin Radar connected. Alerts will arrive here."})
    return _need(r, "Test message sent to your Telegram chat")


async def t_telegram_user(v: dict[str, str]) -> str:
    if not v.get("api_id", "").isdigit() or not re.fullmatch(r"[0-9a-f]{32}", v.get("api_hash", "")):
        raise ValueError("api_id must be digits and api_hash 32 hex characters (from my.telegram.org)")
    return "Format OK · one-time login code is requested when the Telegram channel reader starts (Phase 3)"


async def t_discord(v: dict[str, str]) -> str:
    r = await _post(v["webhook_url"], json={"content": "✅ Memecoin Radar connected."})
    return _need(r, "Test message posted to Discord")


async def t_ntfy(v: dict[str, str]) -> str:
    server = (v.get("server") or "https://ntfy.sh").rstrip("/")
    r = await _post(f"{server}/{v['topic']}", content="Memecoin Radar connected", headers={"Title": "Radar ✅"})
    return _need(r, f"Push sent to {server}/{v['topic']} — check your phone")


async def t_reddit(v: dict[str, str]) -> str:
    r = await _post("https://www.reddit.com/api/v1/access_token", data={"grant_type": "client_credentials"},
                    auth=(v["client_id"], v["client_secret"]), headers={"User-Agent": "MemecoinRadar/0.1"})
    _need(r, "")
    if "access_token" not in r.json():
        raise ValueError(str(r.json())[:200])
    return "OAuth app-only token issued"


async def t_neynar(v: dict[str, str]) -> str:
    r = await _get("https://api.neynar.com/v2/farcaster/feed/trending", params={"limit": 1},
                   headers={"x-api-key": v["api_key"]})
    return _need(r, "Neynar key valid")


async def t_helius(v: dict[str, str]) -> str:
    r = await _post(f"https://mainnet.helius-rpc.com/?api-key={v['api_key']}",
                    json={"jsonrpc": "2.0", "id": 1, "method": "getHealth"})
    _need(r, "")
    return f"RPC says: {r.json().get('result', r.json())}"


async def t_birdeye(v: dict[str, str]) -> str:
    r = await _get("https://public-api.birdeye.so/defi/price",
                   params={"address": "So11111111111111111111111111111111111111112"},
                   headers={"X-API-KEY": v["api_key"], "x-chain": "solana"})
    return _need(r, "Birdeye key valid")


async def t_coingecko(v: dict[str, str]) -> str:
    r = await _get("https://api.coingecko.com/api/v3/ping", headers={"x-cg-demo-api-key": v["api_key"]})
    return _need(r, "Demo key valid · CoinGecko polling upgraded to 30 req/min")


async def t_youtube(v: dict[str, str]) -> str:
    r = await _get("https://www.googleapis.com/youtube/v3/videos",
                   params={"part": "id", "chart": "mostPopular", "maxResults": 1, "key": v["api_key"]})
    return _need(r, "YouTube Data API key valid")


async def t_wallet(v: dict[str, str]) -> str:
    if not re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}", v["address"]):
        raise ValueError("Not a valid Solana address")
    return "Address saved (read-only tracking; never a private key)"


CATALOG: list[Connector] = [
    # ---- running automatically (no key) ----
    Connector("pumpportal", "PumpPortal", "On-chain", "keyless", "Real-time pump.fun launches, trades and migrations over one WebSocket.",
              "New launches feed, graduation feed, live trades", 1, "https://pumpportal.fun/data-api/real-time", health_name="pumpportal"),
    Connector("dexscreener", "DexScreener", "On-chain", "keyless", "Pairs, prices, volume, liquidity, txns, token profiles and paid boosts across 80+ chains.",
              "Hot tokens table, price ticks, boost risk flag", 1, "https://docs.dexscreener.com/api/reference", health_name="dexscreener"),
    Connector("geckoterminal", "GeckoTerminal", "On-chain", "keyless", "Trending pools, new pools and OHLCV candles.",
              "Trending panel, token charts", 1, "https://apiguide.geckoterminal.com", health_name="geckoterminal"),
    Connector("rugcheck", "RugCheck", "Safety", "keyless", "Risk score, mint/freeze authority, LP lock, top holders, insiders.",
              "Safety report on every token", 1, "https://api.rugcheck.xyz/swagger/index.html", health_name="rugcheck"),
    Connector("coinbase", "Coinbase market data", "Market", "keyless", "Live BTC/ETH/SOL ticker WebSocket.",
              "Market regime bar, SOL→USD", 1, "https://docs.cdp.coinbase.com/exchange/docs/websocket-overview", health_name="coinbase"),
    Connector("jupiter", "Jupiter Price API", "On-chain", "keyless", "USD prices for any SPL token.",
              "Price cross-check", 1, "https://dev.jup.ag/docs/price-api", health_name="jupiter"),
    Connector("feargreed", "Fear & Greed (alternative.me)", "Market", "keyless", "Crypto Fear & Greed index.",
              "Market regime", 1, "https://alternative.me/crypto/fear-and-greed-index/", health_name="feargreed"),
    Connector("defillama", "DeFiLlama", "Market", "keyless", "Solana DEX volume and trend.",
              "Market regime (memecoin activity)", 1, "https://defillama.com/docs/api", health_name="defillama"),
    Connector("coingecko_public", "CoinGecko (public)", "Market", "keyless", "Trending coins and meme-category market cap (strict keyless limits).",
              "Trending panel, rotation", 1, "https://docs.coingecko.com", health_name="coingecko"),
    Connector("polymarket", "Polymarket", "News", "keyless", "Top prediction markets by 24h volume; sudden odds swings = breaking news.",
              "Breaking-news detection", 1, "https://docs.polymarket.com", health_name="polymarket"),
    Connector("kalshi", "Kalshi", "News", "keyless", "Open regulated prediction markets (public market data).",
              "Breaking-news detection", 1, "https://docs.kalshi.com", health_name="kalshi"),
    Connector("rss", "News, Reddit & Google Trends RSS", "News", "keyless",
              "CoinDesk, Cointelegraph, Decrypt, The Block, Bloomberg, Reuters/AP via Google News, Reddit subreddit RSS, Google Trends trending-now. Edit radar/config/sources.yaml.",
              "News feed, mainstream-attention check", 1, None, health_name="rss"),
    Connector("bluesky", "Bluesky firehose (Jetstream)", "Social", "keyless",
              "Every public Bluesky post in real time, filtered for $cashtags, contract addresses and memecoin talk.",
              "Narratives, CA detection, mention velocity", 3, "https://docs.bsky.app/blog/jetstream", health_name="bluesky"),
    Connector("4chan", "4chan /biz/", "Social", "keyless", "Official read-only catalog API (1 req/s rule respected) — where many memecoin calls start.",
              "Narratives, CA detection", 3, "https://github.com/4chan/4chan-API", health_name="4chan_biz"),
    Connector("goplus", "GoPlus Security", "Safety", "keyless", "Token security for EVM chains (Base, BSC, Ethereum…): mintable, honeypot, taxes, holders, LP lock.",
              "Safety report + vetoes for non-Solana tokens", 2, "https://docs.gopluslabs.io", health_name="goplus"),
    Connector("ff_calendar", "Macro calendar (ForexFactory)", "News", "keyless", "This week's high/medium-impact macro events (FOMC, CPI, NFP…).",
              "Upcoming catalysts in the daily brief", 6, None, health_name="ff_calendar"),
    Connector("solana_rpc", "Solana RPC", "On-chain", "keyless", "Public mainnet RPC (or Helius if connected) for read-only wallet holdings.",
              "Your holdings + Rug Shield on them", 6, "https://solana.com/docs/rpc", health_name="solana_rpc"),
    Connector("jupiter_recent", "Jupiter new tokens", "On-chain", "keyless", "Newest tokens with organic score, holder count and audit flags.",
              "Discovery, trending panel", 1, "https://dev.jup.ag/docs/token-api", health_name="jupiter_recent"),
    # ---- need you ----
    Connector("anthropic", "Anthropic (Claude API)", "AI", "key", "Claude Haiku classifies posts into narratives; Sonnet writes signal reasons and the daily brief.",
              "Narrative extraction, signal write-ups, AI brief, Ask Radar", 3, "https://console.anthropic.com/settings/keys",
              "Console → API Keys → Create key. Set a monthly spend limit in the console too.", "pay per use (cents/day at Haiku rates)",
              [Field("api_key", "API key", env="ANTHROPIC_API_KEY", placeholder="sk-ant-...")], t_anthropic, "anthropic"),
    Connector("x", "X (Twitter) API", "Social", "key", "VIP watchlist (Trump, Musk, CZ, KOLs, news outlets) + cashtag/keyword search. The #1 catalyst source.",
              "FLASH alerts, narrative detection", 3, "https://developer.x.com/en/portal/dashboard",
              "Developer portal → create a Project & App → Keys and tokens → Bearer Token. Buy pay-per-use credits; Radar shows $ spent today and enforces your daily cap.",
              "paid (pay-per-use credits)", [Field("bearer_token", "Bearer token", env="X_BEARER_TOKEN"),
                                              Field("daily_budget_usd", "Daily budget cap (USD)", secret=False, placeholder="5", optional=True)], t_x, "x"),
    Connector("telegram_user", "Telegram channels (reader)", "Social", "key", "Reads PUBLIC alpha/call/news/launch channels with your own Telegram account (Telethon). Free.",
              "Mention velocity of CAs and tickers", 3, "https://my.telegram.org/apps",
              "Log in at my.telegram.org → API development tools → create app → copy api_id and api_hash. Phone number is used once for the login code.",
              "free", [Field("api_id", "api_id", secret=False, env="TELEGRAM_API_ID"), Field("api_hash", "api_hash", env="TELEGRAM_API_HASH"),
                       Field("phone", "Phone (+country code)", env="TELEGRAM_PHONE"),
                       Field("channels", "Channels to watch (comma separated @names)", secret=False, optional=True)], t_telegram_user, "telegram"),
    Connector("telegram_bot", "Telegram alert bot", "Alerts", "key", "Sends FLASH / BUY / rug alerts to your phone.",
              "Alerts", 2, "https://t.me/BotFather",
              "Message @BotFather → /newbot → copy token. Then message your bot once and open https://api.telegram.org/bot<TOKEN>/getUpdates to read your chat id.",
              "free", [Field("bot_token", "Bot token", env="TELEGRAM_BOT_TOKEN"), Field("chat_id", "Chat id", secret=False, env="TELEGRAM_CHAT_ID")], t_telegram_bot),
    Connector("ntfy", "ntfy.sh phone push", "Alerts", "key", "Free phone push notifications, no account needed.",
              "Alerts", 2, "https://ntfy.sh", "Install the ntfy app, subscribe to a long random topic name, paste the same name here.",
              "free", [Field("topic", "Topic name", env="NTFY_TOPIC"), Field("server", "Server", secret=False, optional=True, placeholder="https://ntfy.sh")], t_ntfy),
    Connector("discord", "Discord webhook", "Alerts", "key", "Posts alerts into a Discord channel.",
              "Alerts", 2, "https://support.discord.com/hc/en-us/articles/228383668", "Channel settings → Integrations → Webhooks → New → Copy URL.",
              "free", [Field("webhook_url", "Webhook URL", env="DISCORD_WEBHOOK_URL")], t_discord),
    Connector("helius", "Helius (Solana RPC)", "On-chain", "key", "Holder lists, wallet & deployer history, account webhooks.",
              "Deployer reputation, smart-money wallets, holder growth", 2, "https://dashboard.helius.dev/signup",
              "Sign up → Dashboard → API Keys → copy.", "free tier", [Field("api_key", "API key", env="HELIUS_API_KEY")], t_helius, "helius"),
    Connector("birdeye", "Birdeye", "On-chain", "key", "Token overview, top traders, holders.",
              "Smart-money discovery, holder data", 4, "https://bds.birdeye.so", "Sign up → API keys.", "free tier (limited)",
              [Field("api_key", "API key", env="BIRDEYE_API_KEY")], t_birdeye),
    Connector("coingecko", "CoinGecko demo key", "Market", "key", "Raises CoinGecko from ~5 to 30 req/min; categories for rotation heatmap.",
              "Trending, rotation heatmap", 1, "https://www.coingecko.com/en/developers/dashboard", "Developer dashboard → create Demo API key.",
              "free", [Field("api_key", "Demo API key", env="COINGECKO_API_KEY")], t_coingecko),
    Connector("reddit", "Reddit API (OAuth)", "Social", "key", "Upgrades Reddit RSS to the API: new + rising posts across 8 subs with scores and comment counts.",
              "Social buzz", 3, "https://www.reddit.com/prefs/apps", "Create app → type 'script' → copy client id (under the name) and secret.",
              "free", [Field("client_id", "Client id", secret=False, env="REDDIT_CLIENT_ID"), Field("client_secret", "Client secret", env="REDDIT_CLIENT_SECRET")], t_reddit, "reddit_api"),
    Connector("neynar", "Farcaster via Neynar", "Social", "key", "Farcaster casts and trending feed (Base meme culture).",
              "Social buzz", 3, "https://dev.neynar.com", "Sign up → copy API key.", "free tier",
              [Field("api_key", "API key", env="NEYNAR_API_KEY")], t_neynar, "farcaster"),
    Connector("youtube", "YouTube Data API", "Social", "key", "Trending videos — confirms a meme is going mainstream.",
              "Mainstream confirmation", 3, "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
              "Google Cloud → enable YouTube Data API v3 → Credentials → API key.", "free quota",
              [Field("api_key", "API key", env="YOUTUBE_API_KEY")], t_youtube, "youtube"),
    Connector("wallet", "Your wallet (read-only)", "You", "key", "Your PUBLIC address so Radar can watch your holdings for rug warnings and exits. Never a private key or seed.",
              "Rug Shield on holdings, P&L", 6, None, "Copy the public address from Phantom/Axiom.", "free",
              [Field("address", "Public Solana address", secret=False, env="WALLET_ADDRESS")], t_wallet),
    # ---- not connectable (explained) ----
    Connector("truthsocial", "Truth Social", "Social", "info", "No official public API; its terms forbid automated access, so Radar doesn't scrape it.",
              "—", 3, None, "Workaround: X and Telegram mirror accounts usually repost Trump's Truth posts within seconds — add them to the X VIP list."),
    Connector("tiktok", "TikTok", "Social", "info", "Only the Research API (academic approval) exists; no free trending API.",
              "—", 3, "https://developers.tiktok.com/products/research-api/", "If you get Research API access, add it under 'Add your own'."),
    Connector("terminals", "Axiom · Photon · GMGN · BullX", "Trading", "info", "No public data APIs. Radar generates one-click deep links on every token instead.",
              "Deep links (built in)", 1, None),
]
BY_ID = {c.id: c for c in CATALOG}


class ConnectorStore:
    def __init__(self, db: DB) -> None:
        self.db = db
        self.listeners: list[Callable[[str, dict[str, str]], Awaitable[None]]] = []

    async def values(self, cid: str) -> dict[str, str]:
        """Saved values, falling back to env vars."""
        c = BY_ID[cid]
        row = await self.db.one("SELECT secrets_enc FROM connectors WHERE id=?", (cid,))
        saved = secrets.decrypt(row["secrets_enc"]) if row and row["secrets_enc"] else {}
        out = {}
        for f in c.fields:
            v = saved.get(f.name) or (os.environ.get(f.env) if f.env else None)
            if v:
                out[f.name] = v
        return out

    async def configured(self, cid: str) -> bool:
        c = BY_ID[cid]
        vals = await self.values(cid)
        return all(f.name in vals for f in c.fields if not f.optional)

    async def save(self, cid: str, incoming: dict[str, str]) -> None:
        c = BY_ID[cid]
        if c.kind != "key":
            raise ValueError("This connector has nothing to configure")
        row = await self.db.one("SELECT secrets_enc FROM connectors WHERE id=?", (cid,))
        cur = secrets.decrypt(row["secrets_enc"]) if row and row["secrets_enc"] else {}
        names = {f.name for f in c.fields}
        for k, v in incoming.items():
            if k in names and v is not None and not str(v).startswith("••••••"):
                v = str(v).strip()
                if v:
                    cur[k] = v
                else:
                    cur.pop(k, None)
        await self.db.upsert("connectors", {"id": cid, "secrets_enc": secrets.encrypt(cur), "status": "saved"}, "id")
        for fn in self.listeners:
            await fn(cid, await self.values(cid))

    async def remove(self, cid: str) -> None:
        await self.db.exec("DELETE FROM connectors WHERE id=?", (cid,))
        for fn in self.listeners:
            await fn(cid, await self.values(cid))

    async def test(self, cid: str) -> dict[str, Any]:
        c = BY_ID[cid]
        if not c.test:
            raise ValueError("Nothing to test")
        vals = await self.values(cid)
        missing = [f.label for f in c.fields if not f.optional and f.name not in vals]
        if missing:
            status, msg = "error", f"Missing: {', '.join(missing)}"
        else:
            try:
                status, msg = "ok", await c.test(vals)
            except (httpx.HTTPError, ValueError, KeyError) as e:
                status, msg = "error", f"{type(e).__name__}: {e}"[:300]
        await self.db.upsert("connectors", {"id": cid, "status": status, "last_test": time.time(), "last_msg": msg}, "id")
        return {"status": status, "message": msg}

    async def list(self) -> list[dict[str, Any]]:
        rows = {r["id"]: r for r in await self.db.all("SELECT id, status, last_test, last_msg FROM connectors")}
        out = []
        for c in CATALOG:
            vals = await self.values(c.id) if c.kind == "key" else {}
            row = rows.get(c.id) or {}
            h = REGISTRY.get(c.health_name) if c.health_name else None
            if c.kind == "keyless":
                state = h.status() if h else "pending"
            elif c.kind == "info":
                state = "unavailable"
            elif not await self.configured(c.id):
                state = "needs_key"
            else:
                state = {"ok": "connected", "error": "error"}.get(row.get("status") or "", "saved")
                if h and state == "connected" and h.status() in ("degraded", "down"):
                    state = "error"
            out.append({
                "id": c.id, "name": c.name, "category": c.category, "kind": c.kind, "what": c.what,
                "used_for": c.used_for, "phase": c.phase, "signup_url": c.signup_url, "how": c.how, "cost": c.cost,
                "state": state, "last_test": row.get("last_test"), "last_msg": row.get("last_msg"),
                "health": h.snapshot() if h else None, "testable": c.test is not None,
                "fields": [{"name": f.name, "label": f.label, "secret": f.secret, "optional": f.optional,
                            "placeholder": f.placeholder,
                            "value": (secrets.mask(vals[f.name]) if f.secret else vals[f.name]) if f.name in vals else "",
                            "from_env": bool(f.env and os.environ.get(f.env))} for f in c.fields],
            })
        return out
