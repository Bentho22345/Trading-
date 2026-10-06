import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';

export interface OutboundMessage {
  kind: 'brief' | 'alert' | 'handoff' | 'test' | 'journal' | 'digest' | 'playbook';
  title: string;
  /** plain text */
  text: string;
  markdown?: string;
  html?: string;
  slack?: string;
  telegram?: string;
  url?: string;
  severity?: string;
}

export interface Field { key: string; label: string; secret?: boolean; placeholder?: string; optional?: boolean }

export interface Destination {
  type: string;
  label: string;
  direction: 'out' | 'in' | 'both';
  powers: string;
  fields: Field[];
  docs: string;
  send?: (m: OutboundMessage, cfg: Record<string, string>) => Promise<void>;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return res;
}

const DISCLAIMER = '\n\n— PULSE · informational only, not investment advice';

/** Every optional connector behind one interface. Add a new one by appending to this list. */
export const DESTINATIONS: Destination[] = [
  {
    type: 'email', label: 'Email (SMTP: Gmail, Outlook, any provider)', direction: 'out', powers: 'Morning Brief, EOD wrap and weekly review as HTML email; alert escalation',
    docs: 'Gmail: create an App Password (Google Account → Security → App passwords) and use smtp.gmail.com:465. Outlook/Microsoft 365: smtp.office365.com:587 with an app password.',
    fields: [{ key: 'host', label: 'SMTP host', placeholder: 'smtp.gmail.com' }, { key: 'port', label: 'Port', placeholder: '465' }, { key: 'user', label: 'Username', placeholder: 'you@gmail.com' }, { key: 'pass', label: 'Password / app password', secret: true }, { key: 'from', label: 'From', placeholder: 'PULSE <you@gmail.com>', optional: true }, { key: 'to', label: 'Send to', placeholder: 'you@example.com' }],
    async send(m, c) {
      const port = Number(c.port || 465);
      const t = nodemailer.createTransport({ host: c.host, port, secure: port === 465, auth: { user: c.user, pass: c.pass } });
      await t.sendMail({ from: c.from || c.user, to: c.to, subject: m.title, text: m.text + DISCLAIMER, html: m.html });
    },
  },
  {
    type: 'slack', label: 'Slack', direction: 'out', powers: 'Briefs, alerts and handoff cards to a channel or DM',
    docs: 'Create an Incoming Webhook (api.slack.com/apps → your app → Incoming Webhooks) and paste its URL.',
    fields: [{ key: 'webhookUrl', label: 'Incoming webhook URL', secret: true, placeholder: 'https://hooks.slack.com/services/…' }],
    async send(m, c) {
      await post(c.webhookUrl, { text: `*${m.title}*\n${(m.slack ?? m.text).slice(0, 38_000)}${DISCLAIMER}`, unfurl_links: false });
    },
  },
  {
    type: 'telegram', label: 'Telegram', direction: 'out', powers: 'Alerts and briefs via your bot',
    docs: 'Message @BotFather → /newbot for a token; send your bot a message, then read your chat id from https://api.telegram.org/bot<TOKEN>/getUpdates.',
    fields: [{ key: 'botToken', label: 'Bot token', secret: true }, { key: 'chatId', label: 'Chat id' }],
    async send(m, c) {
      await post(`https://api.telegram.org/bot${c.botToken}/sendMessage`, { chat_id: c.chatId, text: (m.telegram ?? `<b>${m.title}</b>\n${m.text}`).slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true });
    },
  },
  {
    type: 'discord', label: 'Discord', direction: 'out', powers: 'Alerts and briefs via a channel webhook',
    docs: 'Channel settings → Integrations → Webhooks → New webhook → copy URL.',
    fields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true }],
    async send(m, c) {
      await post(c.webhookUrl, { content: `**${m.title}**\n${(m.markdown ?? m.text).slice(0, 1800)}${DISCLAIMER}`.slice(0, 2000), allowed_mentions: { parse: [] } });
    },
  },
  {
    type: 'sms', label: 'Twilio SMS', direction: 'out', powers: 'Escalation for critical alerts only',
    docs: 'Twilio console → Account SID and Auth token; a Twilio phone number to send from.',
    fields: [{ key: 'accountSid', label: 'Account SID' }, { key: 'authToken', label: 'Auth token', secret: true }, { key: 'from', label: 'From number', placeholder: '+15551234567' }, { key: 'to', label: 'To number', placeholder: '+15557654321' }],
    async send(m, c) {
      const body = new URLSearchParams({ From: c.from, To: c.to, Body: `PULSE: ${m.title}`.slice(0, 300) });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`, { method: 'POST', body, headers: { Authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Twilio HTTP ${res.status}`);
    },
  },
  {
    type: 'notion', label: 'Notion', direction: 'out', powers: 'Journal entries, brief archive and playbooks as pages',
    docs: 'notion.so/my-integrations → New integration → copy the secret; share a database with it and paste the database id (from its URL).',
    fields: [{ key: 'token', label: 'Integration secret', secret: true }, { key: 'databaseId', label: 'Database id' }, { key: 'titleProp', label: 'Title property name', placeholder: 'Name', optional: true }],
    async send(m, c) {
      const paras = (m.markdown ?? m.text).split(/\n+/).filter(Boolean).slice(0, 90).map((t) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: t.slice(0, 1900) } }] } }));
      await post('https://api.notion.com/v1/pages', { parent: { database_id: c.databaseId }, properties: { [c.titleProp || 'Name']: { title: [{ text: { content: m.title.slice(0, 200) } }] } }, children: paras }, { Authorization: `Bearer ${c.token}`, 'Notion-Version': '2022-06-28' });
    },
  },
  {
    type: 'webhook', label: 'Generic webhook', direction: 'out', powers: 'Any message as signed JSON (Zapier, n8n, your own service)',
    docs: 'PULSE POSTs JSON with an X-Pulse-Signature header (HMAC-SHA256 of the body with your secret).',
    fields: [{ key: 'url', label: 'URL' }, { key: 'secret', label: 'Signing secret', secret: true, optional: true }],
    async send(m, c) {
      const body = JSON.stringify({ ...m, sentAt: new Date().toISOString() });
      const sig = c.secret ? createHmac('sha256', c.secret).update(body).digest('hex') : '';
      const res = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Pulse-Signature': sig } : {}) }, body, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
  },
  {
    type: 'calendar-out', label: 'Google / Outlook Calendar (subscribe)', direction: 'out', powers: 'High-importance releases, central-bank meetings and playbook events in your calendar',
    docs: 'Copy the private ICS link shown after saving and add it in Google Calendar (Other calendars → From URL) or Outlook (Add calendar → Subscribe from web).',
    fields: [{ key: 'minImportance', label: 'Minimum importance (1–3)', placeholder: '3', optional: true }],
  },
  {
    type: 'calendar-in', label: 'Your calendar (read meetings)', direction: 'in', powers: 'The brief warns when you are in a meeting during a key release',
    docs: 'Google Calendar → Settings → your calendar → "Secret address in iCal format". Outlook → Settings → Shared calendars → Publish → ICS link.',
    fields: [{ key: 'icsUrl', label: 'Secret iCal (ICS) URL', secret: true }],
  },
  {
    type: 'sheets', label: 'Google Sheets (positions / watchlist import)', direction: 'in', powers: 'Import positions or a watchlist from a sheet',
    docs: 'File → Share → Publish to web → choose the sheet → CSV, and paste the link. Columns: symbol, qty, avg_price.',
    fields: [{ key: 'csvUrl', label: 'Published CSV URL', secret: true }],
  },
];

export const destination = (type: string) => DESTINATIONS.find((d) => d.type === type);
