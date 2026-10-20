"""Optional single-user password gate (set RADAR_PASSWORD). Required when the app is on a public URL (e.g. Render)."""
from __future__ import annotations

import hashlib
import hmac
import os
import time
from collections import defaultdict, deque

from fastapi import Request

from .secrets import _key

COOKIE = "radar_session"
OPEN_PATHS = {"/api/login", "/api/logout", "/api/session", "/api/healthz"}
_attempts: dict[str, deque] = defaultdict(lambda: deque(maxlen=20))


def password() -> str | None:
    return os.environ.get("RADAR_PASSWORD") or None


def session_token() -> str:
    pw = password() or ""
    return hmac.new(_key(), f"radar-session:{pw}".encode(), hashlib.sha256).hexdigest()


def is_authed(cookies: dict[str, str]) -> bool:
    if not password():
        return True
    return hmac.compare_digest(cookies.get(COOKIE, ""), session_token())


def check_password(given: str, ip: str) -> bool:
    q = _attempts[ip]
    now = time.time()
    while q and q[0] < now - 60:
        q.popleft()
    if len(q) >= 10:
        return False  # 10 attempts / minute / IP
    q.append(now)
    pw = password()
    return bool(pw) and hmac.compare_digest(given.encode(), pw.encode())


def needs_auth(request: Request) -> bool:
    p = request.url.path
    return bool(password()) and p.startswith("/api/") and p not in OPEN_PATHS


# ---------------- accounts (email + password) on top of the legacy single password ----------------
ACCOUNTS = None          # set by the app: radar.accounts.Accounts
HAS_USERS = [False]      # cached: any account exists (then the gate is on even without RADAR_PASSWORD)
OWNER_LEGACY = {"id": 0, "email": "owner (RADAR_PASSWORD)", "role": "owner", "name": "Owner"}


def protected() -> bool:
    """Is this Radar locked at all? (a RADAR_PASSWORD or at least one account)"""
    return bool(password()) or HAS_USERS[0]


async def current_user(cookies: dict[str, str]) -> dict | None:
    if password() and hmac.compare_digest(cookies.get(COOKIE, ""), session_token()):
        return OWNER_LEGACY
    if ACCOUNTS is not None:
        from .accounts import COOKIE as SID
        return await ACCOUNTS.user_for(cookies.get(SID))
    return None


async def reauth(user: dict | None, given: str | None, ip: str) -> bool:
    """Re-check the password for sensitive actions (real money, withdrawals, key export)."""
    if not protected():
        return True
    if not given:
        return False
    if user and user.get("id") and ACCOUNTS is not None:
        row = await ACCOUNTS.db.one("SELECT pw_hash FROM users WHERE id=?", (user["id"],))
        from .accounts import check_password as chk
        import asyncio
        if row and await asyncio.to_thread(chk, given, row["pw_hash"]):
            return True
    return bool(password()) and check_password(given, ip)
