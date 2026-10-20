"""Accounts: hashing, sign-up signs you in (no verification), login (remembered, rolling), reset, sessions, roles, sign-up policy."""
import asyncio
import re
import time

import pytest

from radar.accounts import Accounts, check_password, hash_password, password_problem
from radar.db import DB


class KV:
    def __init__(self):
        self.d = {}

    async def kv_get(self, k, default=None):
        return self.d.get(k, default)

    async def kv_set(self, k, v):
        self.d[k] = v


class Mail:
    def __init__(self):
        self.out = []

    async def send(self, to, subject, html, text):
        self.out.append((to, subject, text))
        return {"sent": True, "via": "test"}

    async def configured(self):
        return True


def link_token(text: str) -> str:
    return re.search(r"token=([\w-]+)", text).group(1)


def test_password_hashing():
    h = hash_password("correct horse 9")
    assert h.startswith("scrypt$") and "correct" not in h
    assert check_password("correct horse 9", h) and not check_password("wrong", h)
    assert password_problem("short") and password_problem("alllowercaseletters") and not password_problem("Goodpassword1")


def test_signup_verify_login_reset_and_roles(tmp_path):
    async def run():
        db = DB(tmp_path / "a.db")
        await db.open()
        mail, kv = Mail(), KV()
        acc = Accounts(db, kv, mail)
        t0, u0, age0 = await acc.signup("Me@Example.com", "Sup3rsecret!", "Ben", "1.1.1.1", "Chrome")
        assert u0["role"] == "owner" and age0 == 400 * 86400 and not mail.out          # signed in, no email sent
        assert (await acc.user_for(t0))["email"] == "me@example.com"
        token, user, max_age = await acc.login("ME@example.com", "Sup3rsecret!", True, "1.1.1.1", "Firefox")
        assert user["role"] == "owner" and max_age == 400 * 86400
        assert (await acc.user_for(token))["email"] == "me@example.com"
        # rolling: a remembered device that keeps coming back keeps getting pushed out to 90 days
        await db.exec("UPDATE sessions SET last_seen=?, expires=? WHERE user_id=?", (time.time() - 3600, time.time() + 60, user["id"]))
        acc.cache.clear()
        assert await acc.user_for(token) and await acc.user_for(t0)
        assert all(r["expires"] > time.time() + 89 * 86400 for r in await db.all("SELECT expires FROM sessions"))
        row = await db.one("SELECT token_hash FROM sessions")
        assert token not in row["token_hash"]                           # only a hash is stored
        _, _, short = await acc.login("me@example.com", "Sup3rsecret!", False, "1.1.1.1", "Phone")
        assert short == 0 and len(await acc.sessions(user["id"], token)) == 3
        with pytest.raises(PermissionError, match="Wrong"):
            await acc.login("me@example.com", "nope", True, "2.2.2.2", "x")
        # sign-ups close once an owner exists, unless the owner opens them; later accounts are read-only members
        with pytest.raises(PermissionError, match="closed"):
            await acc.signup("friend@example.com", "Friendpass1", None)
        await kv.kv_set("accounts:signup_open", True)
        assert (await acc.signup("friend@example.com", "Friendpass1", None))[1]["role"] == "member"
        with pytest.raises(ValueError, match="exists"):
            await acc.signup("friend@example.com", "Friendpass1", None)
        # reset: link → new password → every device signed out
        await acc.forgot("me@example.com", "https://radar.test")
        await acc.reset(link_token(mail.out[-1][2]), "Newpassword22")
        assert await acc.user_for(token) is None
        await acc.login("me@example.com", "Newpassword22", True, "1.1.1.1", "x")
        await acc.logout(token)
        await db.close()
    asyncio.run(run())
