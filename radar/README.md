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
| **Home** (`d`) | The front page. **Hero:** track the top 1,000 traders, with ring gauges (wallet pool out of 5,000, ranked out of 1,000, trades/hour, 24h volume) and a live feed of every buy and sell by ranked wallets. **What they're buying:** coins with the most distinct top-1,000 buyers and their net $ flow (1h / 24h). **Leaderboard podium** (top 3 + 4–10, with P&L curves). Then the full **terminal** (hot tokens, Narrative Radar, launches, …). |
| **Snipe** (`x`) | The sniping column, full screen. Every new pump.fun launch is scored **from its first trade** by six live detectors and pushed over the socket in milliseconds: **Alpha entry** (Top-1,000 ranked, followed or smart wallets buying in the first minutes), **Curve velocity** (SOL/min into the bonding curve, buyer acceleration and a **graduation ETA** from the curve's real trajectory), **Organic flow** (bundles: wallets taking a big slice of supply in the creation block, identical bot-sized buys, top-3 concentration), **Dev track record** (every launch by that deployer Radar saw in 30 days: graduated count, best peak, plus live dev selling), **Meta match** (the name fits a meta that's hot right now, or clones a trending ticker) and **Social spread** (distinct authors/sources posting the CA or $ticker, VIPs). Tiers: SNIPE / WATCH / PASS / TRAP (bundled, dev dumped, serial launcher). Three live lanes (Snipe, Heating, Just born), filters (min score, hide bundles, top wallets in, proven dev, max age), sound + desktop alerts, Telegram/ntfy/Discord pushes, copy-CA and one-click links to Axiom / Photon / BullX / GMGN / pump.fun. Radar never trades or holds keys. A compact **Snipe column** also sits on the Home terminal and each token page shows its live snipe read. |
| **Snipe 2.0** | Every card now carries the **trader-terminal holder strip**, computed live from Radar's own copy of the coin's trade stream: holders, top-10 %, dev holding (or *dev sold*), snipers %, bundlers %, pro traders (wallets from your Top Traders pool), plus socials from the coin's metadata (X / X community / Telegram / website) and its description. A **coverage** check compares the SOL Radar saw trade with the bonding curve's SOL; under 80% the metrics are marked *partial*. Each launch gets two axes, **Upside** and **Risk**, and an **appetite dial** (Safe / Balanced / Degen, keys 1-3) ranks by upside minus a risk penalty, so imperfect-but-promising coins still surface. **Strategy rail** with live match counts and graded hit rates, a **filter builder** over every metric (save any filter as a strategy, with alerts), a live **Risk × Upside map**, and lanes for *Best for you*, *Just born* and *Final stretch*. **Mayhem Mode coins are hidden everywhere** (detected by an explicit `mayhem` field, the 2B-supply signature in the create event, or a `mayhem` key in the metadata; set `HIDE_MAYHEM=0` to show them). |
| **Playbook** (`y`) | How traders pick coins, digested. Built-in strategies distilled from terminal guides and trader write-ups (Clean launch, Dev sold before the stretch, First-30-seconds momentum, Follow the pros, Narrative + people talking, Rides a hot meta, Final stretch, Community takeover, Degen lottery), each linking its sources. With a YouTube Data API key Radar searches for new strategy videos every 4h; paste the link + transcript/caption/notes of any TikTok, YouTube or X video to digest it in full (YouTube's API doesn't expose other creators' captions and TikTok has no public API, so nothing is scraped). Rules are extracted by Claude (structured output, measurable metrics only) or a built-in parser, and folded into a **Crowd consensus** strategy (weighted median of what most sources agree on). Every strategy's first match on every launch is logged with its metrics and graded on Proof. |
| **Proof** (`v`) | Receipts for every SNIPE call: time, market cap and every detector input at the moment of the call, then the real outcome over 24h — peak multiple, value 5m / 15m / 1h later, graduation (and how many minutes after the call), and when it first hit GeckoTerminal trending or DexScreener boosts. Stats: hit rate at 2× / 5× / 10×, median peak, % up after 1h, graduation rate **vs the base rate of every launch Radar saw**, % called before trending and the median lead time, plus hit rate per detector. Losers stay on the record. |
| **Top Traders** (`w`) | The leaderboard. Up to **5,000 real wallets** are pooled and the **top 1,000 ranked** over 7D / 30D / 1Y. P&L uses each wallet's average cost per coin, counting only coins whose buys Radar actually saw (no guessed cost basis). Ranking combines profit, Bayesian-smoothed win rate, median ROI and consistency, with bot/MEV patterns filtered out. Sort by P&L, ROI, win rate, volume or recency; filter by coin count; follow any wallet (alerts on every trade). **Import & sources:** paste wallet lists, pull a Dune query, and see per-source coverage and backfill progress. Replaces the old Smart Money page. |
| **Wallet** (`/wallet?a=`) | Any wallet: rank, P&L with a cumulative curve, win-rate and ROI rings, coins, trades, best trade, average hold, every position (realized/open/ROI), full trade history, live holdings via Solana RPC, follow, and a **shareable P&L card** (PNG rendered in your browser). |
| **Pulse** (`u`) | pump.fun lifecycle in three live columns: **New**, **Final stretch** (60%+ of the bonding curve) and **Migrated**. Each card shows bonding-curve progress, market cap, buyers and trades in the last 5 min, dev buy, holders, safety and narratives. Hover a column to pause it. |
| **Trending** (`t`) | Coins climbing **steadily** in market cap. Ranked by a log-regression fit on Radar's own price history: slope %/hour, steadiness (R²) and max dip, with vertical one-candle spikes excluded. Each card shows a sparkline, the coin's **narratives**, safety, and a **"why it's moving"** drawer. Toggle Cards / **Heat map** (area = 1h volume, colour = 1h change). Filter by 2/4/8h trend, liquidity and narrative category. |
| **Launching** (`l`) | New coins **exploding** right now. Volume pace is accelerating (5m×12 vs 1h, or 1h×6 vs 6h), with market cap and liquidity jumping over 15 minutes, plus pump.fun bonding-curve rockets taken from the live trade stream. Each card shows the launch quality: dev buy %, sniper/bundle share, unique buyers and dev sells. **Launch Watch** sits in the side panel. |
| **Dashboard** (`d`) | A **live event tape** (signals, FLASH alerts, graduations, smart money, narrative births, Launch Watch hits, plus a launch ticker and events/min). Hot tokens with a live **Radar Score + verdict**, sparklines, values that flash green or red as they change, and quick-filter chips (Safe, under 1h old, Graduated, BUY, $1M+). Next to it, the **Narrative Radar**: social and web narratives that could become coins, ranked by *coin potential*, with "no coin yet" flags and one-click Launch Watch, and a *Web pulse* tab (Google Trends, news, Polymarket swings). Server-side filters: ticker/name/CA, chain, verdict, market cap min/max, 1h volume, age, freshness, safe-only, graduated-only, hide paid boosts. Also: new pump.fun launches (live), graduations, trending (GeckoTerminal on Solana/Base/BSC/ETH, DexScreener boosts/profiles/takeovers/ads, CoinGecko, Jupiter new tokens), breaking news & social, prediction markets, and a market-regime bar. |
| **Signals** (`s`) | Chronological BUY / WATCH / AVOID cards. Each has the score breakdown, confidence, risk grade A–F, reasons and risks, hard vetoes, entry zone, position size from your risk settings, take-profit ladder, stop, time stop, links, a Claude write-up and its paper-trade outcome. |
| **Narratives** (`n`) | A live **meta heat map** of 45 memecoin metas (dogs, cats, frogs, AI agents, Trump/MAGA, brainrot, celebrities, streamers, Base/BNB/pump.fun ecosystems, listings, hacks, ETFs…) from `config/metas.yaml`, each scored every 20s from mentions vs baseline, new launches, DEX volume pace and price, with HOT / HEATING / COOLING status, leader coins and an alert when a meta turns hot. Below it: active narratives with lifecycle (BIRTH → IGNITION → PEAK → FADING), a velocity sparkline, z-score, sources, bot share and VIP/breaking/listing flags. Matched tokens are shown with **real vs copycat** ranking. Detail view: buzz by platform, top voices, posts. |
| **News** (`e`) | The **Newsroom**: ~70 feeds (crypto newsrooms, Google News searches for every memecoin meta, exchange listings, hacks, regulation, politics, celebrities, viral culture, Reddit, Mastodon, Google Trends) polled every 30–300s with conditional GETs and per-feed backoff. Each headline is tagged on arrival (listing, launch, hack, ETF, regulation…), scored for impact and mood, linked to coins and metas, and near-duplicates from different outlets fold into one story with an outlet count. New items stream in over the socket; listings of a named coin and official token launches raise a FLASH alert. |
| **Social** (`f`) | The live stream of every ingested post (X, Telegram, Bluesky, 4chan, Reddit, Farcaster, YouTube, news, Google Trends, Polymarket swings, your custom sources), plus per-source rates and the FLASH log with measured post-to-screen latency. |
| **Scorecard** (`p`) | Shows **whether the strategy is profitable on paper** before you risk money. Hit rate, average/median return, expectancy and max drawdown, split by verdict, score bucket and category. Also: a BUY equity curve, a backtest replay with any config override, and auto-tuning of the weights with one-click apply. |
| **Risk** (`r`) | Bankroll, max % per trade, max open positions, daily loss limit and **cooldown lock**. Track your manual positions with TP/stop alerts and P&L, keep a trade journal, and see your read-only wallet holdings (the held tokens are added to Rug Shield). |
| **Rotation & Brief** (`b`) | A heatmap of capital and attention by category over 1h/6h/24h, and an AI brief (morning + evening, or on demand), sent to your alert channels. |
| **Ask** (`a`) | Claude answers questions using tools that query Radar's own database. |
| **Token page** | Candles (GeckoTerminal history for *this* token's side of the pool, merged with Radar's own pump.fun trade stream valued at the SOL price of each trade; the last candle moves on every trade over the socket; local time; Price / Market-cap toggle; OHLC legend) with **social posts, signals and smart-money trades drawn as chart markers**. Also: RugCheck/GoPlus safety, the signal card, live trades, smart-money activity, the social timeline, custom alert rules, "I bought this" position tracking and deep links. |
| **Connectors** (`c`) | Every source with its live status. Key entry with a real test call (keys encrypted at rest), Telegram sign-in, and **Add your own**: any RSS/JSON/WebSocket link. |
| **Settings** (`g`) / **Health** (`h`) | Scoring weights, thresholds and vetoes; VIP/search/channel lists; the API cost meter; a test-alert button. Health shows per-adapter status, latency and rate-limit headroom. |

**Every coin's narratives.** For anything trending or launching, Radar researches the story automatically every ~20 minutes. Sources: posts it has already captured (X, Telegram, Bluesky, 4chan, Reddit, news), the coin's own DexScreener profile, and live Google News, Reddit and Bluesky searches (X too, on request). Claude turns that evidence into named narratives with explanations, strength scores and cited sources; without an Anthropic key, keyword clustering does it.

**Where the trader data comes from (all real, nothing estimated):** every pump.fun trade on the PumpPortal stream; trades from the 60 hottest Solana pools via GeckoTerminal (keyless); Birdeye's top traders per hot coin (key); **Helius 1-year swap backfill** per wallet, valued with daily SOL/USD candles from Coinbase (key, `HELIUS_BACKFILL_CALLS_PER_DAY`, default 3,000); your pasted lists and **Dune** queries (key). Radar does not scrape Axiom, GMGN, Phantom or pump.fun leaderboards: they have no public API and their terms forbid it. To seed the pool with last year's best traders, import a public Dune query or paste lists you've collected. Every wallet shows which sources and dates its numbers cover.

**Design:** a **light and dark theme** (toggle in the top bar; follows your OS until you pick; no flash on load), pure black, condensed uppercase display type (Barlow Condensed) over Inter, ring gauges, white pill buttons, scroll-triggered reveals, count-up numbers, a cursor spotlight on cards, top navigation with a mega-menu and a full-screen mobile menu.

**Speed:** gzip on every API response and pre-compressed, immutably cached static assets; SQLite in autocommit WAL mode with a 64 MB cache and memory-mapped I/O; stale-while-revalidate caches on heavy endpoints and charts (concurrent requests share one computation); chart requests jump ahead of background pollers in the rate limiter; WebSocket fan-out to all clients in parallel; opening a coin re-subscribes its live trades within a second; pages repaint instantly from the last response while they refresh.

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

Create an account at `/signup` (email + password, signed in straight away — no verification email; the first account is the owner) or set `RADAR_PASSWORD`, and the whole API, live socket and UI data sit behind a login (HttpOnly session cookie that stays signed in for 90 days rolling on a remembered device; 10 attempts per minute per IP). Without it, the app is open, so docker-compose binds to `127.0.0.1` only. The only unauthenticated endpoint is `/api/healthz` (liveness, no data). Saved keys are encrypted with AES-256-GCM using `RADAR_SECRET` or an auto-generated `data/secret.key`.

## Status

All six phases are built: the data spine, safety + scoring + alerts, the social engine with FLASH, smart money, paper trading/scorecard/backtest/tuning, and the trader tools (risk manager, rotation, brief, Ask Radar).

## Autopilot (demo & real money)

`/autopilot` — Radar trades its own signals.

- **Demo**: simulated fills (price impact + pump.fun / PumpPortal fees) on virtual SOL. Reset any time.
- **Real**: trades from a **separate trading wallet** Radar creates (key encrypted at rest with `RADAR_SECRET`). Fund it with
  only what you can lose; withdraw to your own wallet or export the key into Phantom (password required). Radar never asks
  for your main wallet's seed phrase. Switching to real needs `RADAR_PASSWORD` set, the password re-entered and a typed confirmation.
- Buys on: snipe score at your appetite, chosen strategies, tweet races (first coins off a tracked tweet), copy-trading
  (2+ top-ranked / followed wallets), proven devs, contract calls by S/A-tier X accounts, or a quick-buy from any Snipe card.
- Limits: SOL per buy, hard cap, max open positions, max SOL per day, daily loss limit, cooldown.
- Exits: take-profit ladder, stop loss, trailing stop, time stop, rug exit (dev dumps / insiders / TRAP), panic sell.
- Execution: PumpPortal Local Transaction API (pump.fun, PumpSwap, Raydium) signed locally and sent through your RPC (Helius
  when connected); Jupiter as fallback. Fills are read back from the chain. Telegram: `/autopilot`, `/autopilot demo|off`, `/panic`.

### The Nebula: a 4-brain council over every trade

- **Exact fills.** Demo trades, ghost trades and position marks use pump.fun's constant-product bonding curve
  (`radar/curve.py`): your buy's price impact comes back when you sell, so only fees (≈1.5% each way) are a round-trip
  cost, and a position is valued at what dumping it now would return. (Before v10 impact was charged on the way in AND
  out and positions were marked at the pre-buy price — bigger trades started 5–10% down and stopped out at once, and
  everything learned under that model was reset.)
- **Speed.** Exits are re-checked the instant a held coin trades; trades reach the sniper and brain before they're
  written (writes batch every 0.25 s); Surreal / Hyper never pause on a losing streak — the circuit breakers guard the pot.
- **Referee** — a brain over the brains: a stacked model that learns which combinations of the three votes (plus style,
  regime, heat, feed coverage, tape freshness) actually ended in profit after fees, from every real and ghost path. Once
  it beats guessing the base rate it drives the EV gate's odds, can wave through above-average trades and veto clear losers.
- **Never into a dead tape**: no buy when the coin hasn't traded for 20–40 s (stretched by feed coverage) or barely traded
  in the last minute; swings also need an absolute win-model floor (10) — on a dead market "top 25%" is still dead coins.
- **Bet size is earned**: ~2% of the pot max for a fresh brain, growing to 20% after ~200 closed trades; a strategy with
  < 15 trades of its own or a losing record stays ≤ 4%. The EV gate applies from the first trade (thin evidence leans on
  a +12% / −8% prior payoff).
- **Graduated coins** fill and mark on the PumpSwap pool's constant-product maths too (≈0.8% fees each way).
- **Rides** bank 25% into a surge and follow the trailing playbook (swing / runner / moon) that has earned most for
  that style; the early "it's dying" exit is audited against that playbook and muted if it does worse.

- **Executor** (the self-driving brain below) proposes each trade. **Skeptic** — its own model of "this loses after
  fees" — argues for smaller size and tighter exits and can veto. **Optimist** — its own model of "this runs +25%" —
  argues for a bigger bet and room to run, and can hold a surge the skeptic wants to dump.
- Votes are weighted by **credibility** learned with Hedge (multiplicative weights), scored against a no-information
  baseline so a brain that just says "no" to everything earns nothing. The skeptic can only veto once it's proven
  calibrated, and only the riskiest slice of proposals (bull/bear debate + risk vote, as in TradingAgents, arXiv 2412.20138).
- **Exit playbooks** (flash · quick · swing · runner · moon) are replayed on the real price path of every trade AND
  every ghost (a trade the council turned down), after fees; a Thompson-sampled bandit per style picks what's making
  money. Ghosts also tell it whether saying no saved money or cost it — the bar moves accordingly.
- **Allocator (4th brain, risk manager)**: every strategy — early snipe, mid snipe, second wave, scalp, swing, copy,
  explore, drought breaker — books its real results after fees. A strategy that keeps losing (≥ 12 trades, average
  < −1% and confidently below zero) is benched for 20+ min, probed with small trades, and un-benched when the probes
  pay; winners get up to 1.8× size. It's how the bot "takes out what isn't working" from live results.
- **Top-wallet influxes are judged, not copied**: when several top wallets pile into one coin, the brains see the
  pile-in itself — how good the wallets are, how fast they came, whether the price already ran since the first one
  bought (late = exit liquidity), and how copying these wallets has gone before — and vote. Every influx gets a
  visible verdict in the log ("🐋 4 top wallets into $X — the Nebula is in / passed" with each brain's vote), and
  every influx it passes on is followed as a ghost so it learns whether passing was right.
- **Second wave**: research shows devs and their bundles took $579M+ vs snipers' $31.5M and 65% of devs sell inside a
  minute (Bitquery, Oct 2026) — a bot seeing trades seconds late is often exit liquidity. So it also waits out the
  first-minute flush and buys coins that survived it (dip bought back, holders growing, dev and snipers out).
- **Market brain**: sizes scale with how hot pump.fun is right now (share of coins going +12% first, fast vs slow).
- **Fee-aware exits**: it no longer "banks" +3–4% moves that are break-even after the ~2% it costs to sell; the
  skeptic learns from its own plug-pulls (a coin that ran after it sold makes it demand more next time).
- **Conviction sizing**: how much it puts in is how much it believes — the council's margin over its bar, the
  optimist's and skeptic's reads, the trade's expected value and the strategy's record roll into one 0…1 conviction:
  barely-yes ≈ 0.5% of the pot, everything lined up ≈ 20% in one buy. The coin's liquidity (≤ 4–8% price impact),
  the 60% exposure cap and the breakers still bound it; real money stays under your hard caps.
- **Expected-value gate**: before any buy, the skeptic's loss odds are calibrated against what actually happened at
  those odds, then combined with that strategy's real average win and loss: a negative-EV trade is not taken, and
  the best positive-EV trades get more size.
- **Circuit breakers**: −15% on the day → 30-minute pause; −8% of the pot in the last hour → 10-minute pause; never
  more than 60% of the pot deployed at once.
- **Exit auditor**: every discretionary exit rule (skeptic plug-pull, momentum flip, quiet tape, dump odds, "not
  working", thesis broken, volume dried up, stalled) is measured against what simply following the trade's
  playbook would have made (the counterfactual tracker keeps replaying after the real exit). Rules that keep doing
  worse are muted for 30 min, then retested. Stops and rug exits are never muted.
- **Stripped**: the drought breaker and random exploration buys (forced trades with no edge — ghost trades now teach
  the same lessons for free).
- **Report**: the Autopilot page and Copy diagnostics show the last 300 trades by strategy, exit reason and hold time.
- **Regimes**: a losing run flips it defensive (higher bar, smaller size, explores new exit playbooks — it changes
  things up); a winning run flips it aggressive; hysteresis stops it flip-flopping. The Autopilot page shows the three
  brains' credibility, the live debate, the playbook leaderboard and the saved / missed ledger.

### Self-driving brain (v7)

Its own algorithm on its own 100 SOL of demo money (`AUTO_START_SOL`; an older 10 SOL pot is topped up once, history kept) (and real money only if you pick it under your hard caps).

- **Two models, always learning**: a WIN model (odds of +60% before the stop) and a RUG model (odds of −60% inside
  20 min), online logistic regressions over ~70 signals with RMSProp step sizes that never decay, so it keeps adapting.
- **Reads the chart off the trade tape**: volume influx, liquidity flowing in / draining, holders arriving / leaving,
  drawdown, vertical candles, higher lows, volatility, dump candles vs liquidity, whales doing the selling, sell streaks,
  wash trading, bubble map (coordinated same-second buys, funder-linked clusters), dev holding / dumping / serial / fresh,
  age and market-cap buckets — on top of every Radar score (narratives, X calls, top wallets, insiders, snipers, top-10…).
- **Learns all the time**: every scored coin is sampled at several ages and followed (hundreds of lessons an hour);
  real trades teach 4× harder; every lesson is stored (`brain_examples`) and rehearsed in the background, so it keeps
  improving between trades and across restarts.
- **Gets discouraged**: losses lower its mood (rugs most), wins raise it, time heals it; a low mood = higher bar,
  smaller size, fewer positions; 4 losses in a row = a short cool-off; a deep drawdown caps the mood.
- **Pattern memory**: a decaying win/loss record for ~40 readable patterns ("coins under 2 min old", "serial-launcher
  devs", "liquidity draining"…). Losing patterns get penalised and it tells you; winning ones get a boost.
- **Copies top traders' sells**: a wallet it followed in sells → it follows them out; any top-ranked wallet dumping a coin
  it holds → it sells part (all of it when several top wallets are leaving). Post-mortems tune how hard it follows them.
- **Copies an influx, not a wallet**: 3+ top wallets piling into one coin within 5 minutes (or two top-10s within 2) — and
  only if its own read agrees. Copies are capped at ~35% of open positions; its own picks fill the rest, several per tick.
- **Sells as coins move**: scale-out ladder (hyper/degen: 25% at 1.25×, 30% at 1.6×, 35% at 2.2×, 50% at 4×), back-to-entry
  protection, trailing stop, momentum-fade partials, thesis-broken / volume-dried-up / stalled / time exits that recycle
  flat money fast. Patience is learned from what coins do after it exits. Positions can't get stuck: held coins stay in
  the live feed, and a position with no price for 3 minutes is closed.
- **Reads the apes**: new buyers per 10 s vs the minute before (an ape wave starting or fading), the first 20 buyers
  cashing out, pros among holders, volume vs liquidity, breakouts above the recent high, dips that buyers step back
  into, coins about to graduate — and "exhaustion": buyers drying up right at the highs after a run.
- **Timing models (next 3 minutes)**: two more models trained on a snapshot of every live coin every 30 s — will it be
  +12% before −10% (UP), or −15% first (DOWN)? Entries lean on UP; exits fire on DOWN (half when in profit, all when
  not), with the threshold learned from what coins did after it sold.
- **Liquidity-aware**: buys are capped at ~4% price impact on the curve; positions too big for the pool get trimmed into
  strength; a learned share is sold into graduation (less if migrations keep running, more if they dump).
- **✦ Surreal mode (default)**: a sniper-compounder. It snipes brand-new coins in their first ~45 seconds on its own
  read of the launch window (independent buyers arriving, money flowing in, a sane dev buy, no bundle / cluster /
  serial dev, timing-model odds), up to 6 buys per tick and 40 open at once; banks quick profits on small caps
  (snipes ~+15% / −10% / 75 s, scalps ~+10% / −8% / 90 s), re-enters as a scalp, and sizes every trade off the current
  balance so profit compounds. **Power trades**: when volume, liquidity or holders flood into a coin it bets 2.5×
  with a wider stop (−15%) and target (+35%), keeps running past the target while the flood lasts, then trails out.
- **Scalper (hyper / degen)**: many tiny in-and-out trades (~1% of the pot each) on whatever has the best next minute —
  apes arriving, price ticking up, buyers in control, liquidity behind it, and the timing model's UP odds. Take-profit
  ~+12%, stop ~−8%, out on a momentum flip, dump odds, a quiet tape or after ~2.5 min. It re-enters the same coin
  (20 s cooldown, never after two losses in a row on it) and tunes its own bar / take-profit / stop from results.
- **Rides real surges**: when holders, volume and liquidity are all pouring in, it banks 25% and holds the rest — no
  take-profit, no time stop — until the surge dies down (buyers fading, volume slowing, exhaustion, liquidity draining).
- **No silent stalls**: degen / hyper have no absolute value floor (calibrated models shrink every value); scalps barely
  move the mood; the Autopilot page lists why it passed on trades in the last minute. Demo trades pop up on the site
  but only real-money trades send Telegram / Discord alerts.
- **Blacklists**: copied wallets that keep losing get benched for 12h; devs whose coins rugged it are blocked.
- **Adaptive exits**: after every stop / trailing exit it keeps watching the coin — shaken out → stops get more room,
  kept dumping → stops tighten. Instant exits on rug patterns (liquidity drained, one sell dumping the curve, whales
  unloading, one hand holding the supply) and when the rug model is sure.

Not financial advice. Most memecoins go to zero.

## Trade feed (important since May 2026)

PumpPortal's new-launch feed is free, but since **May 1, 2026 its trade stream only flows to connections with a
PumpPortal API key** whose linked wallet holds ≥ 0.02 SOL (billed 0.01 SOL per 10,000 trades). Without trades every
coin looks buyer-less and the sniper / Autopilot can't act. Radar handles this two ways:

- **Free, automatic**: if PumpPortal delivers no trades while launches arrive, Radar starts an on-chain trade feed —
  one `logsSubscribe` on the pump.fun program, decoding its `TradeEvent` (side, SOL, tokens, trader, curve reserves).
  It uses your Helius websocket when Helius is connected (recommended), else `SOLANA_WS_URL` / the public RPC.
  It starts within seconds when no PumpPortal key is set, also forwards trades by your top / smart / followed wallets
  (copy-trading), fails over between Helius and the public RPC, and stops itself if PumpPortal trades come back.
  A second PumpPortal-compatible feed (`PUMP_ALT_WS_URL`, default pumpdev.io; empty disables) runs alongside it.
  `CHAIN_TRADES=on|off|auto` overrides. The brain never learns from coins whose trades it can't see.
- **Public-RPC coverage**: a public node drops much of a busy program's logs, so without Helius extra public websockets
  run side by side (`CHAIN_WS_EXTRA`, comma-separated, default PublicNode; empty disables) and duplicates are dropped by
  signature. The brain also knows the feed is partial: buyers it saw are scaled by coverage (the share of the curve's
  SOL it actually saw), and real SOL in the bonding curve counts as demand even when the trades themselves were missed.
  The Autopilot diagnostics show `feed_coverage_pct`; a free Helius key gives the whole tape.
- **PumpPortal key**: Connectors → PumpPortal → paste the key. The Health page and the Autopilot status box show which
  feed is live, trades per minute and PumpPortal's estimated cost today.
- **PumpPortal budget**: PumpPortal bills 0.01 SOL per 10,000 streamed trades. `PUMPPORTAL_DAILY_SOL` (default 0.5;
  0 = no cap) caps it: past the cap, trade subscriptions pause until midnight UTC and the free on-chain feed takes over.

## Free trend sources

Bluesky trending topics, Mastodon trending tags, Wikipedia most-read and Hacker News (official keyless APIs). A launch named
after a live trend gets a "trending off-crypto" read in Snipe (`web_trend` filter). Board on `/engines`.

## Running on a small server

`/api/healthz` shows memory, disk, DB and WAL size. Radar checkpoints the WAL, prunes old data and trims caches near the
RAM limit (`RADAR_RSS_LIMIT_MB`, default 430). Download a full backup from Engines → Budgets (`/api/admin/backup`).
The app is installable on phones (Add to Home Screen).
