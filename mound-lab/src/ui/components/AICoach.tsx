// Optional AI coach: sends the numbers, findings, notes and annotated key-frame stills to Claude
// using a key the user supplies (stored only in this browser). Nothing is sent until the user clicks.

import { useRef, useState } from 'react';
import Anthropic from '@anthropic-ai/sdk';
import { useStore, type RuntimeClip } from '../../state/store';
import type { Comparison } from '../../core/compare';
import { METRIC_BY_KEY } from '../../core/catalog';
import { resolvedEvents, type EventCode } from '../../core/types';
import { fit, drawSkeleton } from '../draw';

const SYSTEM = `You are a pitching coach and sports biomechanist reviewing a comparison of two pitches (A = reference, B = the pitch being checked) measured from single-camera phone video.
Rules:
- Respect 2D limits: each metric comes with a confidence tier and camera view. Do not over-interpret low-confidence or unmeasurable metrics; never invent numbers.
- Separate root causes from downstream symptoms (the data marks which is which, but use judgement).
- Never diagnose injuries or say a mechanic "will cause injury". You may say a pattern is "associated with higher elbow/shoulder stress in research". Pain means stop and see a qualified professional. Mention that workload (pitch counts, rest, fatigue) matters more than mechanics for arm health when relevant.
- Plain sentences a 14-year-old understands. Define jargon briefly.
Format your answer in Markdown with exactly these sections:
## Bottom line
## What changed
## Fix plan (2–3 cues and drills with sets and reps)
## What still looks good
## How sure this is + what to film next`;

function stillsFor(clip: RuntimeClip, events: EventCode[]): Promise<{ ev: EventCode; data: string }[]> {
  return Promise.all(events.map(async (ev) => {
    const c = document.createElement('canvas');
    c.width = 480; c.height = 270;
    const ctx = c.getContext('2d')!;
    const tr = clip.full!.cleaned;
    const f = fit(tr.width, tr.height, c.width, c.height);
    const i = resolvedEvents(clip.analysis!)[ev];
    clip.source?.prefetch(i);
    await new Promise((r) => setTimeout(r, 120));
    clip.source?.draw(ctx, i, f.tx, f.ty, f.w, f.h);
    drawSkeleton(ctx, tr, i, f, { color: '#ffd166', width: 2 });
    return { ev, data: c.toDataURL('image/jpeg', 0.7).split(',')[1] };
  }));
}

