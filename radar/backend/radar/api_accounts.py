"""Account endpoints: sign up, verify, log in (remembered), log out, reset password, devices, owner tools."""
from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from . import auth
from .accounts import COOKIE
from .app import S

router = APIRouter(prefix="/api/auth")


def _ip(request: Request) -> str:
    return (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "?")).split(",")[0].strip()


def _base(request: Request) -> str:
    u = os.environ.get("PUBLIC_URL") or os.environ.get("RENDER_EXTERNAL_URL")
    if u:
        return u.rstrip("/")
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    return f"{proto}://{request.headers.get('host', request.url.netloc)}"


def _secure(request: Request) -> bool:
    return request.headers.get("x-forwarded-proto", request.url.scheme) == "https"


async def _me(request: Request) -> dict[str, Any] | None:
    return await auth.current_user(dict(request.cookies))


async def _owner(request: Request) -> dict[str, Any]:
    u = await _me(request)
    if not u or u["role"] != "owner":
        raise HTTPException(403, "Owner only")
    return u


@router.get("/me")
async def me(request: Request) -> dict[str, Any]:
    return {"user": await _me(request), "signup_open": await S.accounts.signup_open(), "has_users": auth.HAS_USERS[0],
            "email_configured": await S.mailer.configured(), "legacy_password": bool(auth.password())}


class SignupBody(BaseModel):
    email: str
    password: str
    name: str | None = None
    remember: bool = True


@router.post("/signup")
async def signup(b: SignupBody, request: Request, response: Response) -> dict[str, Any]:
    """Creates the account and signs this device in straight away (no verification email)."""
    from .accounts import rate_ok
    if not rate_ok(f"signup:{_ip(request)}", 5):
        raise HTTPException(429, "Too many sign-ups from here — wait a minute")
    try:
        token, user, max_age = await S.accounts.signup(b.email, b.password, b.name, _ip(request),
                                                       request.headers.get("user-agent", ""), b.remember)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    auth.HAS_USERS[0] = True
    response.set_cookie(COOKIE, token, max_age=max_age or None, httponly=True, secure=_secure(request), samesite="lax")
    return {"ok": True, "user": user, "role": user["role"]}


class TokenBody(BaseModel):
    token: str


@router.post("/verify")
async def verify(b: TokenBody, request: Request, response: Response) -> dict[str, Any]:
    try:
        u = await S.accounts.verify(b.token)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "user": u}


class EmailBody(BaseModel):
    email: str


@router.post("/resend")
async def resend(b: EmailBody, request: Request) -> dict[str, Any]:
    from .accounts import rate_ok
    if not rate_ok(f"resend:{_ip(request)}", 3):
        raise HTTPException(429, "Wait a minute before asking again")
    return await S.accounts.resend(b.email, _base(request))


@router.post("/forgot")
async def forgot(b: EmailBody, request: Request) -> dict[str, Any]:
    from .accounts import rate_ok
    if not rate_ok(f"forgot:{_ip(request)}", 3):
        raise HTTPException(429, "Wait a minute before asking again")
    return await S.accounts.forgot(b.email, _base(request))


class ResetBody(BaseModel):
    token: str
    password: str


@router.post("/reset")
async def reset(b: ResetBody) -> dict[str, Any]:
    try:
        await S.accounts.reset(b.token, b.password)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


class LoginBody(BaseModel):
    email: str
    password: str
    remember: bool = True


@router.post("/login")
async def login(b: LoginBody, request: Request, response: Response) -> dict[str, Any]:
    try:
        token, user, max_age = await S.accounts.login(b.email, b.password, b.remember, _ip(request), request.headers.get("user-agent", ""))
    except PermissionError as e:
        raise HTTPException(401, str(e)) from e
    response.set_cookie(COOKIE, token, max_age=max_age or None, httponly=True, secure=_secure(request), samesite="lax")
    return {"ok": True, "user": user}


@router.post("/logout")
async def logout(request: Request, response: Response) -> dict[str, Any]:
    await S.accounts.logout(request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE)
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


@router.get("/sessions")
async def sessions(request: Request) -> list[dict[str, Any]]:
    u = await _me(request)
    if not u or not u.get("id"):
        return []
    return await S.accounts.sessions(u["id"], request.cookies.get(COOKIE))


@router.delete("/sessions/{sid}")
async def revoke(sid: str, request: Request) -> dict[str, Any]:
    u = await _me(request)
    if not u or not u.get("id"):
        raise HTTPException(401, "login required")
    await S.accounts.revoke(u["id"], sid)
    return {"ok": True}


# ---------------- owner tools ----------------
@router.get("/users")
async def users(request: Request) -> list[dict[str, Any]]:
    await _owner(request)
    return await S.accounts.users()


class UserPatch(BaseModel):
    role: str | None = None
    verified: bool | None = None


@router.post("/users/{uid}")
async def patch_user(uid: int, b: UserPatch, request: Request) -> dict[str, Any]:
    me_ = await _owner(request)
    if me_.get("id") == uid and b.role == "member":
        raise HTTPException(400, "You can't demote yourself")
    await S.accounts.set_user(uid, b.role, b.verified)
    return {"ok": True}


@router.delete("/users/{uid}")
async def delete_user(uid: int, request: Request) -> dict[str, Any]:
    me_ = await _owner(request)
    if me_.get("id") == uid:
        raise HTTPException(400, "You can't delete your own account here")
    await S.accounts.delete_user(uid)
    auth.HAS_USERS[0] = await S.accounts.any_users()
    return {"ok": True}


class SignupSetting(BaseModel):
    open: bool


@router.post("/signup-setting")
async def signup_setting(b: SignupSetting, request: Request) -> dict[str, Any]:
    await _owner(request)
    await S.cfg.kv_set("accounts:signup_open", b.open)
    return {"signup_open": b.open}
