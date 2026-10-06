# Memecoin Radar

A personal, real-time memecoin intelligence terminal. It catches new launches, graduations, trending pools and breaking news as they happen, attaches a safety report to every token, and links you straight into your own trading terminal.

> ⚠ **Signals are probabilistic. Most memecoins go to zero. Only risk money you can lose.**
> Radar is a decision tool, not a bot. It never asks for or holds private keys or seed phrases, and it never places trades. Wallet tracking is read-only, from a public address.

## Run it (one command)

```bash
cd radar
cp .env.example .env        # optional — Phase 1 needs no keys
docker compose up --build   # → http://localhost:8000
```

Without Docker:

```bash
cd radar/web && npm ci && npm run build          # builds the UI to web/out
cd ../backend && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m radar                        # → http://localhost:8000 (UI + API + live socket)
```

For UI development with hot reload, run the backend as above and `cd web && npm run dev` (http://localhost:3000; it talks to :8000).

Then open **Connectors** (press `c`) to add keys or plug in your own sources. Open **Health** (press `h`) to see every adapter's status, latency and rate-limit headroom.

## What's in Phase 1 (live data spine)

| Screen | What you get |
|---|---|
| **Dashboard** | Hot tokens table, sortable by volume (5m/1h/24h), liquidity, market cap, % change, age, buy/sell and holders. Each row shows safety chips (MINT / FRZ / LP / T10, plus RUGGED), a GRAD badge for pump.fun graduates and a ⚡ badge for paid boosts. Also: a live **new launches** feed, a **graduated** feed, **trending** (GeckoTerminal trending/new, DexScreener boosts/profiles, CoinGecko), **breaking news & social** (contract addresses and $cashtags detected) and **prediction markets**. A market bar shows BTC/ETH/SOL live, Fear & Greed, Solana DEX volume and meme-sector market cap. |
| **Token page** (`/token?a=<CA>`) | Copy-CA button and deep links to DexScreener, RugCheck, Axiom, Photon, GMGN, BullX, Solscan and pump.fun. Stat tiles, a GeckoTerminal candle chart (1m–1d), a full RugCheck safety report (authorities, LP lock, top-10 holders excluding AMM vaults, insiders, risks), live trades, pairs and a watch button. Opening a token promotes it to the fastest refresh tier and subscribes to its live trades. |
| **Connectors** | Every source: what it is, whether it's running, and, for those that need you, where to get the key, a paste box and a real **Test** call. **Add your own** accepts any RSS/Atom feed, JSON API or WebSocket link, or a website homepage (its RSS feed is found automatically). |
| **Health** | Per-adapter status, p50/p95 latency, requests in the last hour, errors, 429s and token-bucket headroom. |

**Rules the code enforces.** Every number on screen comes from a named source and carries an "as of" age that turns amber, then red and STALE, as it ages. Nothing is estimated or made up: a source that is down shows as down and its fields show "—". Rate budgets sit below each API's published free limits. Hitting a 429 pauses that bucket, and retries back off exponentially. The DexScreener budget goes to the hottest tokens first: viewed > watchlist > graduated/trending/boosted > fresh launches.

## Sources

**Running automatically, no key needed:** PumpPortal WebSocket (one connection), DexScreener, GeckoTerminal, RugCheck, Coinbase ticker WS, Jupiter price, Alternative.me Fear & Greed, DeFiLlama, CoinGecko public, Polymarket, Kalshi, and RSS feeds. The RSS set covers CoinDesk, Cointelegraph, Decrypt, The Block, Bloomberg, Reuters/AP via Google News, topic searches, Reddit subreddit RSS and Google Trends "trending now". Edit `config/sources.yaml` to change the feeds.

**Needs you** (paste on the Connectors page or in `.env`):

| Connector | Why | Cost |
|---|---|---|
| Anthropic | Narrative extraction (Haiku), signal write-ups and daily brief (Sonnet) | pay-per-use |
| X API bearer token | VIP watchlist + cashtag search (the #1 catalyst source), with a daily $ cap | pay-per-use credits |
| Telegram api_id/api_hash | Read public alpha/news/launch channels | free |
| Telegram bot token + chat id | Phone alerts | free |
| ntfy topic / Discord webhook | Phone push / Discord alerts | free |
| Helius | Holders, deployer history, wallet webhooks | free tier |
| Birdeye | Top traders / holders | free tier |
| CoinGecko demo key | 30 req/min instead of ~5 | free |
| Reddit OAuth app | Comment velocity at higher limits | free |
| Neynar | Farcaster | free tier |
| YouTube Data API | Mainstream confirmation | free quota |
| Wallet public address | Rug Shield on your holdings (read-only) | free |

**Not connectable:** Truth Social has no public API and its terms forbid automated access, so watch X/Telegram mirror accounts instead. TikTok only offers a Research API that needs approval. Axiom, Photon, GMGN and BullX have no data APIs, so Radar gives you deep links only.

## Layout

```
radar/
  backend/radar/      FastAPI app, tracker (scheduler + ingest), adapters/, connectors, custom sources
  backend/tests/      unit tests + end-to-end test against fake upstreams (tests/fake_upstream.py)
  web/                Next.js 16 + Tailwind + lightweight-charts (static export served by the backend)
  config/sources.yaml keyless RSS feeds
```

Tests: `cd backend && .venv/bin/python -m pytest`

## Security note

The app has no login. Docker binds it to `127.0.0.1` only. If you host it remotely, put it behind authentication (for example Cloudflare Access or Tailscale). Saved keys are encrypted with AES-256-GCM using `RADAR_SECRET` or an auto-generated `data/secret.key`.

## Roadmap

1. ✅ Live data spine + Connectors
2. Safety gate & Radar Score v1, hard vetoes (an active mint authority is always AVOID), signal cards, Telegram/browser/ntfy alerts
3. Social engine: X VIP + search with cost meter, Telegram, Reddit, Claude narrative extraction, clustering, token matching, real-vs-fake detection, FLASH mode with latency logging
4. Smart money & KOL wallets, shill-and-dump detection
5. Paper trading, scorecard, backtest replay, weight tuning
6. Risk & Exit Manager, rotation heatmap, AI daily brief, Ask Radar
