# Memecoin Radar

A personal, real-time memecoin intelligence terminal. It catches new launches, graduations, trending pools and breaking news as they happen, attaches a safety report to every token, and links you straight into your own trading terminal.

> ⚠ **Signals are probabilistic. Most memecoins go to zero. Only risk money you can lose.**
> Radar is a decision tool, not a bot. It never asks for or holds private keys or seed phrases, and it never places trades. Wallet tracking is read-only, from a public address.

## Deploy to Render (always-on, ~5 minutes)

1. Push this repo to GitHub (already done if you're reading this there).
2. In Render: **New → Blueprint**, then pick this repo and branch. Render reads `render.yaml` at the repo root. It defines `memecoin-radar` (Docker, Starter plan, 2 GB persistent disk at `/app/data`) next to the existing PULSE service. Delete the PULSE block if you don't want it.
3. When prompted, set **`RADAR_PASSWORD`** (required, because the URL is public). The other prompted keys are optional; leave them blank and add them later on the Connectors page.
4. Click **Apply**. The first build takes ~3–4 minutes. Render health-checks `/api/healthz`.
5. Open `https://memecoin-radar-xxxx.onrender.com`, log in, then go to **Connectors** and paste your keys (X, Anthropic, Telegram…). Keys are encrypted with the `RADAR_SECRET` that Render generated.
6. Phone: open the URL in Safari/Chrome → *Add to Home Screen* (it installs as an app). Add an ntfy topic or Telegram bot for push alerts.

Why Starter rather than Free: Radar holds live WebSockets and polls continuously, and keeps its database on a disk. Free instances sleep after 15 minutes and can't attach disks. With a disk attached Render deploys with a few seconds of downtime, which is fine for a personal tool. To deploy anywhere else (Railway, Fly, a VPS), run the same Docker image with a volume on `/app/data`, plus `RADAR_PASSWORD`.

## Run it locally (one command)

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

## What it does

**Real coins only.** Every token, price, post and number on screen comes from a live source and shows its age. There is no demo mode. When a source is down, its fields show "—" or STALE, never a guess. The only simulated input in the codebase is the FLASH latency test fixture. It is off unless `RADAR_ENABLE_FIXTURES=1` is set, and it is labelled TEST wherever it appears.

| Page (shortcut) | What you get |
|---|---|
| **Trending** (`t`) | Coins climbing **steadily** in market cap. Ranked by a log-regression fit on Radar's own price history: slope %/hour, steadiness (R²) and max dip, with vertical one-candle spikes excluded. Each card shows a sparkline, the coin's **narratives**, safety, and a **"why it's moving"** drawer. Toggle Cards / **Heat map** (area = 1h volume, colour = 1h change). Filter by 2/4/8h trend, liquidity and narrative category. |
| **Launching** (`l`) | New coins **exploding** right now. Volume pace is accelerating (5m×12 vs 1h, or 1h×6 vs 6h), with market cap and liquidity jumping over 15 minutes, plus pump.fun bonding-curve rockets taken from the live trade stream. Each card shows the launch quality: dev buy %, sniper/bundle share, unique buyers and dev sells. **Launch Watch** sits in the side panel. |
| **Dashboard** (`d`) | A **live event tape** (signals, FLASH alerts, graduations, smart money, narrative births, Launch Watch hits, plus a launch ticker and events/min). Hot tokens with a live **Radar Score + verdict**, sparklines, values that flash green or red as they change, and quick-filter chips (Safe, under 1h old, Graduated, BUY, $1M+). Next to it, the **Narrative Radar**: social and web narratives that could become coins, ranked by *coin potential*, with "no coin yet" flags and one-click Launch Watch, and a *Web pulse* tab (Google Trends, news, Polymarket swings). Server-side filters: ticker/name/CA, chain, verdict, market cap min/max, 1h volume, age, freshness, safe-only, graduated-only, hide paid boosts. Also: new pump.fun launches (live), graduations, trending (GeckoTerminal on Solana/Base/BSC/ETH, DexScreener boosts/profiles/takeovers/ads, CoinGecko, Jupiter new tokens), breaking news & social, prediction markets, and a market-regime bar. |
| **Signals** (`s`) | Chronological BUY / WATCH / AVOID cards. Each has the score breakdown, confidence, risk grade A–F, reasons and risks, hard vetoes, entry zone, position size from your risk settings, take-profit ladder, stop, time stop, links, a Claude write-up and its paper-trade outcome. |
| **Narratives** (`n`) | Active narratives with lifecycle (BIRTH → IGNITION → PEAK → FADING), a velocity sparkline, z-score, sources, bot share and VIP/breaking/listing flags. Matched tokens are shown with **real vs copycat** ranking. Detail view: buzz by platform, top voices, posts. |
| **Social** (`f`) | The live stream of every ingested post (X, Telegram, Bluesky, 4chan, Reddit, Farcaster, YouTube, news, Google Trends, Polymarket swings, your custom sources), plus per-source rates and the FLASH log with measured post-to-screen latency. |
| **Smart money** (`w`) | Auto-discovered profitable early wallets (win rate, average multiple, hold time), KOL wallets you add, and the live trades of followed wallets. Shill-and-dump alerts fire when a KOL sells a token they are posting about. |
| **Top wallets** (`o`) | The **top 1,000 wallets ranked by 24h, 7d and 30d return**, built from every pump.fun trade Radar observes (PumpPortal) plus the recent trades of the 40 hottest PumpSwap/Raydium/Meteora pools (GeckoTerminal, no key), so graduated coins count too. With a Birdeye key, a **Birdeye** tab adds Birdeye's own top Solana traders (today, yesterday, 7d by P&L) and the top traders of the hottest coins; the best 300 of those are followed live too. pump.fun, Axiom, GMGN, Photon, BullX and DexScreener's Top traders tab have no public API for trader data. Each wallet gets an average-cost ledger per token: return = realized P&L ÷ cost basis sold, with profit in SOL, open P&L marked at current prices, win rate and a bot flag. Sells of tokens bought before Radar was watching never count as profit. The top 1,000 (configurable) are streamed live on PumpPortal, so their trades on any pump.fun token feed the ranking. Click a wallet for its daily P&L and positions; one click turns on smart-money alerts for it. **Every trade a followed top wallet makes flashes on screen** (a card with rank, side, size and the wallet's return, a sound, and an OS notification when the tab is in the background), shows in the **Top wallet trades** hero on the Dashboard, and is drawn on the coin's chart (gold ▲ entries, red ▼ exits). Flash size/side filters and sound are set from the hero. Trades of 1 SOL or more are also pushed to Telegram/ntfy/Discord (capped at 12 a minute), and 3+ top wallets buying the same coin within 10 minutes fires a full-screen FLASH. Tune thresholds under `leaderboard:` in `config/scoring.yaml`. |
| **Scorecard** (`p`) | Shows **whether the strategy is profitable on paper** before you risk money. Hit rate, average/median return, expectancy and max drawdown, split by verdict, score bucket and category. Also: a BUY equity curve, a backtest replay with any config override, and auto-tuning of the weights with one-click apply. |
| **Risk** (`r`) | Bankroll, max % per trade, max open positions, daily loss limit and **cooldown lock**. Track your manual positions with TP/stop alerts and P&L, keep a trade journal, and see your read-only wallet holdings (the held tokens are added to Rug Shield). |
| **Rotation & Brief** (`b`) | A heatmap of capital and attention by category over 1h/6h/24h, and an AI brief (morning + evening, or on demand), sent to your alert channels. |
| **Ask** (`a`) | Claude answers questions using tools that query Radar's own database. |
| **Token page** | Candles with **social posts, signals and smart-money trades drawn as chart markers**. Also: RugCheck/GoPlus safety, the signal card, live trades, smart-money activity, the social timeline, custom alert rules, "I bought this" position tracking and deep links. |
| **Connectors** (`c`) | Every source with its live status. Key entry with a real test call (keys encrypted at rest), Telegram sign-in, and **Add your own**: any RSS/JSON/WebSocket link. |
| **Settings** (`g`) / **Health** (`h`) | Scoring weights, thresholds and vetoes; VIP/search/channel lists; the API cost meter; a test-alert button. Health shows per-adapter status, latency and rate-limit headroom. |

**Every coin's narratives.** For anything trending or launching, Radar researches the story automatically every ~20 minutes. Sources: posts it has already captured (X, Telegram, Bluesky, 4chan, Reddit, news), the coin's own DexScreener profile, and live Google News, Reddit and Bluesky searches (X too, on request). Claude turns that evidence into named narratives with explanations, strength scores and cited sources; without an Anthropic key, keyword clustering does it.

**Also new:** a **⌘K command palette** (jump to any coin, CA, narrative or page; falls back to live DexScreener search), **Launch Watch** (arm tickers or phrases; a FLASH alert fires the moment a matching coin launches), and the **heat map**. The UI is a full redesign: glass panels, animated filters, number tickers, page transitions and a sidebar with keyboard shortcuts.

**Alerts** go to a full-screen FLASH overlay, browser notifications and in-app toasts, plus Telegram, ntfy (phone push) and Discord when those are connected. Alert kinds: FLASH (a VIP posts a CA, or a narrative velocity breakout), BUY SIGNAL, take-profit/stop/time exits, Rug Shield (liquidity pulled, dev selling, a top holder dumping, authorities re-enabled, rugged), smart-money clusters, shill-and-dump, and your custom rules.

**Scoring** is configured in `config/scoring.yaml`, editable live in Settings. Sub-scores: narrative 30%, catalyst 15%, momentum 20%, smart money 15%, safety 20%, multiplied by a market-regime factor. **Hard vetoes always give AVOID:** active mint authority, active freeze authority, top-10 holders above the threshold, liquidity below the minimum, a deployer linked to past rugs, a likely fake of a VIP coin, rugged, or RugCheck risk too high. Every signal is stored with the exact inputs that produced it, so backtests replay the real data. The price drivers behind each sub-score (liquidity withdrawal and depth, holder concentration, token social volume, dev wallet activity, listings) are catalogued in [PRICE-DRIVERS.md](PRICE-DRIVERS.md).

## Sources

**Running automatically, no key needed:** PumpPortal WebSocket (launches, trades, migrations, wallet trades). DexScreener (pairs, profiles, boosts, community takeovers, ads, search). GeckoTerminal (trending/new pools on four chains, OHLCV). RugCheck (Solana safety) and GoPlus (EVM safety). Coinbase ticker WS, Jupiter price and new tokens, Fear & Greed, DeFiLlama, CoinGecko, Polymarket (including odds-swing detection), Kalshi, the ForexFactory macro calendar and Solana RPC. On the social side: the **Bluesky Jetstream firehose** (every public post in real time, filtered for crypto), the **4chan /biz/** official API, and RSS. The RSS set covers CoinDesk, Cointelegraph, Decrypt, The Block, Bloomberg, Reuters/AP via Google News, exchange-listing searches (Binance, Coinbase, Robinhood, Upbit), six subreddits, Mastodon hashtags and Google Trends (US, UK). Edit `config/sources.yaml` to change the feeds.

**Needs you** (paste on the Connectors page or in `.env`):

| Connector | Why | Cost |
|---|---|---|
| X API bearer token | VIP watchlist (one batched search with `since_id`) + keyword search. The #1 catalyst source. Cost meter + daily cap. | pay-per-use credits |
| Anthropic | Haiku classifies posts into narratives; Sonnet writes signal write-ups, the brief and Ask Radar answers. Daily $ cap. | pay-per-use |
| Telegram api_id/api_hash + phone | Reads public alpha/news/launch channels as you (sign in once on the Connectors page) | free |
| Telegram bot token + chat id | Phone alerts | free |
| ntfy topic / Discord webhook | Phone push / Discord alerts | free |
| Helius | Swap history of followed wallets (beyond pump.fun); faster RPC | free tier |
| CoinGecko demo key | 30 req/min instead of ~5 | free |
| Reddit app | API access to new + rising posts in 8 subs | free |
| Neynar | Farcaster trending | free tier |
| YouTube Data API | Mainstream confirmation | free quota |
| Birdeye | Top-trader leaderboards (Top wallets → Birdeye tab), followed live | free tier |
| Wallet public address | Your holdings + Rug Shield on them (read-only) | free |

**Not connectable:** Truth Social has no public API and its terms forbid automated access, so add X accounts that mirror Trump's posts instead. TikTok only offers a Research API that needs approval. Axiom, Photon, GMGN and BullX have no data APIs, so Radar uses deep links only.

## FLASH latency test (definition of done)

`cd backend && .venv/bin/python -m pytest tests/test_e2e.py -k flash` starts the app against local fake upstreams with `RADAR_ENABLE_FIXTURES=1`. It posts a simulated VIP message containing a CA, then asserts that the FLASH reaches the UI WebSocket **and** the Telegram bot API in under 5 seconds. In the live app, every real FLASH logs its actual post-to-screen latency on the Social page.

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

Set `RADAR_PASSWORD` and the whole API, live socket and UI data sit behind a login (HttpOnly session cookie, 30 days; 10 attempts per minute per IP). Without it, the app is open, so docker-compose binds to `127.0.0.1` only. The only unauthenticated endpoint is `/api/healthz` (liveness, no data). Saved keys are encrypted with AES-256-GCM using `RADAR_SECRET` or an auto-generated `data/secret.key`.

## Status

All six phases are built: the data spine, safety + scoring + alerts, the social engine with FLASH, smart money, paper trading/scorecard/backtest/tuning, and the trader tools (risk manager, rotation, brief, Ask Radar).
