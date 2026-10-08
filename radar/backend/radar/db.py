"""SQLite storage (WAL). One shared connection; every row carries an as_of / ts timestamp."""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Iterable

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  chain TEXT NOT NULL DEFAULT 'solana',
  name TEXT, symbol TEXT, image TEXT, uri TEXT,
  deployer TEXT,
  source TEXT,                -- where we first saw it: pumpportal, dexscreener, geckoterminal...
  launched_at REAL,           -- on-chain creation / pair creation time if known
  first_seen REAL NOT NULL,
  graduated_at REAL,
  graduated_pool TEXT,
  boost_amount REAL,          -- DexScreener paid boosts (risk flag, not a buy signal)
  has_profile INTEGER DEFAULT 0,
  links_json TEXT,
  pump_mcap_sol REAL, pump_mcap_as_of REAL,
  best_pair TEXT, last_refresh REAL,
  dev_initial_buy_pct REAL,   -- % of supply the deployer bought in the create tx
  curve_sol REAL, curve_progress REAL,   -- pump.fun bonding curve: virtual SOL and % of the way to graduation
  first_trending_at REAL,     -- first time it appeared on GeckoTerminal trending / DexScreener boosts (lead-time proof)
  image_hash TEXT,            -- perceptual dHash of the token image (copycat detection)
  updated REAL
);
CREATE INDEX IF NOT EXISTS tokens_first_seen ON tokens(first_seen DESC);
CREATE INDEX IF NOT EXISTS tokens_graduated ON tokens(graduated_at DESC);

CREATE TABLE IF NOT EXISTS pairs (
  pair_address TEXT PRIMARY KEY,
  token_address TEXT NOT NULL,
  chain TEXT, dex TEXT, url TEXT, quote_symbol TEXT,
  price_usd REAL, price_native REAL, liquidity_usd REAL, fdv REAL, market_cap REAL,
  vol_m5 REAL, vol_h1 REAL, vol_h6 REAL, vol_h24 REAL,
  buys_m5 INTEGER, sells_m5 INTEGER, buys_h1 INTEGER, sells_h1 INTEGER, buys_h24 INTEGER, sells_h24 INTEGER,
  chg_m5 REAL, chg_h1 REAL, chg_h6 REAL, chg_h24 REAL,
  pair_created_at REAL, boosts_active INTEGER,
  as_of REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS pairs_token ON pairs(token_address);

CREATE TABLE IF NOT EXISTS price_ticks (
  token_address TEXT NOT NULL, ts REAL NOT NULL, source TEXT,
  price_usd REAL, market_cap REAL, liquidity_usd REAL, vol_h1 REAL
);
CREATE INDEX IF NOT EXISTS ticks_token_ts ON price_ticks(token_address, ts);

CREATE TABLE IF NOT EXISTS safety_reports (
  token_address TEXT PRIMARY KEY, as_of REAL NOT NULL, source TEXT,
  score REAL, score_normalised REAL,
  mint_authority TEXT, freeze_authority TEXT,
  lp_locked_pct REAL, top10_pct REAL, holders INTEGER,
  insiders_detected INTEGER, rugged INTEGER, creator TEXT,
  risks_json TEXT, top_holders_json TEXT
);

CREATE TABLE IF NOT EXISTS pump_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL, ts REAL NOT NULL, side TEXT, sol REAL, tokens REAL,
  trader TEXT, mcap_sol REAL, signature TEXT UNIQUE,
  sol_usd REAL               -- SOL/USD at the moment of the trade, so candles are valued at the time, not today
);
CREATE INDEX IF NOT EXISTS trades_mint_ts ON pump_trades(mint, ts DESC);

CREATE TABLE IF NOT EXISTS trending (
  source TEXT NOT NULL, list TEXT NOT NULL, rank INTEGER NOT NULL,
  token_address TEXT, pool_address TEXT, name TEXT, symbol TEXT, data_json TEXT, as_of REAL NOT NULL,
  PRIMARY KEY (source, list, rank)
);

CREATE TABLE IF NOT EXISTS news (
  id TEXT PRIMARY KEY, source TEXT, title TEXT, link TEXT, published REAL, fetched REAL NOT NULL,
  grp TEXT, publisher TEXT, story_id TEXT, tags_json TEXT, metas_json TEXT, tickers_json TEXT,
  sentiment REAL, impact REAL
);
CREATE INDEX IF NOT EXISTS news_pub ON news(published DESC);
CREATE INDEX IF NOT EXISTS news_fetched ON news(fetched DESC);
CREATE INDEX IF NOT EXISTS news_story ON news(story_id);

