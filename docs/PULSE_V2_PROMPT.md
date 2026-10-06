# ROLE
You are a senior full-stack engineer, quant-minded product designer and motion/UI designer. You are upgrading **PULSE**, a real-time markets intelligence terminal that already exists in this repository. Work autonomously, make sensible decisions, and briefly explain key trade-offs as you go. Before you write code, read the existing README, `shared/`, `server/` and `src/` so you extend what is there instead of rebuilding it. Everything that works today must keep working.

# THE PRODUCT: "PULSE 2.0" — from a news terminal to a personal trading desk
PULSE v1 already aggregates live news and market data across FX, crypto, and equities & options. It has a movers ticker strip, a clustered and scored news feed, an economic calendar, a central bank watch, FX strength and a heatmap, crypto and volatility panels, a watchlist, alerts, a command palette, a digest and a drawer.

PULSE 2.0 turns it into the user's **personal morning-to-close trading desk**. It should:
1. **Brief the user** before the session starts, at each session handoff, and at the close
2. **Know the user**: their positions, levels, playbooks, sources and layout, so every item is ranked by relevance to *them*
3. **Be fully editable**: every panel, score weight, feed, alert route, color, shortcut and brief section can be configured from the UI without touching code
4. **Connect outward**: briefs and alerts go out to email, Slack, Telegram, calendar and notes through optional integrations, and the core app still runs with none of them

It should still feel like a Bloomberg Terminal redesigned by a modern product studio: dense, calm, fast and beautiful, and stable when left open for 10+ hours.

# GROUND RULES (carried over from v1, still non-negotiable)
- `npm install && npm run dev` still runs everything with zero keys. Every new feature ships with a **mock adapter** and a clearly labeled "connect a provider" state
- All keys and OAuth tokens stay server-side. The browser only talks to our backend
- Every data point shows its source and timestamp. Delayed data gets a "15m delayed" chip and is never presented as live
- Stale streams show time since their last update. Panels never crash or go blank
- Respect provider terms and rate limits. Link to original articles; never republish full text. Sanitize all external content
- Reduced motion and Calm mode apply to every new animation
- 60fps under load, no memory leaks over long sessions, Lighthouse 90+ on initial load
- Footer disclaimer: informational only, not investment advice

---

# NEW FEATURES

Build these in tier order. Finish and polish each tier, run the app, check the console and performance, and fix any issues before you start the next tier.

## Tier A: Briefings (the headline feature)

### 1. Morning Brief
A full-screen, beautifully typeset "front page" that is ready before the user's session starts and opens automatically on the first visit of the day. You can also open it any time with `M` or from the palette.

**Sections** (each one can be toggled, reordered and resized in the Brief Editor; see feature 2):
- **The one-paragraph take**: an AI-written 3–4 sentence narrative of what happened overnight and what matters today. If there is no ANTHROPIC_API_KEY, use a deterministic, template-based summary built from the data
- **Overnight scoreboard**: Asia and early-Europe moves for indices, majors, BTC/ETH, gold, oil, US 10Y and DXY, each with a sparkline from the user's last close to now
- **Top 5 stories**: ranked by impact × personal relevance, each with a TL;DR and "why it matters" line plus links to sources
- **Today's calendar**: high-importance releases with consensus, previous and the historical average surprise; central bank speakers; auctions; earnings before the open and after the close with implied moves
- **Your book**: overnight P&L on imported positions (see feature 9), news that touches the user's holdings, and levels that were approached or broken
- **Key levels to watch**: user-defined levels plus automatic ones (prior day high/low/close, overnight high/low, round numbers, large FX option expiries where data exists)
- **Rates path**: market-implied probabilities for the next meeting of each major central bank (see feature 12)
- **Sentiment snapshot**: fear & greed, VIX term structure state, put/call, funding rates and the social buzz leaders
- **Week-ahead strip** (Mondays and Sunday evenings): the five-day lookahead
- **Yesterday's scorecard**: which of yesterday's brief calls and playbooks played out (see feature 6)

**Delivery & formats:**
- In-app full-screen view with a staggered reveal (under 800ms; instant in reduced motion)
- **Listen mode**: text-to-speech read-out with a progress bar and chapter skipping (browser TTS by default, server TTS provider optional)
- Optional delivery by email (HTML email), Slack, Telegram or as a PDF at a scheduled time, through the integrations below
- **Brief archive**: every brief is stored in SQLite and browsable by date, with a diff view ("what changed vs yesterday's brief")
- Generated on the server by a scheduler with a configurable time per weekday and time zone. A "regenerate now" button rebuilds it on demand

