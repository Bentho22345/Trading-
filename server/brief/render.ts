import type { EconEvent } from '../../shared/types';
import type { Brief, BriefSection, BriefStory, LevelHit, RatePath, ScoreRow } from '../../shared/v2';

const DISCLAIMER = 'Informational only — not investment advice. Data may be delayed; every item shows its source.';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmtP = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmtMove = (r: Pick<ScoreRow, 'bp' | 'change' | 'changePct'>) => (r.bp ? `${r.change >= 0 ? '+' : '−'}${Math.abs(r.change * 100).toFixed(1)}bp` : `${r.changePct >= 0 ? '+' : '−'}${Math.abs(r.changePct).toFixed(2)}%`);
const time = (ts: number, tz: string) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz, hour12: false });

/** Plain lines per section, shared by Markdown, text, Slack and Telegram renderers. */
function sectionLines(s: BriefSection, b: Brief, md: boolean): string[] {
  const bold = (t: string) => (md ? `**${t}**` : t);
  const link = (t: string, u: string) => (md ? `[${t}](${u})` : `${t} <${u}>`);
  if (s.empty) return [`_${s.empty}_`];
  const d = s.data as Record<string, unknown>;
  switch (s.type) {
    case 'scoreboard': return ((d.rows as ScoreRow[]) ?? []).map((r) => `${bold(r.symbol)} ${fmtP(r.last, r.decimals)} ${fmtMove(r)}${r.delayedMin ? ` (${r.delayedMin}m delayed)` : ''}`);
    case 'stories': return ((d.stories as BriefStory[]) ?? []).map((st, i) => `${i + 1}. ${bold(st.headline)}${st.inBook ? ' 📌' : ''} — ${st.tldr} ${st.why} ${st.sources.slice(0, 2).map((x) => link(x.source, x.url)).join(' · ')}`);
    case 'calendar': {
      const ev = (d.events as (EconEvent & { avgSurprise?: { avg: number } | null; meeting?: string | null })[]) ?? [];
      const lines = ev.map((e) => `${time(e.time, b.tz)} ${e.currency} ${e.title}${e.consensus !== null ? ` · cons ${e.consensus}${e.unit}` : ''}${e.previous !== null ? ` · prev ${e.previous}${e.unit}` : ''}${e.actual !== null ? ` · ${bold(`actual ${e.actual}${e.unit}`)}` : ''}${e.avgSurprise ? ` · avg surprise ${e.avgSurprise.avg > 0 ? '+' : ''}${e.avgSurprise.avg}` : ''}${e.meeting ? ` · ⚠ you're in “${e.meeting}”` : ''}`);
      const bmo = (d.bmo as { symbol: string; impliedMovePct: number | null }[]) ?? [], amc = (d.amc as typeof bmo) ?? [];
      if (bmo.length) lines.push(`Before the open: ${bmo.map((e) => `${e.symbol}${e.impliedMovePct ? ` (±${e.impliedMovePct}%)` : ''}`).join(', ')}`);
      if (amc.length) lines.push(`After the close: ${amc.map((e) => `${e.symbol}${e.impliedMovePct ? ` (±${e.impliedMovePct}%)` : ''}`).join(', ')}`);
      return lines;
    }
    case 'book': {
      const rows = (d.rows as { symbol: string; pnl: number | null; pct: number | null }[]) ?? [];
      return [`Overnight P&L: ${bold(`${(d.total as number) >= 0 ? '+' : '−'}$${fmtP(Math.abs(d.total as number), 0)}`)}`, ...rows.map((r) => `${r.symbol}: ${r.pnl === null ? 'no price' : `${r.pnl >= 0 ? '+' : '−'}$${fmtP(Math.abs(r.pnl), 0)} (${fmtP(r.pct, 2)}%)`}`)];
    }
    case 'levels': return ((d.levels as LevelHit[]) ?? []).slice(0, 12).map((l) => `${l.symbol} ${l.label} ${fmtP(l.level, l.decimals)}${l.status !== 'watch' ? ` — ${bold(l.status)}` : ''}${l.distancePct !== null ? ` (${l.distancePct > 0 ? '+' : ''}${l.distancePct}%)` : ''}`);
    case 'ratePath': return ((d.paths as RatePath[]) ?? []).map((p) => `${p.bank}: ${p.meetings.map((m) => `${m.date} hold ${Math.round(m.hold)}% / cut ${Math.round(m.cut)}% / hike ${Math.round(m.hike)}%`).join('; ')}`);
    case 'sentiment': {
      const out: string[] = [];
      const fg = d.fearGreed as { value: number; label: string } | null;
      if (fg) out.push(`Crypto fear & greed: ${fg.value} (${fg.label})`);
      if (d.structure) out.push(`VIX term structure: ${d.structure}`);
      const pc = d.putCall as { total: number } | null;
      if (pc) out.push(`Put/call: ${pc.total}`);
      if (typeof d.funding === 'number') out.push(`Avg perp funding: ${((d.funding as number) * 100).toFixed(4)}%`);
      return out;
    }
    case 'weekAhead': return ((d.days as { date: string; events: EconEvent[]; earnings: string[] }[]) ?? []).map((x) => `${x.date}: ${[...x.events.map((e) => `${e.currency} ${e.title}`), ...x.earnings].join(', ') || '—'}`);
    case 'scorecard': return ((d.calls as { text: string; outcome: string; movePct: number | null }[]) ?? []).map((c) => `${c.outcome === 'hit' ? '✓' : c.outcome === 'miss' ? '✗' : '·'} ${c.text}${c.movePct !== null ? ` (${c.movePct > 0 ? '+' : ''}${c.movePct}%)` : ''}`);
    case 'movers': return [...((d.gainers as ScoreRow[]) ?? []).map((r) => `▲ ${r.symbol} ${fmtMove(r)}`), ...((d.losers as ScoreRow[]) ?? []).map((r) => `▼ ${r.symbol} ${fmtMove(r)}`)];
    case 'nextUp': return ((d.events as EconEvent[]) ?? []).map((e) => `${time(e.time, b.tz)} ${e.currency} ${e.title}`);
    case 'risks': return ((d.risks as string[]) ?? []).map((r) => `• ${r}`);
    case 'themes': return ((d.themes as { label: string; volume: number }[]) ?? []).map((t) => `• ${t.label} (${t.volume} stories)`);
    case 'journal': return [String(d.prompt ?? '')];
    case 'structure': return ((d.items as { date: string; label: string }[]) ?? []).map((x) => `${x.date}: ${x.label}`);
    case 'smartFeed': return ((d.stories as { headline: string; url: string; source: string }[]) ?? []).map((x) => `• ${link(x.headline, x.url)} (${x.source})`);
    default: return [];
  }
}

export function toMarkdown(b: Brief): string {
  const out = [`# ${b.headline}`, `_${b.profileName} · ${b.date} · generated ${new Date(b.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC_`, '', b.take.text, ''];
  for (const s of b.sections) {
    if (s.type === 'take') continue;
    out.push(`## ${s.title}`, ...sectionLines(s, b, true), '');
  }
  out.push('---', `_${DISCLAIMER}_`);
  return out.join('\n');
}

export function toText(b: Brief): string {
  return toMarkdown(b).replace(/\*\*/g, '').replace(/^#+ /gm, '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 <$2>').replace(/^_|_$/gm, '');
}

/** Slack mrkdwn (single asterisks, <url|text> links). */
export function toSlack(b: Brief): string {
  return toMarkdown(b).replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#+ (.+)$/gm, '*$1*').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>').slice(0, 39_000);
}

/** Telegram HTML parse mode. */
export function toTelegram(b: Brief): string {
  const md = toMarkdown(b);
  return esc(md).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^# (.+)$/gm, '<b>$1</b>').replace(/^## (.+)$/gm, '\n<b>$1</b>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>').replace(/^_(.+)_$/gm, '<i>$1</i>').slice(0, 4000);
}

/** Self-contained HTML email (inline styles, table layout, works in Gmail/Outlook). */
export function toHtmlEmail(b: Brief, appUrl?: string): string {
  const sec = (s: BriefSection) => {
    const lines = sectionLines(s, b, true).map((l) => esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#5b5bf0">$1</a>').replace(/^_(.+)_$/, '<i style="color:#8a8aa0">$1</i>'));
    return `<tr><td style="padding:18px 0 4px;font:600 11px/1.4 -apple-system,Segoe UI,Arial;letter-spacing:.12em;text-transform:uppercase;color:#6b6b86">${esc(s.title)}</td></tr>
<tr><td style="font:14px/1.55 -apple-system,Segoe UI,Arial;color:#15151f">${lines.map((l) => `<div style="padding:2px 0">${l}</div>`).join('')}</td></tr>`;
  };
  return `<!doctype html><html><body style="margin:0;background:#f4f4f8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f8"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border-radius:14px;padding:28px">
<tr><td style="font:700 11px/1 -apple-system,Arial;letter-spacing:.3em;color:#5b5bf0">PULSE · ${esc(b.profileName.toUpperCase())}</td></tr>
<tr><td style="padding:10px 0 4px;font:600 28px/1.2 Georgia,'Times New Roman',serif;color:#15151f">${esc(b.headline)}</td></tr>
<tr><td style="font:12px/1.4 -apple-system,Arial;color:#8a8aa0">${esc(b.date)}${b.take.ai ? ' · AI narrative' : ''}</td></tr>
<tr><td style="padding:16px 0 4px;font:17px/1.6 Georgia,'Times New Roman',serif;color:#15151f">${esc(b.take.text)}</td></tr>
${b.sections.filter((s) => s.type !== 'take').map(sec).join('\n')}
${appUrl ? `<tr><td style="padding:22px 0 0"><a href="${esc(appUrl)}" style="display:inline-block;background:#5b5bf0;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font:600 13px -apple-system,Arial">Open in PULSE</a></td></tr>` : ''}
<tr><td style="padding:22px 0 0;font:11px/1.5 -apple-system,Arial;color:#8a8aa0;border-top:1px solid #eee">${esc(DISCLAIMER)}</td></tr>
</table></td></tr></table></body></html>`;
}

export { DISCLAIMER };
