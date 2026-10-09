"""YAML config (config/*.yaml) + per-key overrides saved from the Settings page (kv table)."""
from __future__ import annotations

import copy
import json
import time
from pathlib import Path
from typing import Any

import yaml

from .db import DB

_ROOTS = [Path("../config"), Path("config"), Path("/app/config")]


def _find(name: str) -> Path | None:
    for r in _ROOTS:
        if (r / name).exists():
            return r / name
    return None


def load_yaml(name: str) -> dict[str, Any]:
    p = _find(name)
    return (yaml.safe_load(p.read_text()) or {}) if p else {}


def deep_merge(a: dict, b: dict) -> dict:
    out = copy.deepcopy(a)
    for k, v in (b or {}).items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


class Config:
    """Live config. `scoring` and `watch` are file defaults merged with DB overrides."""

    def __init__(self, db: DB) -> None:
        self.db = db
        self.scoring: dict[str, Any] = load_yaml("scoring.yaml")
        self.watch: dict[str, Any] = load_yaml("watch.yaml")
        self.risk: dict[str, Any] = {"bankroll_usd": 1000, "max_pct_per_trade": 1.5, "max_open_positions": 5,
                                     "daily_loss_limit_pct": 5, "cooldown_hours": 12, "timezone": "America/New_York",
                                     "brief_times": ["07:30", "19:30"]}

    async def load(self) -> None:
        for name in ("scoring", "watch", "risk"):
            row = await self.db.one("SELECT value FROM kv WHERE key=?", (f"cfg:{name}",))
            if row:
                setattr(self, name, deep_merge(getattr(self, name), json.loads(row["value"])))

    async def save(self, name: str, patch: dict[str, Any]) -> dict[str, Any]:
        if name not in ("scoring", "watch", "risk"):
            raise ValueError("unknown config")
        row = await self.db.one("SELECT value FROM kv WHERE key=?", (f"cfg:{name}",))
        cur = json.loads(row["value"]) if row else {}
        cur = deep_merge(cur, patch)
        await self.db.upsert("kv", {"key": f"cfg:{name}", "value": json.dumps(cur), "updated": time.time()}, "key")
        setattr(self, name, deep_merge(load_yaml(f"{name}.yaml") if name != "risk" else getattr(self, name), cur))
        return getattr(self, name)

    async def reset(self, name: str) -> None:
        await self.db.exec("DELETE FROM kv WHERE key=?", (f"cfg:{name}",))
        if name in ("scoring", "watch"):
            setattr(self, name, load_yaml(f"{name}.yaml"))

    async def kv_get(self, key: str, default: Any = None) -> Any:
        row = await self.db.one("SELECT value FROM kv WHERE key=?", (key,))
        return json.loads(row["value"]) if row else default

    async def kv_set(self, key: str, value: Any) -> None:
        await self.db.upsert("kv", {"key": key, "value": json.dumps(value), "updated": time.time()}, "key")
