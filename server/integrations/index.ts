import { randomBytes, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import type { Brief, BriefProfile, Position } from '../../shared/v2';
import { sqlite } from '../db/client';
import { docs } from '../docs';
import { kvGet, kvSet } from '../kv';
import type { Hub } from '../hub';
import { scheduler } from '../scheduler';
import { bad, notFound, Raw, type Router } from '../router';
import type { V2Feature } from '../v2';
import { toHtmlEmail, toMarkdown, toSlack, toTelegram, toText } from '../brief/render';
import { parseCsv } from '../portfolio';
import { assertPublicUrl } from '../tuning';
import { decrypt, encrypt } from './crypto';
import { DESTINATIONS, destination, type OutboundMessage } from './destinations';

interface Integration { id: string; type: string; label: string; enabled: boolean; config: Record<string, string>; secret?: string; createdAt: number; lastTest?: { ok: boolean; at: number; error?: string } }

const disabled = new Set((process.env.PULSE_INTEGRATIONS_DISABLED ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const MAX_ATTEMPTS = 6;

export function listIntegrations(): Integration[] {
  return docs.list<Integration>('integrations');
}

function creds(i: Integration): Record<string, string> {
  return { ...i.config, ...(decrypt<Record<string, string>>(i.secret) ?? {}) };
}

/** Queue a message for an integration (retries with exponential backoff; dead-letters after 6 tries). */
export function enqueue(integrationId: string, m: OutboundMessage) {
  sqlite.prepare('INSERT INTO outbox (id, dest, payload, attempts, next_at, status, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)').run(randomUUID(), integrationId, JSON.stringify(m), Date.now(), 'pending', Date.now());
}

/** Send to every enabled integration of a destination type (e.g. 'slack'). Returns how many were queued. */
export function enqueueType(type: string, m: OutboundMessage): number {
  if (disabled.has(type)) return 0;
  const list = listIntegrations().filter((i) => i.type === type && i.enabled);
  for (const i of list) enqueue(i.id, m);
  return list.length;
}

async function drain() {
  const due = sqlite.prepare("SELECT * FROM outbox WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 20").all(Date.now()) as { id: string; dest: string; payload: string; attempts: number }[];
  for (const job of due) {
    const integ = docs.get<Integration>('integrations', job.dest);
    const d = integ ? destination(integ.type) : null;
    if (!integ || !d?.send || !integ.enabled || disabled.has(integ.type)) {
      sqlite.prepare("UPDATE outbox SET status = 'dead', last_error = ? WHERE id = ?").run(integ ? 'integration disabled' : 'integration removed', job.id);
      continue;
    }
    try {
      await d.send(JSON.parse(job.payload) as OutboundMessage, creds(integ));
      sqlite.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?").run(Date.now(), job.id);
    } catch (e) {
      const attempts = job.attempts + 1;
      const err = (e as Error).message.replace(/(token|key|secret|password)=[^&\s]+/gi, '$1=***').slice(0, 300);
      if (attempts >= MAX_ATTEMPTS) sqlite.prepare("UPDATE outbox SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?").run(attempts, err, job.id);
      else sqlite.prepare('UPDATE outbox SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?').run(attempts, Date.now() + Math.min(3600_000, 30_000 * 2 ** attempts), err, job.id);
    }
  }
}

// ------------------------------------------------------------------ web push (VAPID keys generated once)
function vapid() {
  let k = kvGet<{ publicKey: string; privateKey: string } | null>('vapid', null);
  if (!k) {
    k = webpush.generateVAPIDKeys();
    kvSet('vapid', k);
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:pulse@localhost', k.publicKey, k.privateKey);
  return k;
}

export async function sendPush(payload: { title: string; body: string; url?: string; tag?: string }) {
  vapid();
  const subs = sqlite.prepare('SELECT endpoint, data FROM push_subs').all() as { endpoint: string; data: string }[];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(JSON.parse(s.data), JSON.stringify(payload), { TTL: 3600 });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) sqlite.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(s.endpoint);
    }
  }));
  return subs.length;
}

