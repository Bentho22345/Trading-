"""Accounts: email + password sign-up (signed in straight away, no verification email), remembered log-ins,
password reset, owner / member roles.

  users          email (unique, lower-case), scrypt password hash (stdlib, salted, N=2^14), role
  sessions       one row per signed-in device: only a SHA-256 of the cookie token is stored, so a leaked database
                 can't be replayed; "remember me" = 90 days that ROLL forward every time you use the site (so a device
                 you use stays signed in), otherwise 12 hours; last-seen, device and IP shown on the Account page where
                 any device can be signed out
  email_tokens   single-use password-reset links (hashed), 1h

  The first account becomes the OWNER (everything, including Autopilot real money and the trading wallet). Sign-ups
  after that are closed unless the owner opens them; later accounts are MEMBERS (read-only) unless promoted.
  The old RADAR_PASSWORD still works as an owner login, so nobody gets locked out by the upgrade.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import os
import re
import secrets as pysecrets
import time
from collections import defaultdict, deque
from typing import Any

log = logging.getLogger("radar.accounts")
COOKIE = "radar_sid"
REMEMBER_S = 90 * 86400            # rolling: every visit pushes the expiry out again
COOKIE_S = 400 * 86400             # the browser keeps the cookie; the server-side expiry is what counts
SESSION_S = 12 * 3600
EMAIL_RX = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,24}$")
_attempts: dict[str, deque] = defaultdict(lambda: deque(maxlen=50))


def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${base64.b64encode(salt).decode()}${base64.b64encode(h).decode()}"


def check_password(pw: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, h = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got, base64.b64decode(h))
    except (ValueError, TypeError):
        return False


def _h(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def rate_ok(key: str, per_min: int = 10) -> bool:
    q = _attempts[key]
    now = time.time()
    while q and q[0] < now - 60:
        q.popleft()
    if len(q) >= per_min:
        return False
    q.append(now)
    return True


def password_problem(pw: str) -> str | None:
    if len(pw) < 10:
        return "Use at least 10 characters"
    if not re.search(r"[\dA-Z]|[^\w\s]", pw):
        return "Mix in a number, a capital letter or a symbol"
    return None


class Accounts:
    def __init__(self, db: Any, cfg: Any, mailer: Any) -> None:
        self.db, self.cfg, self.mailer = db, cfg, mailer
        self.cache: dict[str, tuple[float, dict[str, Any] | None]] = {}   # token hash -> (checked_at, user) — gate stays fast

    async def any_users(self) -> bool:
        return bool(await self.db.one("SELECT 1 FROM users LIMIT 1"))

    async def signup_open(self) -> bool:
        if not await self.any_users():
            return True
        return bool(await self.cfg.kv_get("accounts:signup_open", False))

    async def init(self) -> None:
        await self.db.exec("UPDATE users SET verified=1 WHERE verified=0")     # verification is gone: nobody stays locked out

    # ---------------- sign-up ----------------
    async def signup(self, email: str, password: str, name: str | None, ip: str = "", ua: str = "",
                     remember: bool = True) -> tuple[str, dict[str, Any], int]:
        email = (email or "").strip().lower()
        if not EMAIL_RX.match(email):
            raise ValueError("That doesn't look like an email address")
        prob = password_problem(password or "")
        if prob:
            raise ValueError(prob)
        if not await self.signup_open():
            raise PermissionError("Sign-ups are closed — ask the owner to open them on their Account page")
        if await self.db.one("SELECT 1 FROM users WHERE email=?", (email,)):
            raise ValueError("An account with that email already exists — log in or reset the password")
        role = "member" if await self.any_users() else "owner"
        pw_hash = await asyncio.to_thread(hash_password, password)
        uid = await self.db.exec("INSERT INTO users (email, pw_hash, role, verified, created, name) VALUES (?,?,?,?,?,?)",
                                 (email, pw_hash, role, 1, time.time(), (name or "").strip()[:60] or None))
        u = await self.db.one("SELECT * FROM users WHERE id=?", (uid,))
        return await self._session(u, remember, ip, ua)

    async def send_link(self, uid: int, email: str, kind: str, base_url: str) -> dict[str, Any]:
        token = pysecrets.token_urlsafe(32)
        ttl = 86400 if kind == "verify" else 3600
        await self.db.exec("INSERT INTO email_tokens (token_hash, user_id, kind, created, expires, used) VALUES (?,?,?,?,?,0)",
                           (_h(token), uid, kind, time.time(), time.time() + ttl))
        link = f"{base_url.rstrip('/')}/{'verify' if kind == 'verify' else 'reset'}?token={token}"
        subject = "Verify your Memecoin Radar account" if kind == "verify" else "Reset your Memecoin Radar password"
        action = "Verify my email" if kind == "verify" else "Choose a new password"
        expl = ("Confirm this email to finish creating your account." if kind == "verify"
                else "Someone (hopefully you) asked to reset your password. The link works for 1 hour.")
        html = (f"<div style=\"font-family:system-ui,sans-serif;background:#07040d;color:#ece6ff;padding:32px\">"
                f"<h2 style=\"margin:0 0 12px;color:#b388ff\">Memecoin Radar</h2><p>{expl}</p>"
                f"<p><a href=\"{link}\" style=\"display:inline-block;background:#8b5cf6;color:#fff;padding:12px 20px;border-radius:999px;"
                f"text-decoration:none;font-weight:700\">{action}</a></p><p style=\"color:#9a8fb8;font-size:12px\">Or paste this link: {link}</p>"
                f"<p style=\"color:#9a8fb8;font-size:12px\">Didn't ask for this? Ignore this email.</p></div>")
        res = await self.mailer.send(email, subject, html, f"{expl}\n\n{link}")
        if not res.get("sent"):
            # no email provider configured: the link goes to the server log (Render → Logs) so the owner can still finish
            log.warning("EMAIL NOT CONFIGURED — %s link for %s: %s", kind, email, link)
        return {"sent": bool(res.get("sent")), "via": res.get("via"), "error": res.get("error")}

    async def use_token(self, token: str, kind: str) -> int:
        row = await self.db.one("SELECT * FROM email_tokens WHERE token_hash=? AND kind=?", (_h(token or ""), kind))
        if not row or row["used"] or row["expires"] < time.time():
            raise ValueError("This link is invalid or has expired — request a new one")
        await self.db.exec("UPDATE email_tokens SET used=1 WHERE token_hash=?", (row["token_hash"],))
        return int(row["user_id"])

    async def verify(self, token: str) -> dict[str, Any]:
        uid = await self.use_token(token, "verify")
        await self.db.exec("UPDATE users SET verified=1 WHERE id=?", (uid,))
        return await self.db.one("SELECT id, email, role, name FROM users WHERE id=?", (uid,))

    async def resend(self, email: str, base_url: str) -> dict[str, Any]:
        return {"sent": True, "note": "Email verification is off — just log in"}

    async def forgot(self, email: str, base_url: str) -> dict[str, Any]:
        u = await self.db.one("SELECT id, email FROM users WHERE email=?", ((email or "").strip().lower(),))
        if u:
            await self.send_link(u["id"], u["email"], "reset", base_url)
        return {"sent": True}

    async def reset(self, token: str, password: str) -> None:
        prob = password_problem(password or "")
        if prob:
            raise ValueError(prob)
        uid = await self.use_token(token, "reset")
        await self.db.exec("UPDATE users SET pw_hash=?, verified=1 WHERE id=?", (await asyncio.to_thread(hash_password, password), uid))
        await self.db.exec("DELETE FROM sessions WHERE user_id=?", (uid,))     # every old device signs out
        self.cache.clear()

    # ---------------- log in / sessions ----------------
    async def login(self, email: str, password: str, remember: bool, ip: str, ua: str) -> tuple[str, dict[str, Any], int]:
        email = (email or "").strip().lower()
        if not rate_ok(f"ip:{ip}", 10) or not rate_ok(f"em:{email}", 8):
            raise PermissionError("Too many attempts — wait a minute")
        u = await self.db.one("SELECT * FROM users WHERE email=?", (email,))
        if u:
            ok = await asyncio.to_thread(check_password, password or "", u["pw_hash"])
        else:                                                                    # same timing for unknown emails
            ok = await asyncio.to_thread(lambda: check_password("x", hash_password("y")) and False)
        if not u or not ok:
            raise PermissionError("Wrong email or password")
        return await self._session(u, remember, ip, ua)

    async def _session(self, u: dict[str, Any], remember: bool, ip: str, ua: str) -> tuple[str, dict[str, Any], int]:
        token = pysecrets.token_urlsafe(32)
        ttl = REMEMBER_S if remember else SESSION_S
        now = time.time()
        await self.db.exec("INSERT INTO sessions (token_hash, user_id, created, expires, last_seen, ua, ip, remember) VALUES (?,?,?,?,?,?,?,?)",
                           (_h(token), u["id"], now, now + ttl, now, (ua or "")[:200], ip, 1 if remember else 0))
        await self.db.exec("UPDATE users SET last_login=? WHERE id=?", (now, u["id"]))
        return token, {"id": u["id"], "email": u["email"], "role": u["role"], "name": u["name"]}, (COOKIE_S if remember else 0)

    async def user_for(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        th = _h(token)
        hit = self.cache.get(th)
        now = time.time()
        if hit and now - hit[0] < 30:
            return hit[1]
        row = await self.db.one("SELECT s.token_hash, s.expires, s.last_seen, s.remember, u.id, u.email, u.role, u.name FROM sessions s "
                                "JOIN users u ON u.id=s.user_id WHERE s.token_hash=?", (th,))
        user = None
        if row and row["expires"] > now:
            user = {"id": row["id"], "email": row["email"], "role": row["role"], "name": row["name"]}
            if now - (row["last_seen"] or 0) > 300:          # rolling: a remembered device you keep using never gets logged out
                exp = max(row["expires"], now + REMEMBER_S) if row["remember"] else row["expires"]
                await self.db.exec("UPDATE sessions SET last_seen=?, expires=? WHERE token_hash=?", (now, exp, th))
        if len(self.cache) > 5000:
            self.cache.clear()
        self.cache[th] = (now, user)
        return user

    async def logout(self, token: str | None) -> None:
        if token:
            await self.db.exec("DELETE FROM sessions WHERE token_hash=?", (_h(token),))
            self.cache.pop(_h(token), None)

    async def sessions(self, uid: int, current: str | None) -> list[dict[str, Any]]:
        cur = _h(current) if current else None
        rows = await self.db.all("SELECT token_hash, created, expires, last_seen, ua, ip, remember FROM sessions WHERE user_id=? AND expires > ? "
                                 "ORDER BY last_seen DESC", (uid, time.time()))
        return [{"id": r["token_hash"][:16], "created": r["created"], "expires": r["expires"], "last_seen": r["last_seen"], "device": r["ua"],
                 "ip": r["ip"], "remember": bool(r["remember"]), "current": r["token_hash"] == cur} for r in rows]

    async def revoke(self, uid: int, sid: str) -> None:
        rows = await self.db.all("SELECT token_hash FROM sessions WHERE user_id=?", (uid,))
        for r in rows:
            if r["token_hash"].startswith(sid):
                await self.db.exec("DELETE FROM sessions WHERE token_hash=?", (r["token_hash"],))
                self.cache.pop(r["token_hash"], None)

    async def prune(self) -> None:
        await self.db.exec("DELETE FROM sessions WHERE expires < ?", (time.time(),))
        await self.db.exec("DELETE FROM email_tokens WHERE expires < ?", (time.time() - 86400,))

    # ---------------- owner tools ----------------
    async def users(self) -> list[dict[str, Any]]:
        return await self.db.all("SELECT id, email, role, verified, created, last_login, name FROM users ORDER BY id")

    async def set_user(self, uid: int, role: str | None = None, verified: bool | None = None) -> None:
        if role in ("owner", "member"):
            await self.db.exec("UPDATE users SET role=? WHERE id=?", (role, uid))
        if verified is not None:
            await self.db.exec("UPDATE users SET verified=? WHERE id=?", (1 if verified else 0, uid))
        self.cache.clear()

    async def delete_user(self, uid: int) -> None:
        await self.db.exec("DELETE FROM sessions WHERE user_id=?", (uid,))
        await self.db.exec("DELETE FROM users WHERE id=?", (uid,))
        self.cache.clear()
