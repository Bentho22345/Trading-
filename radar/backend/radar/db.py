"""SQLite storage (WAL). One shared connection; every row carries an as_of / ts timestamp."""
from __future__ import annotations

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
  trader TEXT, mcap_sol REAL, signature TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS trades_mint_ts ON pump_trades(mint, ts DESC);

CREATE TABLE IF NOT EXISTS trending (
  source TEXT NOT NULL, list TEXT NOT NULL, rank INTEGER NOT NULL,
  token_address TEXT, pool_address TEXT, name TEXT, symbol TEXT, data_json TEXT, as_of REAL NOT NULL,
  PRIMARY KEY (source, list, rank)
);

CREATE TABLE IF NOT EXISTS news (
  id TEXT PRIMARY KEY, source TEXT, title TEXT, link TEXT, published REAL, fetched REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS news_pub ON news(published DESC);

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

CREATE TABLE IF NOT EXISTS watchlist (address TEXT PRIMARY KEY, added REAL NOT NULL, note TEXT);
"""


class DB:
    def __init__(self, path: Path):
        self.path = path
        self.conn: aiosqlite.Connection | None = None

    async def open(self) -> None:
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row
        await self.conn.execute("PRAGMA journal_mode=WAL")
        await self.conn.execute("PRAGMA synchronous=NORMAL")
        await self.conn.executescript(SCHEMA)
        await self.conn.commit()

    async def close(self) -> None:
        if self.conn:
            await self.conn.close()

    async def exec(self, sql: str, params: Iterable[Any] = ()) -> int:
        assert self.conn
        cur = await self.conn.execute(sql, tuple(params))
        await self.conn.commit()
        return cur.lastrowid or cur.rowcount

    async def many(self, sql: str, rows: list[Iterable[Any]]) -> None:
        assert self.conn
        if rows:
            await self.conn.executemany(sql, [tuple(r) for r in rows])
            await self.conn.commit()

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
