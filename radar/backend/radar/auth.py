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
