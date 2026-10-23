"""Encrypt API keys at rest (AES-256-GCM). Keys never go back to the browser."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .config import settings


def _key() -> bytes:
    env = os.environ.get("RADAR_SECRET")
    if env:
        return hashlib.sha256(env.encode()).digest()
    path = settings.db_path.parent / "secret.key"
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_bytes(AESGCM.generate_key(bit_length=256))
        path.chmod(0o600)
    return path.read_bytes()


def encrypt(data: dict) -> str:
    nonce = os.urandom(12)
    ct = AESGCM(_key()).encrypt(nonce, json.dumps(data).encode(), None)
    return base64.b64encode(nonce + ct).decode()


def decrypt(blob: str | None) -> dict:
    if not blob:
        return {}
    raw = base64.b64decode(blob)
    return json.loads(AESGCM(_key()).decrypt(raw[:12], raw[12:], None))


def mask(value: str) -> str:
    return "" if not value else ("•" * 6 + value[-4:] if len(value) > 8 else "•" * len(value))