### 2. Brief Editor
A WYSIWYG-style editor for briefs:
- Drag to reorder sections, toggle them on and off, and set per-section options (e.g. "top N stories", "only show my asset classes", "include crypto overnight")
- Choose the AI tone and length: *Terse trader* / *Analyst* / *Explain like I'm new*, and 50 / 150 / 300 words
- Multiple brief profiles (e.g. "FX morning", "Crypto weekend", "US open"), each with its own schedule and destinations
- A live preview pane that renders with current data
- Import and export brief templates as JSON

### 3. Session Handoff & End-of-Day Wrap
- **Handoff cards** at Asia→London and London→NY transitions: what moved, what's next and open risks. They appear as a dismissible card in the feed and can optionally be sent out
- **End-of-Day Wrap** at a configurable time: closing scoreboard, biggest movers, best and worst calls, a journal prompt ("What did you learn today?") and a preview of tomorrow's calendar
- **Weekly Review** (Friday close): the week's top themes, cumulative moves, how well the user's playbooks hit, and a calendar heatmap of activity

## Tier B: Make everything editable

### 4. Workspaces & a free-form layout engine
- Replace the fixed rails with a **resizable, snap-to-grid layout** (12 columns, drag to move, drag the corners to resize). Collision handling should feel smooth and the reflow should be animated
- **Multiple named workspaces** (e.g. "FX Desk", "Crypto Night", "Earnings Day", "Focus") that you switch with `1`–`9` or from the palette. Each workspace can be pinned to a time of day and switch automatically (e.g. FX Desk at 07:00, Earnings Day on days with big reports)
- **Widget library**: a drawer of every panel, including multiple instances of the same panel with different configs (two news feeds, one FX-only and one crypto-only)
- **Pop-out panels** into separate browser windows for multi-monitor setups. They share the same socket through a BroadcastChannel/SharedWorker so there is still only one upstream connection
- **Wall / kiosk mode**: an oversized, auto-cycling display for a TV on the desk
- Undo and redo for layout edits; reset to default

### 5. Settings Center & a theme editor
One searchable settings page that controls everything:
- **Theme editor**: accent colors per domain, up/down colors (with a contrast checker that warns when a pairing fails WCAG), background intensity, glass blur, corner radius, font choices and density (compact / cozy / spacious), with a live preview. Users can save, share and import themes; ship 4 presets (Night Floor, Paper, Terminal Green, High Contrast)
- **Score tuning**: sliders for the impact-score weights (source credibility, keyword severity, watchlist match, cluster size, position exposure), with a live preview of how the current feed would re-rank
- **Keyword dictionary editor**: add or remove severity keywords and their weights, and your own custom tags
- **Source manager**: add any RSS/Atom feed by URL (validated server-side, with terms reminder), set credibility weights, mute sources, and see each source's health, latency and items per hour
- **Ticker strip composer**: pick the exact symbols, groups, order, speed, density and which fields to show
- **Keyboard shortcut remapping**, with conflict detection
- **Time zones**: home time zone, extra clocks, working hours, custom sessions and quiet hours
- **Import/export all settings** as a single JSON file, and sync across devices through the backend

### 6. Event Playbooks
Pre-plan reactions to scheduled events:
- For any calendar event (e.g. US CPI), write "If actual > consensus by X → watch USDJPY above 151.20, short gold…" as structured scenarios with notes
- When the release posts, PULSE evaluates which scenario fired, **surfaces the matching playbook card** with a gentle highlight, and links the live charts
- A scorecard afterwards: did the expected move happen within 5m, 30m and 2h?
- A template library ("NFP standard playbook", "FOMC day") the user can clone and edit

### 7. Smart Feeds (a visual rules engine)
- A visual query builder for custom feeds: `(asset_class = FX AND currency IN [JPY, CHF]) OR (tag = Central Banks AND impact > 60) NOT source = X`
- Save feeds as tabs, give them a color and icon, and attach alerts to them
- Show a feed's matches per hour as a tiny sparkline in its tab
- Smart feeds can be used as brief sections and alert sources

## Tier C: New market intelligence

