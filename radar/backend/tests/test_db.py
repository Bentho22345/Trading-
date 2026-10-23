import asyncio
import sqlite3

from radar.db import DB


def test_migrates_old_schema(tmp_path):
    path = tmp_path / "old.db"
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE tokens (address TEXT PRIMARY KEY, chain TEXT, name TEXT, first_seen REAL NOT NULL)")
    c.execute("INSERT INTO tokens VALUES ('A', 'solana', 'x', 1)")
    c.execute("CREATE TABLE watchlist (address TEXT PRIMARY KEY, added REAL NOT NULL, note TEXT)")
    c.commit()
    c.close()

    async def run():
        db = DB(path)
        await db.open()
        cols = {r["name"] for r in await db.all("PRAGMA table_info(tokens)")}
        wcols = {r["name"] for r in await db.all("PRAGMA table_info(watchlist)")}
        row = await db.one("SELECT * FROM tokens WHERE address='A'")
        await db.close()
        return cols, wcols, row
    cols, wcols, row = asyncio.run(run())
    assert {"best_pair", "last_refresh", "graduated_at", "dev_initial_buy_pct", "image_hash"} <= cols
    assert "rules_json" in wcols and row["name"] == "x"