export function AICoach({ A, B, cmp }: { A: RuntimeClip; B: RuntimeClip; cmp: Comparison }) {
  const { settings, setSettings } = useStore();
  const [notes, setNotes] = useState('');
  const [sendStills, setSendStills] = useState(true);
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<Anthropic.Beta.BetaMessageParam[]>([]);
  const [followUp, setFollowUp] = useState('');
  const abort = useRef<AbortController | null>(null);

  const run = async (messages: Anthropic.Beta.BetaMessageParam[]) => {
    if (!settings.apiKey) { setErr('Add your Anthropic API key in Settings first.'); return; }
    setBusy(true); setErr(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    let text = '';
    try {
      const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
      const stream = client.beta.messages.stream({
        model: settings.aiModel,
        max_tokens: 16000,
        system: SYSTEM + (settings.youth ? '\nThis is a youth athlete: use external cues ("throw through the target"), very few numbers, and put workload reminders up front.' : ''),
        output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages,
      }, { signal: ctrl.signal });
      stream.on('text', (d) => { text += d; setOut((o) => o + d); });
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') setErr('The model declined this request.');
      setHistory([...messages, { role: 'assistant', content: final.content.filter((b) => b.type === 'text') }]);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || ctrl.signal.aborted) setErr('Stopped.');
      else if (e instanceof Anthropic.AuthenticationError) setErr('That API key was rejected.');
      else if (e instanceof Anthropic.RateLimitError) setErr('Rate limited — try again in a moment.');
      else if (e instanceof Anthropic.APIError) setErr(`API error ${e.status}: ${e.message}`);
      else setErr((e as Error).message);
      if (text) setHistory([...messages, { role: 'assistant', content: text }]);
    } finally { setBusy(false); abort.current = null; }
  };

  const start = async () => {
    setOut('');
    const table = cmp.diffs.filter((d) => d.status !== 'na').map((d) => {
      const m = METRIC_BY_KEY[d.key];
      return `- ${m.label} (${m.unit}, confidence ${d.tier}${m.chain ? `, chain ${m.chain}` : ''}): A ${d.a?.toFixed(m.digits)} → B ${d.b?.toFixed(m.digits)}; ${d.status}${d.status !== 'steady' ? ` (${d.ratio.toFixed(1)}× normal variation)` : ''}`;
    }).join('\n');
    const findings = cmp.findings.map((f, i) => `${i + 1}. ${f.def.label} — ${f.isRoot ? 'likely root cause' : `likely symptom of ${f.causedBy.join(', ')}`}: ${f.what}`).join('\n');
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (sendStills) {
      const evs: EventCode[] = ['FS', 'MER', 'BR'];
      const [sa, sb] = await Promise.all([stillsFor(A, evs), stillsFor(B, evs)]);
      evs.forEach((ev, k) => {
        content.push({ type: 'text', text: `Key frame ${ev} — A then B:` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sa[k].data } });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sb[k].data } });
      });
    }
    content.push({ type: 'text', text: `Camera views: A ${A.analysis!.view} @ ${Math.round(A.analysis!.fps)} fps, B ${B.analysis!.view} @ ${Math.round(B.analysis!.fps)} fps.
Setup warnings: ${cmp.setup.warnings.join(' ') || 'none'}
Flags on B: ${cmp.flags.filter((f) => f.clip === 'B').map((f) => f.text).join(' ') || 'none'}
Pitch types: A ${A.record.pitchType ?? 'unknown'}, B ${B.record.pitchType ?? 'unknown'}. Ball data: A ${JSON.stringify(A.record.ballData ?? {})}, B ${JSON.stringify(B.record.ballData ?? {})}.
Athlete notes: ${notes || '(none)'}

Metrics:
${table}

Ranked findings from the rule engine:
${findings || '(none)'}`});
    await run([{ role: 'user', content }]);
  };

  const ask = async () => {
    if (!followUp.trim()) return;
    setOut((o) => `${o}\n\n---\n**You:** ${followUp}\n\n`);
    const q = followUp;
    setFollowUp('');
    await run([...history, { role: 'user', content: q }]);
  };

  return (
    <section className="card stack" aria-label="AI coach">
      <div className="card-title"><h3>AI coach <span className="small muted">(optional)</span></h3></div>
      <p className="small muted">Sends the numbers above, your notes{sendStills ? ', and 6 small annotated stills (no video)' : ''} to Claude using your own API key. Nothing is sent until you press the button.</p>
      {!settings.apiKey && (
        <label className="field">Anthropic API key (kept only in this browser)
          <input type="password" placeholder="sk-ant-…" onChange={(e) => setSettings({ apiKey: e.target.value.trim() || undefined })} />
        </label>
      )}
      <label className="field">Notes for the coach
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. lost 3 mph, missing arm-side, felt rushed" />
      </label>
      <div className="row">
        <label className="small row tight"><input type="checkbox" checked={sendStills} onChange={(e) => setSendStills(e.target.checked)} /> include key-frame stills</label>
        {!busy ? <button className="primary" onClick={start} disabled={!settings.apiKey}>Get coaching report</button> : <button onClick={() => abort.current?.abort()}>Stop</button>}
      </div>
      {err && <div className="notice warn small">{err}</div>}
      {out && <div className="card flat" style={{ whiteSpace: 'pre-wrap' }} aria-live="polite">{out}</div>}
      {history.length > 0 && !busy && (
        <div className="row">
          <input style={{ flex: 1 }} value={followUp} onChange={(e) => setFollowUp(e.target.value)} placeholder="Ask a follow-up, e.g. is my arm late because of my leg lift?" onKeyDown={(e) => e.key === 'Enter' && ask()} />
          <button onClick={ask}>Ask</button>
        </div>
      )}
    </section>
  );
}