### 8. Rates & Yields panel
- US Treasury curve (2Y/5Y/10Y/30Y) with an intraday curve chart and a "vs yesterday" ghost line
- 2s10s and 5s30s spreads with steepening/flattening labels
- Global 10Y yields (Bund, Gilt, JGB, OAT, BTP) and key spreads (BTP–Bund)
- Real yields and breakevens (FRED, daily, marked as daily)
- Treasury auction calendar with results (tail/stop-through, bid-to-cover) animated in when they post

### 9. Portfolio & exposure awareness
- Import positions by CSV upload, by manual entry, or from a read-only broker connection (e.g. Alpaca paper/live, read scopes only)
- **Exposure map**: net exposure by currency, asset class and sector, shown as a treemap
- A live P&L line in the header (it can be hidden instantly with a "privacy blur" hotkey `P`)
- News relevance: stories that mention held assets or their correlated proxies get a "📌 In your book" chip and a score boost
- "What hurts me most?" stress tiles: a ±1% DXY, +10bp 10Y or −5% BTC shock applied to current exposure (a simple linear estimate, clearly labeled as such)

### 10. Historical Reaction Analyzer
- For each recurring release (CPI, NFP, ECB decision…), show the last 12–24 occurrences: surprise vs consensus, and the 5m/30m/1d move in related assets
- A scatter chart of surprise versus reaction, with the user's playbook thresholds overlaid
- A one-line base rate ("When NFP beat by >50k, USDJPY rose in the first 30m 9 of 12 times")
- An **economic surprise index** per region, built from actual vs consensus, as a small line chart

### 11. Narrative & Theme Radar
- Group clusters into **multi-day themes** (e.g. "Japan intervention watch", "ETF flows", "Regional bank stress") using keyword and entity co-occurrence (and AI labeling if a key is present)
- A theme radar: bubble size = coverage volume, color = sentiment, position = momentum (heating or cooling)
- A theme page with a timeline of coverage, related assets' price overlay, and key quotes linked to sources
- Theme alerts: "notify me when a new theme enters the top 5"

### 12. Central-bank rate-path probabilities
- Market-implied probabilities of a hike, cut or hold for the next 3 meetings of the Fed, ECB, BoE and BoJ, derived from futures/OIS data where available (otherwise a mock adapter and a "connect a provider" state)
- An animated probability bar per meeting, with "Δ since yesterday" arrows
- A **speaker tracker**: an upcoming central bank speeches calendar and a hawk/dove lean per speaker (editable reference data in JSON)

### 13. Cross-asset & regime panel
- Commodities (gold, silver, WTI, Brent, natgas, copper) and DXY cards
- A **rolling correlation matrix** (1d/1w/1m) across 12 user-chosen assets, with cells that animate as correlations shift and a "correlation break" flag
- **Regime detector**: risk-on/risk-off score computed from equities, VIX, credit proxies, JPY, gold and BTC, shown as a dial with a history strip. This regime also drives the ambient background tint

### 14. Positioning & flows
- CFTC Commitments of Traders (weekly): net speculative positioning in the major currencies, gold, oil and indices, with percentile vs 3 years, labeled "weekly, as of Tuesday"
- Crypto flows: spot BTC/ETH ETF net flows, stablecoin supply changes, exchange netflows and a token unlocks calendar (where free sources allow; otherwise mock)
- Equity: short interest highlights, Form 4 insider buys/sells for watchlist names

### 15. Filings & primary-source stream
- A live SEC EDGAR stream of 8-Ks, S-1s, 13Ds and Form 4s, filtered to the watchlist and large caps, with an AI one-liner per filing when a key is present
- Fed/ECB/BoE speeches and minutes, with a "what changed vs last statement" diff view that highlights added and removed sentences

### 16. Social & prediction-market pulse
- Mention velocity for tickers and coins from public social sources whose terms allow it. Spike detection flags tickers with "3.4× normal chatter"
- A prediction markets panel (e.g. Polymarket, Kalshi public market data) for macro and political events relevant to markets: odds, 24h change and volume. Show the source and that these are market odds, not forecasts

## Tier D: AI copilot & power tools

### 17. "Ask Pulse" copilot
- A chat side panel (`⌘J`) that answers questions using *only* PULSE's own data and articles, with citations to the cards it used: "Why is JPY bid?", "Summarize everything on NVDA today", "What's on the calendar that could move gold?"
- Tool-use on the server: the model can query the article store, quotes, calendar and history through typed functions. Answers include source links and timestamps
- "Explain this" on any card, chart or number (right-click or `E`)
- Strict cost controls: per-day token budget shown in Settings, prompt caching, and a small model for classification. If there is no key, the panel shows a clear "connect Anthropic API key" state

