"""Runtime settings. Every tunable lives here or in config/*.yaml, never inline."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _f(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def _i(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


@dataclass(frozen=True)
class Settings:
    db_path: Path = field(default_factory=lambda: Path(_env("RADAR_DB_PATH", "data/radar.db")))
    web_dir: Path = field(default_factory=lambda: Path(_env("RADAR_WEB_DIR", "../web/out")))
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(o for o in _env("RADAR_CORS_ORIGINS", "http://localhost:3000").split(",") if o)
    )

    # Upstream endpoints (overridable so tests can point at local fakes)
    pumpportal_ws: str = field(default_factory=lambda: _env("PUMPPORTAL_WS_URL", "wss://pumpportal.fun/api/data"))
    coinbase_ws: str = field(default_factory=lambda: _env("COINBASE_WS_URL", "wss://ws-feed.exchange.coinbase.com"))
    dexscreener_url: str = field(default_factory=lambda: _env("DEXSCREENER_URL", "https://api.dexscreener.com"))
    geckoterminal_url: str = field(default_factory=lambda: _env("GECKOTERMINAL_URL", "https://api.geckoterminal.com/api/v2"))
    rugcheck_url: str = field(default_factory=lambda: _env("RUGCHECK_URL", "https://api.rugcheck.xyz/v1"))

    # Rate budgets (requests/minute). Defaults sit below the published free limits.
    dex_pairs_rpm: float = field(default_factory=lambda: _f("DEX_PAIRS_RPM", 240))      # published ~300
    dex_profiles_rpm: float = field(default_factory=lambda: _f("DEX_PROFILES_RPM", 50))  # published ~60
    gecko_rpm: float = field(default_factory=lambda: _f("GECKO_RPM", 25))                # published 30
    rugcheck_rpm: float = field(default_factory=lambda: _f("RUGCHECK_RPM", 30))          # unpublished; be polite

    # Poll cadences (seconds)
    gecko_trending_every: float = field(default_factory=lambda: _f("GECKO_TRENDING_EVERY", 20))
    gecko_new_every: float = field(default_factory=lambda: _f("GECKO_NEW_EVERY", 20))
    dex_profiles_every: float = field(default_factory=lambda: _f("DEX_PROFILES_EVERY", 15))
    rugcheck_cache_s: float = field(default_factory=lambda: _f("RUGCHECK_CACHE_S", 300))

    # Scheduler refresh intervals per priority tier (seconds)
    tier_intervals: dict[int, float] = field(default_factory=lambda: {
        0: _f("TIER0_EVERY", 3),    # FLASH / currently viewed
        1: _f("TIER1_EVERY", 6),    # watchlist / positions
        2: _f("TIER2_EVERY", 15),   # graduated, trending, boosted
        3: _f("TIER3_EVERY", 60),   # recent pump.fun launches
    })
    launch_track_minutes: float = field(default_factory=lambda: _f("LAUNCH_TRACK_MINUTES", 30))
    hot_track_hours: float = field(default_factory=lambda: _f("HOT_TRACK_HOURS", 6))
    max_trade_subscriptions: int = field(default_factory=lambda: _i("MAX_TRADE_SUBS", 150))
    retention_hours: float = field(default_factory=lambda: _f("RETENTION_HOURS", 72))


settings = Settings()
