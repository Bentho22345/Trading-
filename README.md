# PULSE — real-time markets intelligence terminal

A single-screen news and market-data terminal for FX, crypto and equities & options. It's dense but calm, and built to stay open all day on a second monitor.

```bash
npm install && npm run dev      # → http://localhost:3000  (worker on :4000)
npm run setup                   # optional: paste free API keys (real-time stocks/FX) into .env
```

That's it: by default it runs in **live mode** with real news (central-bank, SEC, BLS, BBC, CNBC, MarketWatch, CoinDesk, Cointelegraph RSS), real crypto prices (Coinbase), VIX (Cboe, 15m delayed) and the ForexFactory calendar — no keys needed. Equities and FX come from Stooq's keyless quotes (delayed, with each quote's real age shown), earnings from Nasdaq's public calendar, and liquidations from OKX. Adding Alpaca / Finnhub / Twelve Data keys upgrades those streams to real-time automatically. Only options flow (put/call, unusual activity) stays demo, as no free source exists. Set `PULSE_MODE=mock` for a fully offline demo, with plausible streaming prices, a stream of realistic (clearly-labelled **DEMO**) headlines that cluster and trigger breaking banners, a live economic calendar whose "actuals" post on time, and so on. Add API keys to switch individual streams to live data without touching code.

---

## Architecture

```
 Upstream providers                     PULSE worker (Node/TS, always-on)            Browser (Next.js App Router)
 ──────────────────                     ─────────────────────────────────            ────────────────────────────
 Coinbase / Binance WS  ─┐              adapters/*  (one interface, mock + live)     WebSocket client
 Alpaca IEX WS           │                   │                                         backoff + jitter, resync on reconnect
 Finnhub WS + REST       ├──► adapters ──►  Hub  latest quotes · 26h minute history ──► rAF batcher → Zustand store
 Twelve Data REST        │                   │   stream health · analytics          WS   (one state update per frame)
 RSS (Fed/ECB/BoE/BoJ/   │              News pipeline                                  UI: ticker · virtualized feed ·
 RBA/BoC/SEC/BLS/crypto) │                sanitize → dedupe → tag → cluster →          panels · drawer · palette …
 alternative.me/CoinGecko│                score → (Claude TL;DR) → broadcast
 OKX · Cboe · ForexFactory┘             Alert engine (server-side, fires while hidden)  /api/* ──► Next rewrite ──► worker REST
                                        SQLite (Drizzle): articles, clusters, read,
                                        saved, watchlist, alerts, AI cache
```

- **Keys never reach the browser.** Only the worker talks to providers; the browser only talks to the worker (WebSocket for streams, REST via a Next.js rewrite for everything else).
- **Why a separate worker and not only Next route handlers?** Upstream WebSockets and pollers must stay alive for hours. Serverless route handlers can't hold them, so the worker is a small always-on Node process. A plain `node:http` + `ws` server keeps it dependency-light; a framework like Fastify would add little here.
- **Fan-out** coalesces quotes per client (latest value per symbol) and flushes every 100 ms, or every 2 s while the tab is hidden. It drops dead sockets via ping/pong and skips slow clients with backpressure.

### Folder structure

```
shared/            types, symbol universe, session maths, currency strength (used by both sides)
server/
  index.ts         wiring: adapters → hub/pipeline → fan-out + REST
  hub.ts           quotes, minute history, stream status/staleness, analytics (strength, breadth)
  ws.ts            browser fan-out (coalescing, throttling when hidden, heartbeats)
  http.ts          REST API (news archive, cluster timeline, history, digest, watchlist, alerts, read/saved)
  alerts.ts        price-cross / % move / keyword alert engine
  news/            pipeline.ts, tagger.ts, score.ts, sanitize.ts, sources.ts, ai.ts
  adapters/        types.ts (Adapter interface), index.ts (registry), mock/*, live/*, banks.ts
  data/            central-banks.json (editable reference data)
  db/              Drizzle schema + SQLite bootstrap
src/
  app/             layout, page, globals.css (design tokens, animations)
  components/      Terminal, TickerStrip, NewsFeed/NewsCard, panels/*, Drawer, Timeline, CommandPalette…
  lib/             store (Zustand), socket (WS + rAF batching), settings, hooks, format
tests/             node:test suites (tagger, clustering, scoring, sessions, strength, sanitizer)
```

---

## Running

| Command | What it does |
|---|---|
| `npm run dev` | worker (tsx watch, :4000) + Next dev (:3000) |
| `npm run build && npm start` | production build of the web app + worker |
| `npm test` | unit tests |
| `npm run typecheck` | TypeScript across web + worker |
| `docker compose up --build` | both services in containers, SQLite in a named volume |

Node 20+ (tested on 22). SQLite lives at `./data/pulse.db` (created automatically; delete it to reset).

### Mock mode

With `PULSE_MODE=mock`, every stream uses its demo adapter unless a provider is set explicitly or the key for a keyed provider is present. Mock data is always marked with a **DEMO** chip, and demo headlines come from fictional "Demo …" wires and link to `example.com`. `MOCK_NEWS_RATE=3` speeds up the headline stream.

### Switching to live data

1. `cp .env.example .env`
2. Add any keys. Each one switches its stream on its own (e.g. only `ALPACA_*` → live equities, everything else mock).
3. The **keyless** live sources (Coinbase WS, RSS, Cboe, ForexFactory, public crypto metrics) are on by default.
4. Or pin providers per stream: `CRYPTO_PROVIDER=binanceus`, `NEWS_PROVIDERS=rss,finnhub`, etc.

A keyed provider without its key falls back to mock with a warning. A live stream that goes down **never** falls back to mock silently. It keeps the last data, turns amber ("stale", with time since the last update) or red ("down", with the reason), and reconnects with exponential backoff and jitter.

---

## Providers: what I chose and why

Free-tier limits were checked in September 2026. **Re-verify before relying on them**; they change often.

| Stream | Provider (env) | Key? | Real-time? | Notes |
|---|---|---|---|---|
| Crypto prices | **Coinbase Exchange WS** `coinbase` | no | ✅ real-time | Public `ticker` channel; 24h reference from `open_24h`; 5h of 1-min candles backfilled from public REST. |
| | Binance / Binance.US `binance`, `binanceus` | no | ✅ | binance.com geo-blocks US users. Use `binanceus` there. |
| Equities | **Stooq** `stooq` (default, keyless) | no | ❌ delayed (~15 min, age shown per quote) | Public CSV quotes polled every 60 s. |
| | **Alpaca** `alpaca` | yes (free) | ✅ but **IEX-only** | Free plan streams IEX trades only (a small share of volume). Prev close from snapshots. Alpaca's movers endpoint is SIP-based, so movers are computed from our own universe. |
| | Finnhub `finnhub` | yes (free) | ✅ WS trades* | 60 REST calls/min; free WebSocket capped at 50 symbols, shared with FX. *Free-tier real-time coverage has varied; set `EQUITY_DELAY_MINUTES` if your plan is delayed. |
| FX | **Stooq** `stooq` (default, keyless) | no | polled 30 s (age shown) | USD legs + EM + gold; crosses derived. |
| | **Twelve Data** `twelvedata` | yes (free) | ❌ polled | 8 credits/min, 800/day ⇒ the 7 USD majors every ~14 min. The other 21 crosses are **derived** from the USD legs. Quotes carry an "Nm delayed" chip equal to their max age. |
| | Finnhub (OANDA) `finnhub` | yes | ✅ WS* | Forex over the shared Finnhub socket, if your plan includes it. |
| News | **RSS** `rss` | no | seconds–minutes | Fed, ECB, BoE, BoJ, RBA, BoC, SEC, BLS press feeds (published for syndication), plus CoinDesk and Cointelegraph public RSS. Conditional GET (ETag / If-Modified-Since), staggered 60 s polling. |
| | Finnhub market news `finnhub` | yes | ~1 min | general / forex / crypto / merger categories. |
| | CryptoPanic `cryptopanic` | **paid** | ~2 min | The free developer tier was **discontinued in early 2026**. |
| Economic calendar | ForexFactory export `forexfactory` | no | 30 min poll | Limited to 2 requests / 5 min. **No "actual" values** (forecast and previous only), so beat/miss colouring only works in mock mode or with a paid calendar API (e.g. Finnhub premium, Trading Economics). |
| Earnings | **Nasdaq** `nasdaq` (default, keyless) | no | 6 h poll | Our universe + mega caps. |
| | Finnhub `finnhub` | yes | daily | Implied move needs an options provider (shows "n/a"). |
| Crypto metrics | alternative.me, CoinGecko, OKX `public` | no | 5–30 min | Fear & Greed (attributed), BTC dominance and total mcap, perp funding. **Liquidations:** OKX public liquidation orders (≥ $50k) for BTC/ETH/SOL/XRP/DOGE perps. |
| Volatility | **Cboe delayed quotes** `cboe` | no | **15 min delayed** | VIX plus a term structure built from Cboe's VIX9D / VIX / VIX3M / VIX6M / VIX1Y (VIX *futures* data needs a CFE licence). Contango/backwardation is flagged. |
| Put/call, unusual options | mock only | — | — | No free provider exists. The UI shows "demo · connect a provider". |
| Central banks | `server/data/central-banks.json` | — | — | Rates and meeting dates are an editable reference file (no reliable free API; **verify the values**). Latest statement headlines come live from the news feed. |

Every price, panel and headline shows its source and freshness. Delayed data carries an amber "Nm delayed" chip, and mock data a "DEMO" chip.

### Getting API keys

- **Finnhub:** sign up at finnhub.io → Dashboard → API key.
- **Twelve Data:** twelvedata.com → sign up → API Keys.
- **Alpaca:** alpaca.markets → create a (paper) account → API Keys (Key ID + Secret). The Basic market-data plan is free.
- **CryptoPanic:** cryptopanic.com/developers/api (paid plans only since 2026).
- **Anthropic** (optional AI layer): console.anthropic.com → API Keys.
- For the SEC feed, set `SEC_USER_AGENT="YourApp (you@example.com)"`, per SEC's fair-access policy.

### Adding or swapping a provider

Implement `Adapter` (`server/adapters/types.ts`): `start(ctx)`/`stop()`. Write into the hub (`hub.pushQuotes`, `hub.setCalendar`, `hub.setCrypto`, `hub.setVol`) or call `ctx.emitNews(raw)`. Report health with `hub.touch` / `hub.reportError`. Then register it in `server/adapters/index.ts` under its stream. `live/rws.ts` gives you a reconnecting WebSocket with backoff, jitter, an idle watchdog and automatic resubscribe.

---

## News pipeline

1. **Normalize:** strip all HTML (`sanitize-html`, no tags allowed), decode entities, allow only http(s) links, cap summaries. We store headline + short summary and always link out; full text is never republished.
2. **Dedupe:** by URL hash and normalized-headline hash (48 h memory plus the SQLite unique key).
3. **Tag:** domains (FX / Crypto / Equities / Options / Macro / Central banks / Regulation); tickers (cashtags, known symbols, company names, ignoring ambiguous words like "ARM" unless cashtagged); currency pairs and currencies (codes, "yen", "sterling", "loonie"…); coins; central banks; a lexicon sentiment score.
4. **Cluster:** token similarity (Jaccard or damped overlap, with entity synonyms like "Bank of Japan" = "BoJ") within a 4 h window. Stories about *different* assets are never merged. The UI shows one card with "+N sources".
5. **Impact score 0–100:** 10 + credibility × 25 (official sources highest) + keyword severity (up to 35: "emergency", "default", "hack", "halt", "SEC charges", "rate decision"…) + corroboration (6 per extra source, max 18) + 12 if the story hits your watchlist + 4 for central banks. Watchlist changes rescore live clusters.
6. **Breaking:** the first time a fresh cluster crosses `BREAKING_THRESHOLD` (default 75) → banner (plus optional chime).
7. **AI (optional):** with `ANTHROPIC_API_KEY`, clusters with impact ≥ `AI_MIN_IMPACT` get a one-line TL;DR and a "why it matters". Costs are kept tight:
   - one call per cluster, plus one refresh when it reaches 3 sources
   - a serial queue with an hourly cap (`AI_MAX_PER_HOUR`)
   - ≤ 6 headlines of input, structured JSON output, low effort
   - results cached in SQLite across restarts

   The default model is `claude-opus-5-5`. Set `ANTHROPIC_MODEL=claude-haiku-4-5` for the cheapest option. Without a key, cards show the source summary.

---

## Features

**Tier 1**
- Movers ticker: EQ / FX / CRYPTO groups with labels, odometer digits, flash on update, pause on hover, click to open detail. A rAF-driven transform loop wraps at exactly one copy's width, so there's no seam jump, even when membership changes (recomputed once a minute). Speed and groups are set in Settings; with `prefers-reduced-motion` it becomes a static scrollable row.
- Live news feed:
  - virtualized
  - new cards spring in while existing cards glide down
  - if you've scrolled, a "↑ N new stories" pill appears instead of jumping
  - live "12s / 3m" ages, domain accents, clickable ticker chips with live % change, animated impact meters
- Filters (All / FX / Crypto / Equities & Options / Macro / Saved), search (`$AAPL`, pairs, sources), high-impact and breaking-only toggles.
- Breaking banner (spring in, pulsing accent line, dismissible, auto-hide after 45 s, optional soft chime).
- Session clock: 24h local timeline, live "now" marker, open/closed state, countdowns, and highlighted overlaps (London–NY called out). DST-correct, and the FX weekend is handled.
- Connection status: green/amber/red, browser⇄worker RTT, and a per-stream popover with provider, state, latency, last update and delay.

**Tier 2**
- Economic calendar: today/week, flags, importance filter, flip countdown to the next high-importance release (pulses in the final 60 s), actuals animate in coloured beat/miss (lower-is-better aware).
- Central bank watch, currency strength (1h/4h/1d from 28 crosses), FX heatmap, crypto panel (cards + sparklines, dominance, fear & greed gauge, funding, liquidations), volatility and options (VIX, term structure, put/call, earnings with implied move, unusual activity).
- Watchlist (tickers, pairs, coins, keywords): highlights and boosts matching stories.
- Alerts:
  - kinds: "EURUSD crosses 1.1000", "BTC moves 3% in 1h", "headline contains 'SNB'"
  - evaluated server-side, so they fire while the tab is hidden
  - delivered as toasts with a small burst, plus browser notifications after you explicitly grant permission

**Tier 3**
- Command palette (⌘K / Ctrl K) for tickers, filters, panels and settings.
- Keyboard: `J/K` move, `Enter` timeline, `O` open, `S` save, `M` read/unread, `/` search, `B` breaking-only, `H` high impact, `1–6` tabs, `F` focus, `?` cheat sheet.
- "While you were away" digest after more than 10 minutes hidden: top stories and biggest moves.
- Story timeline: how coverage developed, with the related asset's price and numbered markers.
- Ticker drawer: live chart (lightweight-charts, 1H/4H/1D), stats, related news, add to watchlist.
- Focus mode, saved/read-later, read items dimmed, drag-to-reorder / move / hide panels (persisted).

### Design and motion

The default theme is a dark "night trading floor" (a light theme is also included). It uses glass panels, domain accents (FX cyan, Crypto amber, Equities/Options violet, Macro teal), Geist Sans + Geist Mono with tabular numerals, and a colour-blind-safe blue/orange up/down option. The ambient background is a gradient mesh whose hue drifts toward green or red with market breadth. It moves in coarse steps so the glass panels' backdrop-filters re-rasterize about once a second rather than every frame.

Motion uses transforms and opacity only. `prefers-reduced-motion` is honoured everywhere, and **Calm mode** tones everything down.

### Performance and reliability

- Quotes are coalesced server-side and applied once per animation frame client-side. Each component subscribes to exactly the symbol it shows, and flashes use WAAPI on the element (no React render).
- The news list is virtualized. The client keeps at most 600 clusters and the worker 36 h in memory. SQLite is pruned hourly (`NEWS_RETENTION_DAYS`).
- Hidden tabs get 2 s batches, and the client catches up in one frame on focus.
- Every timer, listener, socket and chart is cleaned up on unmount or stop.
- First paint is server-rendered. The page server-renders the first screen of headlines, the WebSocket snapshot carries only the newest 60 clusters (compressed with permessage-deflate), and older items backfill over REST when idle. Overlays, cmdk and chart code are split out of the main bundle, and the side rails mount on idle.
- No layout thrash in hot paths:
  - the ticker caches its width with a ResizeObserver
  - flash colours are resolved once
  - impact meters use CSS transforms
- Measured on a production build in headless Chromium (software rendering, no GPU), with about 150 quote updates/s across 80 symbols:
  - steady-state 30–55 fps on desktop and about 60 fps on mobile layout
  - JS heap flat at about 15 MB over a 4-minute run
  - Lighthouse (mobile preset): **FCP 0.2 s / LCP 0.4 s observed**, CLS ≈ 0, Best practices 100, Accessibility 91, **Performance ≈ 70**

  The performance score misses the 90 target. Lighthouse's *simulated* slow-4G LCP (~4 s) counts the JS bundle, and its TBT counts the live updates that start immediately. The desktop preset doesn't complete because the page never goes network/CPU-idle (it streams by design). Further gains would come from trimming the client bundle (e.g. replacing framer-motion in the always-mounted shell with CSS).

### Security and compliance

- Provider keys stay server-side. Credentials are redacted from logs and from the status messages the browser can see.
- All external text is sanitized to plain text, links are restricted to http(s), and React escapes on render.
- We only use feeds/APIs whose terms allow this use (official press RSS, public market-data endpoints, keyed APIs within their free tiers) and always link to the original.
- The footer disclaimer reads: informational only, not investment advice; data may be delayed.
- ⚠️ The worker's REST API is unauthenticated (it's designed as a single-user tool). If you deploy it publicly, keep it on a private network or behind your platform's auth / IP allow-list, and set `CORS_ORIGIN`.