### 18. Trading journal & annotations
- Pin notes to any story, ticker, chart point or calendar event, with Markdown and tags
- Draw horizontal levels and notes on mini charts; levels feed into alerts and the Morning Brief
- A daily journal page that is pre-filled automatically with the day's top stories, the user's alerts fired, playbook outcomes and P&L. The user adds reflections
- Search across all notes; export to Markdown or Notion

### 19. Market Replay
- Replay any past day (stored ticks + news) at 1×–60× speed with a scrubber. The whole terminal behaves as if it were live: ticker, feed, banners and alerts
- Useful for reviewing an event, testing playbooks and alert rules ("would this alert have fired?"), and demos
- A clear "REPLAY · 14:32:05 · 10×" banner so it can never be mistaken for live

### 20. Notification routing & escalation
- Per-alert destinations: in-app toast, browser push, email, Slack, Telegram, Discord, SMS (each one optional)
- Quiet hours, digest batching ("bundle low-priority alerts every 30m") and escalation ("if not acknowledged in 2m, send to phone")
- An alert history log with acknowledge/snooze, and per-alert hit statistics
- Alert templates and a "smart alert" builder in plain English ("tell me if BTC drops 5% while funding is positive"), parsed into a structured rule and shown back to the user for confirmation

### 21. Audio squawk
- Optional text-to-speech for breaking headlines and alerts, with a voice, rate and per-domain filter
- Distinct, soft earcons per domain and per alert severity (all off by default)
- Push-to-mute key (`Shift+M`) and auto-ducking during Listen mode

### 22. Market holidays & structural calendar
- Exchange holidays and half-days per venue, options expiry (monthly, quarterly, quad witching), index rebalances, futures rolls, month-end and quarter-end flows and daylight-saving shifts that move session times
- These all appear in the session clock as markers and feed into the Morning Brief

### 23. Share & export
- Export any panel or story as a crisp PNG card with source attribution and the disclaimer watermark
- "Copy for chat" formats a story or calendar print as clean text for Slack or Bloomberg IB
- Export the watchlist, alerts, journal or brief as CSV, JSON, Markdown or PDF

### 24. Mobile companion (PWA)
- An installable PWA with a condensed view: ticker strip, top stories, the next event and alerts
- Web push for alerts and the Morning Brief; offline cache of the latest brief

### 25. Data source health & admin console
- An `/admin` page: per-adapter status, latency percentiles, error rates, rate-limit/quota meters ("Finnhub 41/60 req/min"), last success and recent errors
- Toggle adapters and switch between mock and live per stream at runtime, without a restart
- Pipeline stats: items ingested, deduplicated and clustered per hour; AI calls and cost today

---

# INTEGRATIONS & CONNECTORS
Each integration is **optional**, configured in Settings → Integrations (OAuth or webhook URL/token stored server-side and encrypted at rest), and degrades gracefully when it is missing or broken. Build each one behind a common `Destination` / `Source` interface so new ones can be added easily.

| Integration | Direction | Powers |
|---|---|---|
| **Gmail / Outlook (email)** | Out | Morning Brief, EOD Wrap, Weekly Review as HTML email; alert escalation |
| **Google Calendar / Outlook Calendar** | Out + In | Push high-importance releases, CB meetings and playbook events into the user's calendar; read the user's own meetings so the brief says "you're in a meeting during CPI" |
| **Slack** | Out | Briefs, alerts and handoff cards posted to a channel or DM; "copy for chat" formatting |
| **Telegram / Discord** | Out | Bot or webhook delivery of alerts and briefs |
| **Twilio (SMS)** | Out | Escalation for critical alerts only |
| **Notion** | Out | Journal entries, brief archive and playbooks synced as pages |
| **Google Drive / Sheets** | Out + In | Export journals and briefs; import positions or a watchlist from a sheet |
| **Broker (Alpaca, IBKR, etc., read-only)** | In | Positions and P&L for exposure awareness. Read scopes only; never place orders |
| **Anthropic API** | In | TL;DRs, the Morning Brief narrative, Ask Pulse, theme labeling, filing one-liners, smart alert parsing |
| **FRED / US Treasury Fiscal Data** | In | Yields, real yields, breakevens, auction results |
| **SEC EDGAR** | In | Filings stream, Form 4 insider activity (respect the required User-Agent and rate limits) |
| **CFTC** | In | Weekly Commitments of Traders |
| **Polymarket / Kalshi** | In | Prediction market odds |
| **DefiLlama and other crypto data** | In | Stablecoin supply, ETF flows, token unlocks |
| **Social sources (Reddit, X, StockTwits)** | In | Mention velocity, only where the API terms allow this use |