CREATE TABLE IF NOT EXISTS market (
  key TEXT PRIMARY KEY, value REAL, source TEXT, as_of REAL NOT NULL, data_json TEXT
);

CREATE TABLE IF NOT EXISTS api_usage (
  ts REAL NOT NULL, adapter TEXT, path TEXT, status INTEGER, latency_ms REAL, cost_usd REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_ts ON api_usage(ts);

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, secrets_enc TEXT,
  status TEXT, last_test REAL, last_msg TEXT
);

CREATE TABLE IF NOT EXISTS custom_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL,
  headers_enc TEXT, items_path TEXT, interval_s REAL DEFAULT 60, enabled INTEGER DEFAULT 1,
  status TEXT, last_ok REAL, last_msg TEXT, items INTEGER DEFAULT 0, created REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_items (
  id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, ts REAL NOT NULL,
  title TEXT, link TEXT, payload_json TEXT
);
CREATE INDEX IF NOT EXISTS custom_items_ts ON custom_items(source_id, ts DESC);

CREATE TABLE IF NOT EXISTS watchlist (address TEXT PRIMARY KEY, added REAL NOT NULL, note TEXT, rules_json TEXT);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated REAL);

CREATE TABLE IF NOT EXISTS authors (
  id TEXT PRIMARY KEY,          -- source:handle
  source TEXT, handle TEXT, name TEXT, followers INTEGER, created_at REAL,
  tier TEXT,                    -- vip | kol | news | verified | normal | new
  bot_score REAL DEFAULT 0, posts INTEGER DEFAULT 0, last_seen REAL
);

CREATE TABLE IF NOT EXISTS social_events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, author_id TEXT, author_tier TEXT, followers INTEGER,
  text TEXT, url TEXT, media_json TEXT, ts REAL NOT NULL, ingested REAL NOT NULL,
  engagement REAL DEFAULT 0, cas_json TEXT, cashtags_json TEXT, narrative_id INTEGER,
  ai_json TEXT, is_fixture INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS social_ts ON social_events(ts DESC);
CREATE INDEX IF NOT EXISTS social_narr ON social_events(narrative_id, ts DESC);
CREATE INDEX IF NOT EXISTS social_ingested ON social_events(ingested);

CREATE TABLE IF NOT EXISTS narratives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT, category TEXT, keywords_json TEXT, tickers_json TEXT,
  first_seen REAL, last_seen REAL, stage TEXT, posts INTEGER DEFAULT 0, authors INTEGER DEFAULT 0,
  sources_json TEXT, vel_1m REAL, vel_5m REAL, vel_1h REAL, accel REAL, reach REAL, bot_share REAL,
  sentiment REAL, strength REAL, flash_until REAL, expected_life_h REAL, updated REAL, flags_json TEXT, zscore REAL
);

CREATE TABLE IF NOT EXISTS narrative_tokens (
  narrative_id INTEGER, token_address TEXT, match_score REAL, legit_score REAL, is_likely_fake INTEGER,
  reasons_json TEXT, updated REAL, PRIMARY KEY (narrative_id, token_address)
);

CREATE TABLE IF NOT EXISTS flash_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, narrative_id INTEGER, token_address TEXT,
  social_event_id TEXT, author TEXT, text TEXT, post_ts REAL, detected_ts REAL, pushed_ts REAL,
  latency_ms REAL, safety_json TEXT, is_fixture INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, token_address TEXT NOT NULL, symbol TEXT,
  verdict TEXT, score REAL, confidence TEXT, risk_grade TEXT, subscores_json TEXT, vetoes_json TEXT,
  reasons_json TEXT, plan_json TEXT, inputs_json TEXT, narrative_id INTEGER, category TEXT,
  writeup TEXT, config_version TEXT
);
CREATE INDEX IF NOT EXISTS signals_ts ON signals(ts DESC);
CREATE INDEX IF NOT EXISTS signals_token ON signals(token_address, ts DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, kind TEXT, severity TEXT, title TEXT, body TEXT,
  token_address TEXT, dedupe TEXT, delivered_json TEXT, acked INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alerts_ts ON alerts(ts DESC);

CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, signal_id INTEGER, token_address TEXT, symbol TEXT, verdict TEXT,
  category TEXT, score REAL, opened REAL, entry_price REAL, size_usd REAL, remaining REAL DEFAULT 1.0,
  realized_usd REAL DEFAULT 0, stop_price REAL, time_stop REAL, ladder_json TEXT, fills_json TEXT,
  peak_price REAL, trough_price REAL, last_price REAL, last_ts REAL, closed REAL, exit_reason TEXT,
  return_pct REAL, max_dd_pct REAL, is_backtest INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS paper_open ON paper_trades(closed);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token_address TEXT, symbol TEXT, opened REAL, entry_price REAL,
  size_usd REAL, qty REAL, stop_price REAL, ladder_json TEXT, fills_json TEXT, closed REAL,
  exit_price REAL, realized_usd REAL, notes TEXT, source TEXT DEFAULT 'manual', signal_id INTEGER
);

CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY, label TEXT, kind TEXT,      -- smart | kol | dev | mine
  handle TEXT, score REAL, wins INTEGER, losses INTEGER, avg_multiple REAL, avg_hold_s REAL,
  tokens INTEGER, tracked INTEGER DEFAULT 0, updated REAL
);

CREATE TABLE IF NOT EXISTS wallet_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, mint TEXT, ts REAL, side TEXT, sol REAL, tokens REAL,
  mcap_sol REAL, signature TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS wt_wallet ON wallet_trades(wallet, ts DESC);
CREATE INDEX IF NOT EXISTS wt_mint ON wallet_trades(mint, ts DESC);

CREATE TABLE IF NOT EXISTS wallet_positions (  -- average-cost ledger per (wallet, token) from observed trades
  wallet TEXT NOT NULL, mint TEXT NOT NULL, qty REAL, cost_sol REAL, bought_sol REAL, sold_sol REAL, realized_sol REAL,
  first_ts REAL, last_ts REAL, PRIMARY KEY (wallet, mint)
);
CREATE INDEX IF NOT EXISTS wpos_open ON wallet_positions(qty, mint);

CREATE TABLE IF NOT EXISTS wallet_pnl (  -- per-wallet P&L buckets: span 3600 (kept 48h) and 86400 (kept 35d)
  wallet TEXT NOT NULL, span INTEGER NOT NULL, bucket INTEGER NOT NULL, realized_sol REAL, basis_sol REAL,
  bought_sol REAL, sold_sol REAL, unmatched_sol REAL, trades INTEGER, wins INTEGER, losses INTEGER,
  PRIMARY KEY (wallet, span, bucket)
);
CREATE INDEX IF NOT EXISTS wpnl_bucket ON wallet_pnl(span, bucket);

CREATE TABLE IF NOT EXISTS wallet_board (  -- ranked snapshot per period (1d / 7d / 30d), rebuilt every few minutes
  period TEXT NOT NULL, wallet TEXT NOT NULL, rank_roi INTEGER, rank_pnl INTEGER, roi REAL, realized_sol REAL,
  basis_sol REAL, bought_sol REAL, sold_sol REAL, unmatched_sol REAL, trades INTEGER, wins INTEGER, losses INTEGER,
  win_rate REAL, active_buckets INTEGER, bot INTEGER, unrealized_sol REAL, open_cost_sol REAL, unpriced_cost_sol REAL,
  as_of REAL, PRIMARY KEY (period, wallet)
);
CREATE INDEX IF NOT EXISTS wboard_roi ON wallet_board(period, rank_roi);
CREATE INDEX IF NOT EXISTS wboard_pnl ON wallet_board(period, rank_pnl);

CREATE TABLE IF NOT EXISTS wallet_external (  -- top-trader lists from other platforms (Birdeye), per source and period
  source TEXT NOT NULL, period TEXT NOT NULL, wallet TEXT NOT NULL, rank INTEGER, pnl_usd REAL, volume_usd REAL,
  trades INTEGER, token TEXT, as_of REAL, PRIMARY KEY (source, period, wallet)
);
CREATE INDEX IF NOT EXISTS wext_wallet ON wallet_external(wallet);

CREATE TABLE IF NOT EXISTS holder_snapshots (
  token_address TEXT NOT NULL, ts REAL NOT NULL, holders INTEGER, top10_pct REAL, source TEXT
);
CREATE INDEX IF NOT EXISTS holders_token_ts ON holder_snapshots(token_address, ts);

