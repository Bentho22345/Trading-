"""Telegram bot: Radar in your pocket — commands, plus pushes of the best coins at YOUR risk appetite.

Commands (only answered in your own chat):
  /top [safe|balanced|degen]   best live launches right now, ranked for that appetite
  /calls                       today's snipe calls and how they're doing (peak ×, now ×)
  /coin <CA or $TICKER>        full read of one coin: detectors, on-chain intel, AI take, YouTube
  /wallets                     latest buys and sells of top / smart wallets
  /intel                       what the engines just found (insider clusters, YouTube mentions, strong memes)
  /x                           the hottest tweet narratives right now (X Radar) and the coins they spawned
  /callers                     X accounts ranked by how their coin calls actually did
  /push <safe|balanced|degen|off>  auto-push coins that clear your appetite's bar (default: degen)
  /mute [minutes] · /unmute    silence pushes (rug / flash warnings still come through)
  /status                      engines, credits and budgets

The first person to message a bot with no chat id configured becomes its owner (same as the Connectors auto-detect).
Read-only: the bot never trades and never sees a key.
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import re
import time
from typing import Any

import httpx

from . import feed
from .alerts import coin_buttons
from .health import Health, register

log = logging.getLogger("radar.tgbot")
bot_h = register(Health("telegram_commands", "rest", "Telegram bot commands (/top /coin /calls /push …)"))
bot_h.stale_after = 3600
PUSH_BAR = {"safe": 38.0, "balanced": 34.0, "degen": 30.0}
HELP = ("<b>Memecoin Radar</b> 🛰\n"
        "/top [safe|balanced|degen] — best live launches\n/calls — today's snipe calls &amp; results\n"
        "/coin &lt;CA or $TICKER&gt; — full read of one coin\n/x — hottest tweet narratives\n/callers — best X callers\n"
        "/wallets — top-wallet trades\n/intel — engine finds\n"
        "/push degen|balanced|safe|off — auto-push coins at your appetite\n/mute 60 · /unmute\n/status — engines &amp; credits\n"
        "<i>Not financial advice. Radar never trades.</i>")


def esc(v: Any) -> str:
    return html.escape(str(v if v is not None else ""))


def usd(v: Any) -> str:
    if not v:
        return "—"
    v = float(v)
    return f"${v / 1e6:.2f}M" if v >= 1e6 else f"${v / 1e3:.1f}k" if v >= 1e3 else f"${v:.0f}"


def age(s: Any) -> str:
    s = float(s or 0)
    return f"{s:.0f}s" if s < 90 else f"{s / 60:.0f}m" if s < 5400 else f"{s / 3600:.1f}h"


def coin_line(i: int, r: dict[str, Any], appetite: str) -> str:
    ai = r.get("ai") or {}
    it = r.get("intel") or {}
    bits = [f"up {r.get('upside', 0):.0f} / risk {r.get('risk', 0):.0f}", f"mc {usd(r.get('mcap_usd'))}", age(r.get("age_s"))]
    if r.get("eta_min") is not None:
        bits.append(f"grad ~{r['eta_min']:.0f}m")
    extra = []
    if r.get("alpha"):
        extra.append(f"🐋 {len(r['alpha'])} top wallets")
    if it.get("insiders"):
        extra.append(f"🧬 {it['insiders']} insiders")
    if (r.get("yt") or {}).get("videos"):
        extra.append(f"▶ {r['yt']['videos']} videos")
    if ai.get("meme_score") is not None:
        extra.append(f"✦ meme {ai['meme_score']}/10")
    score = (r.get("scores") or {}).get(appetite, r.get("score", 0))
    head = f"{i}. <b>${esc(r.get('symbol') or r['mint'][:6])}</b> · {score:.0f} pts · {r.get('tier')}"
    take = f"\n   <i>{esc(ai['take'])}</i>" if ai.get("take") else ""
    return f"{head}\n   {' · '.join(bits)}" + (f"\n   {' · '.join(extra)}" if extra else "") + take + f"\n   <code>{r['mint']}</code>"


def coin_card(r: dict[str, Any]) -> str:
    ai, it, yt = r.get("ai") or {}, r.get("intel") or {}, r.get("yt") or {}
    lines = [f"<b>${esc(r.get('symbol'))}</b> {esc(r.get('name') or '')} · <b>{r.get('tier')}</b> {r.get('score', 0):.0f}",
             f"mc {usd(r.get('mcap_usd'))} · curve {r.get('progress') or 0:.0f}% · {age(r.get('age_s'))} old · "
             f"upside {r.get('upside', 0):.0f} / risk {r.get('risk', 0):.0f}"]
    for d in r.get("detectors") or []:
        lines.append(f"{'🟢' if d.get('good') else '🔴'} <b>{esc(d['label'])}</b> ({d['points']:+.0f}): {esc(d.get('detail'))}")
    if r.get("why_risk"):
        lines.append("⚠️ " + esc(" · ".join(r["why_risk"][:5])))
    if ai:
        lines.append(f"✦ <b>AI</b>: {esc(ai.get('narrative'))} · meme {ai.get('meme_score')}/10 — <i>{esc(ai.get('take'))}</i>"
                     + (f"\n   🚩 {esc(', '.join(ai['red_flags']))}" if ai.get("red_flags") else ""))
    if yt.get("videos"):
        lines.append(f"▶ {yt['videos']} YouTube videos · top: {esc(yt.get('top'))}")
    if it and it.get("chain_top10_pct") is not None:
        lines.append(f"⛓ on-chain top 10: {it['chain_top10_pct']:.0f}%")
    lines.append(f"<code>{r['mint']}</code>")
    return "\n".join(lines)


class TelegramBot:
    def __init__(self, db: Any, cfg: Any, connectors: Any, alerts: Any, sniper: Any) -> None:
        self.db, self.cfg, self.connectors, self.alerts, self.sniper = db, cfg, connectors, alerts, sniper
        self.client = httpx.AsyncClient(timeout=40)
        self.offset = 0
        self.bad_token: str | None = None
        self.status_fn: Any = None
        self.push_mode = "degen"
        self.pushed: dict[str, float] = {}
        self.push_times: list[float] = []
        self.last_cmd: dict[str, Any] | None = None
        self.max_per_hour = int(os.environ.get("TG_PUSH_MAX_PER_HOUR", "8"))
        self.xradar: Any = None

    @property
    def base(self) -> str:
        return os.environ.get("TELEGRAM_API_URL", "https://api.telegram.org")

    async def load(self) -> None:
        self.push_mode = await self.cfg.kv_get("tg:push_mode", "degen") or "degen"
        self.offset = int(await self.cfg.kv_get("tg:offset", 0) or 0)

    # ---------------- polling ----------------
    async def run(self) -> None:
        await self.load()
        while True:
            t0 = time.time()
            try:
                v = await self.connectors.values("telegram_bot")
                token = v.get("bot_token")
                if not token or token == self.bad_token:
                    await asyncio.sleep(3)
                    continue
                r = await self.client.get(f"{self.base}/bot{token}/getUpdates",
                                          params={"offset": self.offset, "timeout": 25, "allowed_updates": json.dumps(["message"])})
                if r.status_code in (401, 404):
                    bot_h.fail("bot token rejected")
                    self.bad_token = token          # wait for a new token instead of hammering Telegram
                    continue
                if r.status_code == 409:       # a webhook is set, or another copy of Radar is polling this bot
                    bot_h.fail("409: another poller / webhook on this bot")
                    await asyncio.sleep(30)
                    continue
                r.raise_for_status()
                bot_h.ok()
                for u in r.json().get("result") or []:
                    if int(u.get("update_id", 0)) < self.offset:
                        continue
                    self.offset = int(u["update_id"]) + 1
                    await self.cfg.kv_set("tg:offset", self.offset)
                    await self.handle(u, v)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                bot_h.fail(f"{type(e).__name__}: {e}"[:200])
                await asyncio.sleep(5)
            await asyncio.sleep(max(0.0, 1.5 - (time.time() - t0)))

    async def handle(self, u: dict[str, Any], v: dict[str, str]) -> None:
        msg = u.get("message") or {}
        chat = str((msg.get("chat") or {}).get("id") or "")
        text = (msg.get("text") or "").strip()
        if not chat or not text:
            return
        if not v.get("chat_id"):
            await self.connectors.save("telegram_bot", {"chat_id": chat})
            await self.alerts.tg_send("✅ <b>Radar connected.</b> Alerts and pushes will arrive here.\n\n" + HELP, chat_id=chat)
            return
        if chat != str(v["chat_id"]):
            return                                   # private bot: only your chat gets answers
        self.last_cmd = {"ts": time.time(), "text": text[:60]}
        cmd, _, arg = text.partition(" ")
        cmd = cmd.split("@")[0].lower()
        try:
            await self.command(cmd, arg.strip())
        except Exception as e:  # noqa: BLE001
            await self.alerts.tg_send(f"⚠️ {esc(e)}")

    # ---------------- commands ----------------
    async def command(self, cmd: str, arg: str) -> None:
        send = self.alerts.tg_send
        if cmd in ("/start", "/help"):
            await send(HELP)
        elif cmd == "/top":
            ap = arg.lower() if arg.lower() in PUSH_BAR else (self.push_mode if self.push_mode in PUSH_BAR else "degen")
            rows = self.sniper.board(appetite=ap, limit=5)["rows"]
            if not rows:
                await send("No live launches scored yet — give it a minute.")
                return
            await send(f"🎯 <b>Top launches · {ap}</b>\n\n" + "\n\n".join(coin_line(i + 1, r, ap) for i, r in enumerate(rows)),
                       [[{"text": f"${r.get('symbol') or r['mint'][:5]}", "url": f"https://pump.fun/coin/{r['mint']}"} for r in rows]])
        elif cmd == "/coin":
            r = self.find(arg)
            if not r:
                await send("Not a live launch Radar is scoring. Send a contract address or $TICKER from the last 30 minutes.")
                return
            await send(coin_card(r), coin_buttons(r["mint"]))
        elif cmd == "/calls":
            calls = sorted(self.sniper.calls.values(), key=lambda c: -c["call_ts"])[:10]
            if not calls:
                await send("No snipe calls in the last 24h yet.")
                return
            lines = []
            for c in calls:
                base = c.get("mcap_sol_at_call") or 0
                sym = esc(c.get("symbol") or c["mint"][:6])
                if not base:
                    lines.append(f"<b>${sym}</b>")
                    continue
                peak, cur = (c.get("peak_mcap_sol") or 0) / base, (c.get("last_mcap_sol") or 0) / base
                lines.append(f"<b>${sym}</b> · {age(time.time() - c['call_ts'])} ago · peak {peak:.1f}× · now {cur:.1f}×"
                             + (" · 🎓" if c.get("graduated_at") else ""))
            await send("📈 <b>Snipe calls</b>\n" + "\n".join(lines))
        elif cmd == "/wallets":
            rows = await self.db.all("SELECT wt.wallet, wt.mint, wt.side, wt.sol, wt.ts, w.label, t.symbol FROM wallet_trades wt "
                                     "LEFT JOIN wallets w ON w.address=wt.wallet LEFT JOIN tokens t ON t.address=wt.mint "
                                     "ORDER BY wt.ts DESC LIMIT 10")
            if not rows:
                await send("No top-wallet trades seen yet.")
                return
            await send("🐋 <b>Top-wallet trades</b>\n" + "\n".join(
                f"{'🟢' if r['side'] == 'buy' else '🔴'} {esc(r['label'] or r['wallet'][:4] + '…')} {r['side']}s "
                f"<b>${esc(r['symbol'] or r['mint'][:6])}</b>" + (f" · {r['sol']:.2f} SOL" if r["sol"] else "") +
                f" · {age(time.time() - r['ts'])} ago" for r in rows))
        elif cmd == "/intel":
            ev = feed.recent(10)
            await send("🛰 <b>Engine finds</b>\n" + ("\n".join(f"• {esc(e['title'])}" for e in ev) if ev else "Nothing yet."))
        elif cmd == "/x":
            rows = await self.xradar.board(hours=6, limit=6) if self.xradar else []
            if not rows:
                await send("No tweet narratives yet — connect X on Connectors (it can take a minute to fill).")
                return
            lines = []
            for i, t in enumerate(rows, 1):
                ai = t.get("ai") or {}
                coins = t.get("coins") or []
                lines.append(f"{i}. <b>@{esc(t['handle'])}</b> · {t['score']:.0f} pts · {age(time.time() - t['ts'])} ago\n"
                             f"   “{esc(t['text'][:160])}”"
                             + (f"\n   ✦ {esc(ai.get('narrative'))} · meme {ai.get('meme_potential')}/10" if ai else "")
                             + (f"\n   🏁 {len(coins)} coins: " + ", ".join(f"${esc(c.get('symbol'))}" for c in coins[:5]) if coins else ""))
            await send("🐦 <b>Tweet radar</b>\n\n" + "\n\n".join(lines), [[{"text": f"@{t['handle']}", "url": t["url"]} for t in rows[:3]]])
        elif cmd == "/callers":
            rows = await self.xradar.callers(days=7, min_calls=2) if self.xradar else []
            if not rows:
                await send("Not enough graded calls yet — every $ticker / contract a tracked account tweets is logged and graded.")
                return
            await send("📣 <b>Best X callers (7d)</b>\n" + "\n".join(
                f"{i}. @{esc(r['handle'])} · {r['calls']} calls · {r['hit_2x_pct']}% hit 2× · avg peak {r['avg_peak_x']}×"
                for i, r in enumerate(rows[:10], 1)))
        elif cmd == "/push":
            mode = arg.lower()
            if mode not in (*PUSH_BAR, "off"):
                await send(f"Push mode is <b>{self.push_mode}</b>. Use /push degen, /push balanced, /push safe or /push off.")
                return
            self.push_mode = mode
            await self.cfg.kv_set("tg:push_mode", mode)
            await send(f"✅ Push mode: <b>{mode}</b>" + ("" if mode == "off" else f" (score ≥ {PUSH_BAR[mode]:.0f}, max {self.max_per_hour}/h)"))
        elif cmd == "/mute":
            mins = float(re.sub(r"[^\d.]", "", arg) or 60)
            self.alerts.tg_muted_until = time.time() + mins * 60
            await send(f"🔕 Muted for {mins:.0f} min (rug / flash warnings still come through). /unmute to undo.")
        elif cmd == "/unmute":
            self.alerts.tg_muted_until = 0
            await send("🔔 Unmuted.")
        elif cmd == "/status":
            s = await self.status_fn() if self.status_fn else {}
            h, c, y, xs = s.get("helius") or {}, s.get("claude") or {}, s.get("youtube") or {}, s.get("x") or {}
            await send("⚙️ <b>Engines</b>\n"
                       f"Helius: {h.get('spent', 0):,}/{h.get('daily', 0):,} credits today\n"
                       f"Claude: ${c.get('spent_usd', 0):.3f}/${c.get('budget_usd', 0):.2f} · {c.get('labeled', 0)} coins read\n"
                       f"YouTube: {(y.get('quota') or {}).get('used', 0):,}/{(y.get('quota') or {}).get('cap', 0):,} units\n"
                       f"X: ${xs.get('spent_usd', 0):.2f}/${xs.get('budget_usd', 0):.2f} · {xs.get('accounts', 0)} accounts · {xs.get('posts', 0)} posts read\n"
                       f"Launches tracked: {len(self.sniper.launches)} · push: {self.push_mode}")
        else:
            await send("Unknown command.\n\n" + HELP)

    def find(self, q: str) -> dict[str, Any] | None:
        q = q.strip().lstrip("$")
        if not q:
            return None
        if q in self.sniper.launches:
            return self.sniper.one(q)
        cands = [L for L in self.sniper.launches.values() if (L.symbol or "").upper() == q.upper()]
        if not cands:
            return None
        best = max(cands, key=lambda L: (L.result or {}).get("upside", 0))
        return self.sniper.one(best.mint)

    # ---------------- appetite pushes ----------------
    async def push_loop(self) -> None:
        await asyncio.sleep(30)
        while True:
            await asyncio.sleep(20)
            try:
                await self.push_once()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.debug("tg push: %s", e)

    async def push_once(self) -> int:
        if self.push_mode not in PUSH_BAR or time.time() < self.alerts.tg_muted_until:
            return 0
        v = await self.connectors.values("telegram_bot")
        if not v.get("bot_token") or not v.get("chat_id"):
            return 0
        now = time.time()
        self.push_times = [t for t in self.push_times if t > now - 3600]
        bar = PUSH_BAR[self.push_mode]
        sent = 0
        for r in self.sniper.board(appetite=self.push_mode, limit=10, max_age_min=20)["rows"]:
            if len(self.push_times) >= self.max_per_hour:
                break
            sc = (r.get("scores") or {}).get(self.push_mode, 0)
            if sc < bar or r["mint"] in self.pushed or r.get("tier") == "TRAP" or len(r.get("why_up") or []) < 2:
                continue
            self.pushed[r["mint"]] = now
            self.push_times.append(now)
            await self.alerts.tg_send(f"🎯 <b>{self.push_mode.upper()} pick</b>\n" + coin_card(r), coin_buttons(r["mint"]))
            await feed.push("telegram", "push", f"📲 pushed ${r.get('symbol') or r['mint'][:6]} ({self.push_mode} {sc:.0f})", "", r["mint"])
            sent += 1
        if len(self.pushed) > 5000:
            self.pushed = {k: t for k, t in self.pushed.items() if t > now - 86400}
        return sent

    def snapshot(self) -> dict[str, Any]:
        return {"push_mode": self.push_mode, "pushed_last_hour": len([t for t in self.push_times if t > time.time() - 3600]),
                "max_per_hour": self.max_per_hour, "muted_until": self.alerts.tg_muted_until or None, "last_command": self.last_cmd,
                "messages_sent": self.alerts.tg_sent}