**Verify the current free-tier limits, terms and endpoints for every provider before relying on it**, and tell me what you chose, why, and what is delayed, weekly or end-of-day.

---

# DESIGN ADDITIONS
- **Morning Brief typography**: an editorial layout with a serif display face for the headline take (e.g. Newsreader, Fraunces), the grotesk for body text and mono for all numbers. It should read like a premium newsletter that happens to be live
- **Editing affordances**: when "Edit layout" is on, panels show a subtle dotted outline, drag handles and resize corners; everything else dims slightly. Exit with `Esc`
- **Empty and "connect a provider" states** are designed screens, not error messages: an icon, one sentence, a "Connect" button and a "Use demo data" toggle
- **Personal relevance** is shown consistently: a small 📌 marker and a thin left-border accent on anything that touches the user's book, watchlist or playbooks
- New domain colors: **Rates = blue**, **Commodities = gold**, **Social/Prediction = pink**. All are tuned for contrast in both themes and in the colorblind-safe palette

# MOTION ADDITIONS
- Morning Brief: sections reveal in sequence like a page being set, numbers count up from the previous close, and sparklines draw left to right
- Probability bars and the regime dial ease to new values. The correlation matrix crossfades cell colors rather than snapping
- Playbook trigger: a single soft ring pulse around the matched card plus a toast. No confetti on losses; a brief, tasteful burst only when an alert or playbook fires as planned
- Replay mode: a subtle film-grain overlay and a timeline scrubber with momentum
- All of the above have reduced-motion and Calm-mode equivalents

# DATA MODEL ADDITIONS (SQLite / Drizzle)
`briefs`, `brief_profiles`, `workspaces`, `layouts`, `themes`, `smart_feeds`, `playbooks`, `playbook_outcomes`, `positions`, `journal_entries`, `annotations`, `levels`, `themes_narrative`, `alert_routes`, `alert_history`, `integrations` (encrypted credentials), `source_overrides`, `score_weights`, `tick_archive` (compressed, with a retention setting for Replay). Add migrations; never break existing data.

# PERFORMANCE & RELIABILITY ADDITIONS
- Run brief generation, theme clustering and correlation maths in the worker on schedules or in background jobs, never on the request path
- Pop-out windows share one socket (SharedWorker or BroadcastChannel leader election)
- Tick archive: downsample to 1s after 1 day and 1m after 7 days, with a configurable retention cap
- AI: cache by cluster/brief hash, enforce the daily budget, and fall back to templates when the budget runs out
- Outbound integrations: queue with retries, exponential backoff and a dead-letter log visible in /admin
- Tests: unit tests for the rules engine parser, playbook evaluator, surprise index, correlation maths, regime score, brief section builders and each Destination's payload formatting

# HOW TO WORK
1. Start with a short plan: an updated architecture diagram showing the scheduler, jobs and integration layer; the new folders; the providers you chose with their limits; and anything that stays mock-only on free tiers
2. Build Tier A (briefings) first with mock data and template fallbacks. Get the Morning Brief looking stunning before wiring AI or delivery
3. Then Tier B (editability), then C, then D. After each tier, run the app, fix console errors, check performance and update the README
4. Add integrations one at a time, each behind a feature flag, with a "Send test" button in Settings
5. Finish with README updates: new env vars, how to obtain each key/OAuth app, how to schedule briefs, how to use Replay, how to back up and restore settings, and deployment notes for the scheduler (the always-on worker must run the cron jobs)

# ACCEPTANCE CRITERIA
- With zero keys, the Morning Brief generates on schedule from mock/live keyless data and opens on the first visit of the day
- Every brief section, panel, score weight, source, shortcut, color and alert route can be edited from the UI and survives a reload; settings export and import round-trip exactly
- Workspaces switch instantly, and pop-outs share one connection
- Playbooks evaluate automatically when a release posts and record outcomes
- Replay reproduces a stored day, including alerts, and is unmistakably labeled
- Each integration can be connected, tested and disconnected from Settings. Missing integrations never cause errors
- Delayed, daily and weekly data are labeled as such everywhere
- No console errors, 60fps under load, stable over a 10-hour session, and reduced motion and Calm mode respected throughout
