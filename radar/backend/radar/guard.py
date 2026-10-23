"""Keeps a long-running Radar healthy on a small server (Render Starter: 0.5 CPU, 512 MB RAM, 2 GB disk).

  disk     every 10 min: checkpoint + truncate the SQLite write-ahead log (it can otherwise grow without bound),
           prune the newer tables, and if the disk gets tight, prune harder (old trader history first)
  memory   if the process gets close to the RAM limit, drop the in-memory caches (they all rebuild themselves)
  status   both numbers go to /api/healthz, so "the site is down" can be diagnosed from one URL
"""
from __future__ import annotations

import asyncio
import gc
import logging
import os
import shutil
import time
from typing import Any

log = logging.getLogger("radar.guard")
STATE: dict[str, Any] = {"disk_free_mb": None, "disk_total_mb": None, "db_mb": None, "wal_mb": None, "last_prune": None,
                         "hard_prunes": 0, "cache_trims": 0, "rss_limit_mb": None}


def rss_mb() -> float | None:
    try:
        with open("/proc/self/statm") as f:
            return round(int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1e6, 1)
    except (OSError, ValueError, IndexError):
        return None


def mem_headroom_mb() -> float | None:
    """MB the container can still allocate before its memory limit (cgroup v2 / v1), else the machine's MemAvailable."""
    def read(path: str) -> str | None:
        try:
            with open(path) as f:
                return f.read().strip()
        except OSError:
            return None
    for lim_p, cur_p in (("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current"),
                         ("/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory/memory.usage_in_bytes")):
        lim, cur = read(lim_p), read(cur_p)
        if lim and cur and lim != "max" and lim.isdigit() and int(lim) < 1 << 50:
            return round((int(lim) - int(cur)) / 1e6, 1)
    info = read("/proc/meminfo") or ""
    for line in info.splitlines():
        if line.startswith("MemAvailable:"):
            return round(int(line.split()[1]) / 1e3, 1)
    return None


def _size(p: str) -> float | None:
    try:
        return round(os.path.getsize(p) / 1e6, 1)
    except OSError:
        return None


async def prune_extra(db: Any, hard: bool = False) -> None:
    now = time.time()
    day = 86400
    for sql, age in (("DELETE FROM x_tweets WHERE ts < ?", 7), ("DELETE FROM x_spawns WHERE ts < ?", 7),
                     ("DELETE FROM x_calls WHERE ts < ?", 30), ("DELETE FROM x_events WHERE ts < ?", 30),
                     ("DELETE FROM wallet_intel WHERE checked < ?", 14), ("DELETE FROM ai_labels WHERE ts < ?", 3),
                     ("DELETE FROM strategy_hits WHERE ts < ?", 45), ("DELETE FROM snipe_calls WHERE call_ts < ?", 60),
                     ("DELETE FROM auto_orders WHERE ts < ?", 90), ("DELETE FROM auto_equity WHERE ts < ?", 30), ("DELETE FROM trend_items WHERE ts < ?", 3)):
        try:
            await db.exec(sql, (now - age * day,))
        except Exception:  # noqa: BLE001 - a table from a newer feature may not exist yet
            pass
    # the Helius 1-year backfill can store millions of wallet trades; keep the newest N (the leaderboard needs recent ones most)
    try:
        cap = int(os.environ.get("TRADER_TRADES_MAX", "1200000"))
        row = await db.one("SELECT ts FROM trader_trades ORDER BY ts DESC LIMIT 1 OFFSET ?", (cap,))
        if row:
            await db.exec("DELETE FROM trader_trades WHERE ts <= ?", (row["ts"],))
            STATE["trades_capped"] = STATE.get("trades_capped", 0) + 1
    except Exception:  # noqa: BLE001
        pass
    if hard:
        STATE["hard_prunes"] += 1
        for sql, age in (("DELETE FROM trader_trades WHERE ts < ?", 120), ("DELETE FROM pump_trades WHERE ts < ?", 1),
                         ("DELETE FROM price_ticks WHERE ts < ?", 1), ("DELETE FROM social_events WHERE ts < ?", 1),
                         ("DELETE FROM x_tweets WHERE ts < ?", 2)):
            try:
                await db.exec(sql, (now - age * day,))
            except Exception:  # noqa: BLE001
                pass


async def disk_loop(db: Any, path: str) -> None:
    await asyncio.sleep(60)
    while True:
        try:
            d = os.path.dirname(os.path.abspath(path)) or "."
            du = shutil.disk_usage(d)
            free = du.free / 1e6
            STATE.update(disk_free_mb=round(free), disk_total_mb=round(du.total / 1e6), db_mb=_size(path), wal_mb=_size(path + "-wal"))
            hard = free < max(250.0, min(du.total / 1e6 * 0.12, 1000.0))   # 2 GB disk → 250 MB; big disks → ≤ 1 GB
            await prune_extra(db, hard=hard)
            try:   # PASSIVE never waits on readers; journal_size_limit then shrinks the WAL file
                await db.exec("PRAGMA wal_checkpoint(PASSIVE)")
            except Exception as e:  # noqa: BLE001
                log.debug("checkpoint: %s", e)
            if hard:
                log.warning("disk low (%.0f MB free): pruned hard", free)
            STATE["last_prune"] = time.time()
            STATE["wal_mb"] = _size(path + "-wal")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("disk guard: %s", e)
        await asyncio.sleep(600)


async def memory_loop(S: Any) -> None:
    limit = float(os.environ.get("RADAR_RSS_LIMIT_MB", "430"))
    STATE["rss_limit_mb"] = limit
    while True:
        await asyncio.sleep(30)
        r = rss_mb()
        if r is None or r < limit:
            continue
        STATE["cache_trims"] += 1
        log.warning("memory %.0f MB ≥ %.0f MB: trimming caches", r, limit)
        for obj, attr in ((getattr(S, "onchain", None), "cache"), (getattr(S, "sniper", None), "dev_cache"),
                          (getattr(S, "social", None), "text_authors")):
            try:
                getattr(obj, attr).clear()
            except AttributeError:
                pass
        sn = getattr(S, "sniper", None)
        if sn is not None:
            now = time.time()
            for m in [m for m, L in sn.launches.items() if not L.result or (L.result.get("tier") in ("PASS", "TRAP") and now - L.created > 600)]:
                sn.launches.pop(m, None)
        gc.collect()