// ------------------------------------------------------------------ ICS
const icsEsc = (s: string) => s.replace(/[\\,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
const icsTime = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function buildIcs(hub: Hub, minImportance: number): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PULSE//Markets calendar//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:PULSE — market events', 'X-PUBLISHED-TTL:PT1H'];
  const add = (uid: string, start: number, mins: number, summary: string, desc: string) => lines.push('BEGIN:VEVENT', `UID:${uid}@pulse`, `DTSTAMP:${icsTime(Date.now())}`, `DTSTART:${icsTime(start)}`, `DTEND:${icsTime(start + mins * 60_000)}`, `SUMMARY:${icsEsc(summary)}`, `DESCRIPTION:${icsEsc(desc)}`, 'END:VEVENT');
  for (const e of hub.calendar.filter((x) => x.importance >= minImportance)) add(e.id, e.time, 15, `${e.currency} ${e.title}`, `Consensus ${e.consensus ?? '—'}${e.unit} · previous ${e.previous ?? '—'}${e.unit} · ${e.source}`);
  for (const b of hub.banks) if (b.nextMeeting) add(`cb-${b.id}-${b.nextMeeting}`, b.nextMeeting, 60, `${b.short} policy decision`, `${b.name} · current ${b.rateLabel}`);
  const pb = docs.list<{ id: string; name: string; eventMatch: string; enabled: boolean }>('playbooks').filter((p) => p.enabled);
  for (const e of hub.calendar) for (const p of pb) if (p.eventMatch && p.eventMatch.toLowerCase().split(/\s+/).every((w) => e.title.toLowerCase().includes(w))) add(`pb-${p.id}-${e.id}`, e.time - 10 * 60_000, 10, `Playbook: ${p.name}`, `Prepare for ${e.currency} ${e.title}`);
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/** Minimal VEVENT parser for the user's own calendar (DTSTART/DTEND/SUMMARY; UTC or floating). */
export function parseIcs(text: string): { title: string; start: number; end: number }[] {
  const out: { title: string; start: number; end: number }[] = [];
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const get = (k: string) => new RegExp(`^${k}[^:\\n]*:(.*)$`, 'm').exec(block)?.[1]?.trim();
    const parse = (v?: string) => {
      if (!v) return NaN;
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
      if (!m) return NaN;
      const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
      return m[7] ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) : new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
    };
    const start = parse(get('DTSTART')), end = parse(get('DTEND'));
    if (Number.isFinite(start)) out.push({ title: (get('SUMMARY') ?? 'Busy').slice(0, 80), start, end: Number.isFinite(end) ? end : start + 3600_000 });
  }
  return out.filter((e) => e.end > Date.now() - 86400_000 && e.start < Date.now() + 14 * 86400_000);
}

