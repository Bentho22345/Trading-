"""Accounts: hashing, sign-up → verification email → login (remembered), reset, sessions, roles, sign-up policy."""
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
        r = await acc.signup("Me@Example.com", "Sup3rsecret!", "Ben", "https://radar.test")
        assert r["role"] == "owner" and r["sent"] and mail.out[0][0] == "me@example.com"
        with pytest.raises(PermissionError, match="Verify"):
            await acc.login("me@example.com", "Sup3rsecret!", True, "1.1.1.1", "ua")
        tok = link_token(mail.out[0][2])
        u = await acc.verify(tok)
        assert u["email"] == "me@example.com"
        with pytest.raises(ValueError):
            await acc.verify(tok)                                       # single use
        token, user, max_age = await acc.login("ME@example.com", "Sup3rsecret!", True, "1.1.1.1", "Firefox")
        assert user["role"] == "owner" and max_age == 30 * 86400
        assert (await acc.user_for(token))["email"] == "me@example.com"
        row = await db.one("SELECT token_hash FROM sessions")
        assert token not in row["token_hash"]                           # only a hash is stored
        _, _, short = await acc.login("me@example.com", "Sup3rsecret!", False, "1.1.1.1", "Phone")
        assert short == 0 and len(await acc.sessions(user["id"], token)) == 2
        with pytest.raises(PermissionError, match="Wrong"):
            await acc.login("me@example.com", "nope", True, "2.2.2.2", "x")
        # sign-ups close once an owner exists, unless the owner opens them; later accounts are read-only members
        with pytest.raises(PermissionError, match="closed"):
            await acc.signup("friend@example.com", "Friendpass1", None, "https://radar.test")
        await kv.kv_set("accounts:signup_open", True)
        assert (await acc.signup("friend@example.com", "Friendpass1", None, "https://radar.test"))["role"] == "member"
        with pytest.raises(ValueError, match="exists"):
            await acc.signup("friend@example.com", "Friendpass1", None, "https://radar.test")
        # reset: link → new password → every device signed out
        await acc.forgot("me@example.com", "https://radar.test")
        await acc.reset(link_token(mail.out[-1][2]), "Newpassword22")
        assert await acc.user_for(token) is None
        await acc.login("me@example.com", "Newpassword22", True, "1.1.1.1", "x")
        await acc.logout(token)
        await db.close()
    asyncio.run(run())
