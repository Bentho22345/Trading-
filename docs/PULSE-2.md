# PULSE 2.0 — architecture & plan

PULSE 2.0 extends v1. It does not replace it. The single Node process still serves the page, `/api` and `/ws` on one port. Everything new is attached to that process through a small set of generic building blocks, so each feature is mostly data and UI rather than new plumbing.

```
                          ┌──────────────────────── one Node process (server/index.ts) ─────────────────────────┐
 Browser tabs             │                                                                                       │
 ┌───────────────┐  /ws   │  Fanout ◄── hub (quotes, history, panels) ◄── adapters (live keyless / keyed / mock)   │
 │ leader tab    │◄──────►│    ▲         ▲                                    ▲                                    │
 │  (Web Lock)   │        │    │         │ intel blocks  ◄── intel jobs (rates, COT, EDGAR, prediction, flows…)  │
 └──────┬────────┘        │    │         │                                                                        │
  Broadcast│Channel       │    │     news pipeline ── score weights / keyword dict / source overrides (docs)     │
 ┌──────▼────────┐        │    │         │                                                                        │
 │ pop-outs,     │  /api  │  REST ── doc store (workspaces, playbooks, positions, journal, levels, routes…)       │
 │ wall, mobile  │◄──────►│    │                                                                                 │
 └───────────────┘        │  scheduler (minute tick, per-profile time zones)                                     │
                          │    ├─ briefs: morning / handoff / EOD / weekly ──► brief builders ─► narrative (AI|template)
                          │    ├─ playbook evaluator (on calendar actuals) ─► outcomes at +5m/+30m/+2h            │
                          │    ├─ themes, correlations, regime (every 1–5 min)                                   │
                          │    └─ tick archive downsampling + retention                                          │
                          │  outbox queue (retries, backoff, dead letters) ──► destinations                      │
                          │      email(SMTP) · Slack · Telegram · Discord · Twilio · Notion · webhook · web push  │
                          │  copilot (Anthropic tool use over our own data, daily token budget)                  │
                          │  SQLite (WAL) via Drizzle + versioned migrations (PRAGMA user_version)               │
                          └───────────────────────────────────────────────────────────────────────────────────────┘
```

## New folders

| Folder | Purpose |
| --- | --- |
| `server/db/migrate.ts` | Versioned, additive migrations. Existing tables are never altered destructively. |
| `server/docs.ts` | Generic JSON document collections, used by workspaces, playbooks, positions, journal, levels, alert routes and more. |
| `server/brief/` | Section builders (pure functions), narrative, renderers (HTML email, Markdown, Slack, plain text), generator. |
| `server/intel/` | New market-intelligence jobs. Each publishes an `IntelBlock` that carries source, timestamp and cadence (`live`, `delayed`, `daily`, `weekly`). |
| `server/integrations/` | `Destination` interface, outbox queue, credential encryption (AES-256-GCM). |
| `server/scheduler.ts`, `server/replay.ts`, `server/copilot.ts`, `server/playbooks.ts` | Background jobs and power features. |
| `shared/rules.ts`, `shared/playbook.ts`, `shared/quant.ts`, `shared/calendar2.ts` | Pure logic shared by server and browser: the rules engine parser, playbook evaluator, correlation, regime, surprise index and the market-structure calendar. |
| `src/components/brief/`, `layout/`, `settings/`, `intel/`, `copilot/`, `replay/` | UI. |
| `src/app/admin`, `src/app/popout`, `src/app/wall`, `src/app/m` | Admin console, pop-out windows, kiosk mode, mobile companion. |

## Providers chosen

All providers are optional. With zero keys, every stream uses a keyless public source, or a mock adapter that is clearly labelled.

| Data | Provider | Key | Limits / terms | Cadence label |
| --- | --- | --- | --- | --- |
| US & global yields, indices, commodities, DXY | Stooq CSV | none | Informal, so polled gently (60 s, batched) | delayed (per-quote age) |
| Real yields, breakevens | FRED (`DFII10`, `T10YIE`, `T5YIE`) | free key | 120 requests/min | **daily** |
| Treasury auctions | US Treasury Fiscal Data `auctions_query`, `upcoming_auctions` | none | Public | as announced |
| Commitments of Traders | CFTC Public Reporting (Socrata) | none (app token optional) | Throttled when no token is sent | **weekly, as of Tuesday** |
| Filings, Form 4 | SEC EDGAR Atom feeds | none, but a User-Agent with contact details is required (`SEC_USER_AGENT`) | 10 requests/s maximum; we poll every 2 min | live (as filed) |
| Prediction markets | Polymarket Gamma `/markets`, Kalshi `trade-api/v2/markets` | none | Gamma `/markets` 300 requests/10 s; Kalshi public GETs are unauthenticated | live market odds |
| Stablecoin supply | DefiLlama `stablecoins.llama.fi` | none | Free | daily |
| ETF flows, exchange netflows, token unlocks | No reliable free source | — | **mock-only** with a "connect a provider" state | — |
| Rate-path probabilities | No free futures/OIS feed | — | **Mock**, plus a rough estimate from short-dated yields, clearly labelled | estimate |
| Social mention velocity | Our own news stream (mentions per hour against a 24 h baseline) | none | Within our own terms | live |
| Reddit / X / StockTwits | Not enabled by default: their API terms restrict this use or need OAuth apps | — | — | — |
| Broker positions | Alpaca (read-only `GET /v2/positions`) | key | Read scopes only, and orders are never placed | live |
| AI | Anthropic | key | Daily token budget, cache by hash, falls back to templates | — |

## Mock-only on free tiers

The following have no reliable free source, so they ship with mock data and a "connect a provider" state:

- ETF flows, exchange netflows and token unlocks
- Rate-path probabilities for ECB, BoE and BoJ (the Fed gets a labelled estimate from 3M/2Y yields)
- Short interest
- Large FX option expiries

## Build order

Tiers are built in order: A (briefings), then B (editability), then C (intelligence), then D (copilot and power tools). Integrations come next, each behind a flag with a "Send test" button. The README is updated last.