export function integrationsFeature(hub: Hub): V2Feature & { deliverBrief: (b: Brief, p: BriefProfile) => void; meetings: () => { title: string; start: number; end: number }[] } {
  let meetings: { title: string; start: number; end: number }[] = kvGet('calendar.meetings', []);
  const icsToken = () => {
    let t = kvGet<string>('ics.token', '');
    if (!t) { t = randomBytes(18).toString('base64url'); kvSet('ics.token', t); }
    return t;
  };
  const refreshMeetings = async () => {
    const i = listIntegrations().find((x) => x.type === 'calendar-in' && x.enabled);
    if (!i) return;
    const url = creds(i).icsUrl;
    if (!url) return;
    await assertPublicUrl(url.replace(/^webcal:/, 'https:'));
    const res = await fetch(url.replace(/^webcal:/, 'https:'), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`calendar HTTP ${res.status}`);
    meetings = parseIcs(await res.text());
    kvSet('calendar.meetings', meetings);
  };
  const briefMessage = (b: Brief): OutboundMessage => ({ kind: 'brief', title: `${b.profileName}: ${b.headline}`, text: toText(b), markdown: toMarkdown(b), html: toHtmlEmail(b, process.env.PUBLIC_URL), slack: toSlack(b), telegram: toTelegram(b), url: process.env.PUBLIC_URL });

  const view = (i: Integration) => {
    const d = destination(i.type);
    const sec = decrypt<Record<string, string>>(i.secret) ?? {};
    return { id: i.id, type: i.type, label: i.label, enabled: i.enabled && !disabled.has(i.type), config: i.config, secretsSet: Object.keys(sec).filter((k) => sec[k]), connected: !!d, lastTest: i.lastTest, canSend: !!d?.send, ...(i.type === 'calendar-out' ? { icsUrl: `${process.env.PUBLIC_URL ?? ''}/api/calendar.ics?token=${icsToken()}` } : {}) };
  };

  return {
    meetings: () => meetings,
    deliverBrief(b, p) {
      for (const id of p.destinations) {
        const i = docs.get<Integration>('integrations', id);
        if (i?.enabled) enqueue(id, briefMessage(b));
      }
      if (p.destinations.includes('push')) void sendPush({ title: b.profileName, body: b.headline, url: '/m' });
    },
    start() {
      vapid();
      scheduler.every('outbox', 'Outbound integrations queue', 10_000, drain);
      scheduler.every('calendar-in', 'Read your calendar (ICS)', 30 * 60_000, refreshMeetings, { immediate: true });
    },
    routes(r: Router) {
      r.get('/api/integrations/types', () => DESTINATIONS.map(({ send: _s, ...d }) => ({ ...d, disabled: disabled.has(d.type) })));
      r.get('/api/integrations', () => listIntegrations().map(view));
      r.put('/api/integrations/:id', async ({ params, body }) => {
        const b = await body<{ type?: string; label?: string; enabled?: boolean; config?: Record<string, string>; secrets?: Record<string, string> }>();
        const existing = docs.get<Integration>('integrations', params[0]);
        const type = existing?.type ?? b.type ?? '';
        const d = destination(type);
        if (!d) bad('unknown integration type');
        const config: Record<string, string> = {}, secrets: Record<string, string> = { ...(decrypt<Record<string, string>>(existing?.secret) ?? {}) };
        for (const f of d.fields) {
          if (f.secret) { const v = b.secrets?.[f.key]; if (v) secrets[f.key] = String(v).trim().slice(0, 2000); }
          else config[f.key] = String(b.config?.[f.key] ?? existing?.config[f.key] ?? '').trim().slice(0, 500);
        }
        for (const f of d.fields) if (!f.optional && !(f.secret ? secrets[f.key] : config[f.key])) bad(`${f.label} is required`);
        const doc: Integration = { id: params[0], type, label: String(b.label ?? existing?.label ?? d.label).slice(0, 60), enabled: b.enabled ?? existing?.enabled ?? true, config, secret: encrypt(secrets), createdAt: existing?.createdAt ?? Date.now(), lastTest: existing?.lastTest };
        docs.put('integrations', doc);
        if (type === 'calendar-in') void refreshMeetings().catch(() => {});
        return view(doc);
      });
      r.del('/api/integrations/:id', ({ params }) => {
        docs.remove('integrations', params[0]);
        return { ok: true };
      });
      r.post('/api/integrations/:id/test', async ({ params }) => {
        const i = docs.get<Integration>('integrations', params[0]) ?? notFound('integration not found');
        const d = destination(i.type)!;
        let ok = true, error: string | undefined;
        try {
          if (i.type === 'calendar-in') { await refreshMeetings(); }
          else if (i.type === 'sheets') { const rows = parseCsv(await (await fetch(creds(i).csvUrl, { signal: AbortSignal.timeout(15_000) })).text()); if (!rows.length) throw new Error('no rows with symbol/qty found'); }
          else if (d.send) await d.send({ kind: 'test', title: 'PULSE test message', text: 'If you can read this, the connection works.', html: '<p>If you can read this, the connection works.</p>' }, creds(i));
        } catch (e) {
          ok = false;
          error = (e as Error).message.slice(0, 200);
        }
        docs.put('integrations', { ...i, lastTest: { ok, at: Date.now(), error } });
        return { ok, error, meetings: i.type === 'calendar-in' ? meetings.length : undefined };
      });
      r.post('/api/integrations/:id/import', async ({ params }) => {
        const i = docs.get<Integration>('integrations', params[0]) ?? notFound('integration not found');
        if (i.type !== 'sheets') bad('only Sheets integrations import positions');
        const url = creds(i).csvUrl;
        await assertPublicUrl(url);
        const rows = parseCsv(await (await fetch(url, { signal: AbortSignal.timeout(15_000) })).text());
        for (const p of docs.list<Position>('positions').filter((x) => x.source === 'sheet')) docs.remove('positions', p.id);
        for (const p of rows) docs.put('positions', { ...p, source: 'sheet', id: randomUUID() });
        return { imported: rows.length };
      });
      r.get('/api/calendar.ics', ({ url }) => {
        if (url.searchParams.get('token') !== icsToken()) notFound();
        const i = listIntegrations().find((x) => x.type === 'calendar-out');
        return new Raw(buildIcs(hub, Number(i?.config.minImportance) || 3), 'text/calendar; charset=utf-8');
      });
      r.get('/api/outbox', () => sqlite.prepare('SELECT id, dest, attempts, status, last_error, created_at, sent_at, next_at FROM outbox ORDER BY created_at DESC LIMIT 100').all());
      r.post('/api/outbox/:id/retry', ({ params }) => {
        sqlite.prepare("UPDATE outbox SET status = 'pending', attempts = 0, next_at = ? WHERE id = ?").run(Date.now(), params[0]);
        return { ok: true };
      });
      // optional server TTS (Listen mode / squawk): ElevenLabs when ELEVENLABS_API_KEY is set, otherwise the browser voice is used
      r.get('/api/tts', async ({ url, res }) => {
        const key = process.env.ELEVENLABS_API_KEY?.trim();
        if (!key) { res.writeHead(501, { 'Content-Type': 'application/json' }); res.end('{"error":"no TTS provider"}'); return; }
        const text = (url.searchParams.get('text') ?? '').slice(0, 2500);
        const voice = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
        const up = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, { method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }), signal: AbortSignal.timeout(30_000) });
        if (!up.ok) bad(`TTS provider HTTP ${up.status}`);
        return new Raw(Buffer.from(await up.arrayBuffer()), 'audio/mpeg');
      });
      // web push
      r.get('/api/push/vapid', () => ({ publicKey: vapid().publicKey }));
      r.post('/api/push/subscribe', async ({ body }) => {
        const sub = await body<{ endpoint?: string; keys?: unknown }>();
        if (!sub.endpoint?.startsWith('https://')) bad('invalid subscription');
        sqlite.prepare('INSERT INTO push_subs (endpoint, data, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET data = excluded.data').run(sub.endpoint, JSON.stringify(sub), Date.now());
        return { ok: true };
      });
      r.post('/api/push/unsubscribe', async ({ body }) => {
        const { endpoint } = await body<{ endpoint?: string }>();
        sqlite.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint ?? '');
        return { ok: true };
      });
      r.post('/api/push/test', async () => ({ sent: await sendPush({ title: 'PULSE', body: 'Push notifications are working.', url: '/m' }) }));
    },
  };
}