---

## Deploying

Serverless functions can't hold upstream WebSockets, so split it:

- **Worker → Fly.io / Railway / Render** (any always-on container):
  - use the included `Dockerfile` with command `npm run start:worker`
  - mount a volume at `/app/data` for SQLite
  - set your API keys and `CORS_ORIGIN=https://your-app.vercel.app`
  - the worker honours `PORT`
- **Web → Vercel:**
  - set `PULSE_WORKER_URL=https://your-worker.fly.dev` (used for the `/api/*` rewrite at build time)
  - set `NEXT_PUBLIC_WS_URL=wss://your-worker.fly.dev/ws`
- **Single box:** `docker compose up --build -d`, then open `http://<host>:3000`. The browser connects to `ws://<host>:4000/ws`.

---

## Known limitations

- The real provider adapters are implemented against the documented APIs but couldn't be exercised against the live endpoints from the build environment (outbound network was blocked). Mock mode and the failure paths (403s, disconnects, backoff, stale/down states) were verified.
- Free tiers mean: FX is polled (not streaming) with Twelve Data, equities are IEX-only with Alpaca, VIX is 15-minute delayed, and the free calendar has no actuals.
- Central-bank rates and meeting dates are reference data you should verify and update.
- Put/call, unusual options activity and liquidations need paid providers, so mock adapters with clear labels ship instead.
