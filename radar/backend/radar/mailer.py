"""Outgoing email for account verification and password resets.

Two ways, set on the Connectors page (Email):
  Resend      an API key from resend.com (free tier: 3,000 emails / month) — easiest
  SMTP        any mail server, e.g. Gmail with an App Password (smtp.gmail.com, port 587)
With neither, links are written to the server log (Render → Logs) so the owner can still finish a sign-up.
"""
from __future__ import annotations

import asyncio
import os
import smtplib
import ssl
from email.message import EmailMessage
from typing import Any

import httpx

from .health import Health, register

mail_h = register(Health("email", "rest", "Account emails (verification, password reset) via Resend or SMTP"))
mail_h.stale_after = 30 * 86400


class Mailer:
    def __init__(self, connectors: Any) -> None:
        self.connectors = connectors
        self.client = httpx.AsyncClient(timeout=15)

    async def configured(self) -> bool:
        v = await self.connectors.values("email")
        return bool(v.get("from_address") and (v.get("resend_api_key") or v.get("smtp_host")))

    async def send(self, to: str, subject: str, html: str, text: str) -> dict[str, Any]:
        v = await self.connectors.values("email")
        frm = v.get("from_address")
        if not frm:
            return {"sent": False, "via": None, "error": "email not configured"}
        try:
            if v.get("resend_api_key"):
                r = await self.client.post(f"{os.environ.get('RESEND_API_URL', 'https://api.resend.com')}/emails",
                                           headers={"Authorization": f"Bearer {v['resend_api_key']}"},
                                           json={"from": frm, "to": [to], "subject": subject, "html": html, "text": text})
                if r.status_code >= 300:
                    raise RuntimeError(f"Resend {r.status_code}: {r.text[:160]}")
                mail_h.ok()
                return {"sent": True, "via": "resend"}
            if v.get("smtp_host"):
                await asyncio.to_thread(self._smtp, v, frm, to, subject, html, text)
                mail_h.ok()
                return {"sent": True, "via": "smtp"}
        except Exception as e:  # noqa: BLE001
            mail_h.fail(str(e)[:200])
            return {"sent": False, "via": None, "error": str(e)[:200]}
        return {"sent": False, "via": None, "error": "email not configured"}

    @staticmethod
    def _smtp(v: dict[str, str], frm: str, to: str, subject: str, html: str, text: str) -> None:
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = frm, to, subject
        msg.set_content(text)
        msg.add_alternative(html, subtype="html")
        port = int(v.get("smtp_port") or 587)
        if port == 465:
            with smtplib.SMTP_SSL(v["smtp_host"], port, context=ssl.create_default_context(), timeout=20) as s:
                if v.get("smtp_user"):
                    s.login(v["smtp_user"], v.get("smtp_password") or "")
                s.send_message(msg)
        else:
            with smtplib.SMTP(v["smtp_host"], port, timeout=20) as s:
                s.starttls(context=ssl.create_default_context())
                if v.get("smtp_user"):
                    s.login(v["smtp_user"], v.get("smtp_password") or "")
                s.send_message(msg)