CREATE TABLE IF NOT EXISTS image_hashes (url TEXT PRIMARY KEY, hash TEXT, ts REAL);

CREATE INDEX IF NOT EXISTS tokens_refresh ON tokens(last_refresh DESC);
CREATE INDEX IF NOT EXISTS tokens_deployer ON tokens(deployer);
CREATE INDEX IF NOT EXISTS tokens_symbol ON tokens(symbol);
CREATE INDEX IF NOT EXISTS nt_token ON narrative_tokens(token_address);
CREATE INDEX IF NOT EXISTS social_source ON social_events(source, ts DESC);
CREATE INDEX IF NOT EXISTS trades_trader ON pump_trades(trader);

-- every pump.fun launch Radar saw, kept 30 days (tokens rows for dead coins are pruned after 24h) so a deployer's
-- track record survives: how many coins, how many graduated, how high they went
CREATE TABLE IF NOT EXISTS dev_launches (
  mint TEXT PRIMARY KEY, deployer TEXT, symbol TEXT, name TEXT, ts REAL NOT NULL,
  peak_mcap_sol REAL, graduated_at REAL, last_trade_ts REAL
);
CREATE INDEX IF NOT EXISTS dev_launches_dev ON dev_launches(deployer, ts DESC);
CREATE INDEX IF NOT EXISTS dev_launches_ts ON dev_launches(ts DESC);

-- Snipe engine calls: the first time a launch crosses the call threshold, with every input, then its real outcome
CREATE TABLE IF NOT EXISTS snipe_calls (
  mint TEXT PRIMARY KEY, symbol TEXT, name TEXT, image TEXT, launched_at REAL, call_ts REAL NOT NULL,
  score REAL, tier TEXT, detectors_json TEXT, inputs_json TEXT,
  mcap_sol_at_call REAL, mcap_usd_at_call REAL, progress_at_call REAL, sol_usd_at_call REAL,
  peak_mcap_sol REAL, peak_ts REAL, last_mcap_sol REAL, last_ts REAL,
  mcap_sol_5m REAL, mcap_sol_15m REAL, mcap_sol_1h REAL,
  graduated_at REAL, first_trending_at REAL, updated REAL
);
CREATE INDEX IF NOT EXISTS snipe_calls_ts ON snipe_calls(call_ts DESC);

CREATE TABLE IF NOT EXISTS token_stories (
  token_address TEXT PRIMARY KEY, ts REAL NOT NULL, story_json TEXT, method TEXT
);

CREATE TABLE IF NOT EXISTS launch_watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, terms_json TEXT NOT NULL, label TEXT, narrative_id INTEGER,
  created REAL NOT NULL, enabled INTEGER DEFAULT 1, hits INTEGER DEFAULT 0, last_hit REAL, last_hit_token TEXT
);

CREATE TABLE IF NOT EXISTS traders (
  address TEXT PRIMARY KEY, label TEXT, sources_json TEXT, first_seen REAL NOT NULL, last_active REAL,
  followed INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,          -- imported by you (paste / Dune): never pruned from the 5,000 pool
  backfill_cursor TEXT, backfill_oldest REAL, backfill_done INTEGER DEFAULT 0, flags TEXT
);
CREATE INDEX IF NOT EXISTS traders_active ON traders(last_active DESC);

CREATE TABLE IF NOT EXISTS trader_trades (
  id TEXT PRIMARY KEY, wallet TEXT NOT NULL, mint TEXT NOT NULL, ts REAL NOT NULL, side TEXT NOT NULL,
  token_amount REAL, usd REAL, sol REAL, source TEXT
);
CREATE INDEX IF NOT EXISTS tt_wallet_ts ON trader_trades(wallet, ts);
CREATE INDEX IF NOT EXISTS tt_mint_ts ON trader_trades(mint, ts);
CREATE INDEX IF NOT EXISTS tt_ts ON trader_trades(ts);

CREATE TABLE IF NOT EXISTS trader_stats (
  address TEXT NOT NULL, win TEXT NOT NULL,
  realized_usd REAL, unrealized_usd REAL, pnl_usd REAL, volume_usd REAL, invested_usd REAL,
  trades INTEGER, tokens INTEGER, wins INTEGER, losses INTEGER, win_rate REAL, roi REAL, median_roi REAL,
  best_roi REAL, best_token TEXT, best_pnl_usd REAL, avg_hold_s REAL, score REAL, rank INTEGER,
  coverage_from REAL, last_trade REAL, series_json TEXT, flags TEXT, updated REAL,
  PRIMARY KEY (address, win)
);
CREATE INDEX IF NOT EXISTS ts_rank ON trader_stats(win, rank);

CREATE TABLE IF NOT EXISTS sol_prices (day INTEGER PRIMARY KEY, usd REAL NOT NULL);

CREATE TABLE IF NOT EXISTS briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, kind TEXT, body TEXT, model TEXT, context_json TEXT
);
"""


class DB:
    def __init__(self, path: Path):
        self.path = path
        self.conn: aiosqlite.Connection | None = None

    async def open(self) -> None:
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        # autocommit: each write is its own (cheap, WAL + synchronous=NORMAL) transaction, so a write is one
        # thread hop instead of two (execute + commit). Bulk writes wrap themselves in BEGIN/COMMIT (see many()).
        self.conn = await aiosqlite.connect(self.path, isolation_level=None)
        self.conn.row_factory = aiosqlite.Row
        for pragma in ("journal_mode=WAL", "synchronous=NORMAL", "temp_store=MEMORY", "cache_size=-65536",
                       "mmap_size=268435456", "busy_timeout=5000"):
            await self.conn.execute(f"PRAGMA {pragma}")
        self._bulk = asyncio.Lock()
        await self.migrate()
        await self.conn.executescript(SCHEMA)

    async def migrate(self) -> None:
        """Add columns that newer versions introduced to tables created by older versions (SQLite can't do it in CREATE)."""
        import re
        assert self.conn
        stmts = [re.sub(r"--[^\n]*", "", x) for x in SCHEMA.split(";")]
        for st in stmts:
            m = re.match(r"\s*CREATE TABLE IF NOT EXISTS (\w+)\s*\(", st)
            if not m:
                continue
            table, body = m.group(1), st[m.end():st.rindex(")")]
            async with self.conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)) as cur:
                if not await cur.fetchone():
                    continue
            async with self.conn.execute(f"PRAGMA table_info({table})") as cur:
                have = {r[1] for r in await cur.fetchall()}
            body = re.sub(r"--[^\n]*", "", body)
            for part in re.split(r",(?![^()]*\))", body):
                part = part.strip()
                if not part or part.upper().startswith(("PRIMARY KEY", "UNIQUE", "FOREIGN")):
                    continue
                col = part.split()[0]
                if col in have:
                    continue
                ddl = re.sub(r"\bPRIMARY KEY\b|\bAUTOINCREMENT\b|\bUNIQUE\b|\bNOT NULL\b", "", part)
                await self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")

    async def close(self) -> None:
        if self.conn:
            await self.conn.close()

    async def exec(self, sql: str, params: Iterable[Any] = ()) -> int:
        assert self.conn
        cur = await self.conn.execute(sql, tuple(params))
        return cur.lastrowid or cur.rowcount

    async def many(self, sql: str, rows: list[Iterable[Any]]) -> None:
        assert self.conn
        if not rows:
            return
        async with self._bulk:   # one transaction for the whole batch; the lock keeps two batches from nesting BEGINs
            await self.conn.execute("BEGIN")
            try:
                await self.conn.executemany(sql, [tuple(r) for r in rows])
            except BaseException:
                await self.conn.execute("ROLLBACK")
                raise
            await self.conn.execute("COMMIT")

    async def all(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        assert self.conn
        async with self.conn.execute(sql, tuple(params)) as cur:
            return [dict(r) for r in await cur.fetchall()]

    async def one(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        rows = await self.all(sql, params)
        return rows[0] if rows else None

    async def upsert(self, table: str, row: dict[str, Any], key: str | tuple[str, ...]) -> None:
        """Insert or update only the provided (non-None) columns."""
        cols = [k for k, v in row.items() if v is not None]
        keys = (key,) if isinstance(key, str) else key
        updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c not in keys)
        sql = (f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)}) "
               f"ON CONFLICT({', '.join(keys)}) DO " + (f"UPDATE SET {updates}" if updates else "NOTHING"))
        await self.exec(sql, [row[c] for c in cols])
