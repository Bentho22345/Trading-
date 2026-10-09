'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Chips } from '@/components/motion';
import { DET_ICON, useStrategies } from '@/components/snipe';
import { TokenIcon } from '@/components/ui';
import { CountUp, Reveal, Ring } from '@/components/whoop';
import { api } from '@/lib/api';
import { ago, short, usd } from '@/lib/format';
import { useNow } from '@/lib/live';

const WINDOWS = [{ value: '24', label: '24H' }, { value: '168', label: '7D' }, { value: '720', label: '30D' }];
const x = (v?: number | null) => (v == null ? '—' : `${v >= 10 ? v.toFixed(0) : v.toFixed(2)}×`);
const mins = (s?: number | null) => (s == null ? '—' : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

export default function ProofPage() {
  const [w, setW] = useState('168');
  const [d, setD] = useState<any>(null);
  const now = useNow(5000);
  useEffect(() => { let on = true; const l = () => api(`/api/snipe/proof?hours=${w}`).then((r) => on && setD(r)).catch(() => {}); l(); const t = setInterval(l, 20000); return () => { on = false; clearInterval(t); }; }, [w]);
  const s = d?.stats;
  const { list: strategies } = useStrategies();
  const lift = s?.call_graduation_pct != null && s?.base_graduation_pct ? s.call_graduation_pct / s.base_graduation_pct : null;

  return (
    <div className="pt-4">
      <Reveal className="mb-10 grid items-end gap-8 lg:grid-cols-[1fr_auto]">
        <div>
          <div className="eyebrow mb-3">Proof · every call, every outcome</div>
          <h1 className="display text-[64px] md:text-[112px]">Receipts.</h1>
          <p className="mt-4 max-w-2xl text-[16px] text-white/60">The first time a launch reaches SNIPE, Radar writes down the time, market cap and every detector input. Then it follows the
            coin for 24 hours: the peak, its value 5 minutes, 15 minutes and 1 hour later, whether it graduated, and when it first showed up on public trending lists.
            Winners and losers both stay on the record — compared against every launch Radar saw in the same window.</p>
        </div>
        <Chips id="pw" value={w} onChange={setW} options={WINDOWS} />
      </Reveal>

      <div className="mb-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Calls" big={<CountUp value={s?.calls} className="stat text-[56px]" />} sub={s ? `out of ${s.launches_seen.toLocaleString()} launches seen` : ''} />
        <Stat label="Graduated after call" big={<span className="stat text-[56px] text-up">{s?.call_graduation_pct != null ? `${s.call_graduation_pct}%` : '—'}</span>}
          sub={s?.base_graduation_pct != null ? `vs ${s.base_graduation_pct}% of all launches${lift ? ` · ${lift.toFixed(1)}× the base rate` : ''}` : 'base rate builds as launches are seen'} />
        <Stat label="Called before trending" big={<span className="stat text-[56px] text-accent2">{s?.before_trending_pct != null ? `${s.before_trending_pct}%` : '—'}</span>}
          sub={s?.median_lead_to_trending_min != null ? `median ${s.median_lead_to_trending_min} min ahead of GeckoTerminal / DexScreener` : 'of calls that later trended'} />
        <Stat label="Called at" big={<span className="stat text-[56px]">{mins(s?.median_secs_after_launch)}</span>} sub="median time after launch" />
      </div>

      <div className="mb-12 flex flex-wrap justify-center gap-10">
        <Ring value={s?.hit_2x_pct ?? 0} max={100} size={150} color="var(--color-up)" label="Peaked ≥ 2×"><span className="stat text-[34px]">{s?.hit_2x_pct != null ? `${Math.round(s.hit_2x_pct)}%` : '—'}</span></Ring>
        <Ring value={s?.hit_5x_pct ?? 0} max={100} size={150} color="var(--color-accent2)" label="Peaked ≥ 5×"><span className="stat text-[34px]">{s?.hit_5x_pct != null ? `${Math.round(s.hit_5x_pct)}%` : '—'}</span></Ring>
        <Ring value={s?.hit_10x_pct ?? 0} max={100} size={150} color="var(--color-flash)" label="Peaked ≥ 10×"><span className="stat text-[34px]">{s?.hit_10x_pct != null ? `${Math.round(s.hit_10x_pct)}%` : '—'}</span></Ring>
        <Ring value={s?.up_after_1h_pct ?? 0} max={100} size={150} color="var(--color-warn)" label={`Up 1h later (${s?.settled_1h ?? 0})`}><span className="stat text-[34px]">{s?.up_after_1h_pct != null ? `${Math.round(s.up_after_1h_pct)}%` : '—'}</span></Ring>
        <Ring value={Math.min(10, s?.median_peak_x ?? 0)} max={10} size={150} color="var(--color-up)" label="Median peak"><span className="stat text-[34px]">{x(s?.median_peak_x)}</span></Ring>
      </div>

      {s?.by_detector && Object.keys(s.by_detector).length > 0 && (
        <Reveal className="mb-12">
          <div className="eyebrow mb-4">Which detectors earn their keep</div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {Object.entries(s.by_detector).sort((a: any, b: any) => b[1].hit_2x_pct - a[1].hit_2x_pct).map(([k, v]: any) => (
              <div key={k} className="glass rounded-2xl p-4">
                <div className="mb-2 flex items-center gap-2 text-white/70"><Icon name={DET_ICON[k] || 'bolt'} size={14} /><span className="text-[12px] font-semibold uppercase tracking-wider">{k}</span></div>
                <div className="stat text-[34px]">{v.hit_2x_pct}%</div>
                <div className="text-[11px] text-white/45">hit 2× · {v.calls} calls · median {x(v.median_peak_x)}</div>
              </div>
            ))}
          </div>
        </Reveal>
      )}

      <Reveal className="mb-12">
        <div className="eyebrow mb-4">Strategies · every first match graded (7 days)</div>
        <div className="glass overflow-x-auto rounded-[28px]">
          <table className="data-table w-full min-w-[820px] text-[13px]">
            <thead className="text-left text-white/45 [&>tr>th]:px-4 [&>tr>th]:py-3">
              <tr><th>Strategy</th><th className="text-right">Matches</th><th className="text-right">Peaked ≥ 2×</th><th className="text-right">≥ 5×</th>
                <th className="text-right">Up 1h later</th><th className="text-right">Graduated</th><th className="text-right">Median peak</th></tr>
            </thead>
            <tbody className="num [&>tr>td]:px-4 [&>tr>td]:py-3">
              {[...strategies].sort((a, b) => (b.stats.hit_2x_pct ?? -1) - (a.stats.hit_2x_pct ?? -1)).map((st) => (
                <tr key={st.id} className="border-t border-white/[0.05]">
                  <td className="font-sans"><b>{st.source === 'playbook' ? '✦ ' : st.source === 'custom' ? '★ ' : ''}{st.name}</b><div className="text-[11px] text-white/40">{st.source === 'preset' ? 'trader playbook' : st.source === 'playbook' ? 'crowd consensus' : 'yours'}</div></td>
                  <td className="text-right">{st.stats.hits}</td>
                  <td className={`text-right font-semibold ${(st.stats.hit_2x_pct ?? 0) >= 30 ? 'text-up' : ''}`}>{st.stats.hit_2x_pct != null ? `${st.stats.hit_2x_pct}%` : '—'}</td>
                  <td className="text-right">{st.stats.hit_5x_pct != null ? `${st.stats.hit_5x_pct}%` : '—'}</td>
                  <td className="text-right">{st.stats.up_1h_pct != null ? `${st.stats.up_1h_pct}%` : '—'}</td>
                  <td className="text-right">{st.stats.graduated_pct != null ? `${st.stats.graduated_pct}%` : '—'}</td>
                  <td className="text-right">{st.stats.median_peak_x ? `${st.stats.median_peak_x}×` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>

      <section className="glass overflow-hidden rounded-[28px]">
        <header className="flex items-center gap-3 border-b border-white/[0.06] px-6 py-4">
          <span className="display text-[28px]">The log</span><span className="stat text-[20px] text-white/35">{d?.calls?.length ?? ''}</span>
          <span className="ml-auto text-[11px] text-white/40">Peak = highest market cap reached after the call ÷ market cap at the call. Not a realized return.</span>
        </header>
        <div className="overflow-x-auto">
          <table className="data-table w-full min-w-[1100px] text-[13px]">
            <thead className="text-left text-white/45 [&>tr>th]:px-4 [&>tr>th]:py-3">
              <tr><th>Coin</th><th>Called</th><th>Score</th><th className="text-right">MC at call</th><th className="text-right">Peak</th><th className="text-right">5m</th>
                <th className="text-right">15m</th><th className="text-right">1h</th><th className="text-right">Now</th><th>Graduated</th><th>Trending</th><th>Why</th></tr>
            </thead>
            <tbody className="num [&>tr>td]:px-4 [&>tr>td]:py-3">
              {(d?.calls || []).map((c: any) => (
                <tr key={c.mint} className="border-t border-white/[0.05] hover:bg-white/[0.02]">
                  <td><Link href={`/token?a=${c.mint}`} className="flex items-center gap-2"><TokenIcon src={c.image} symbol={c.symbol} size={26} /><b className="font-sans">{c.symbol || short(c.mint)}</b></Link></td>
                  <td className="text-white/60">{ago(c.call_ts, now)} ago<div className="text-[10.5px] text-white/35">{mins(c.secs_after_launch)} after launch</div></td>
                  <td>{Math.round(c.score)}</td>
                  <td className="text-right">{usd(c.mcap_usd_at_call)}</td>
                  <td className={`text-right font-semibold ${(c.peak_x || 0) >= 2 ? 'text-up' : ''}`}>{x(c.peak_x)}<div className="text-[10.5px] font-normal text-white/35">{c.peak_after_s != null ? `after ${mins(c.peak_after_s)}` : ''}</div></td>
                  {['x_5m', 'x_15m', 'x_1h', 'now_x'].map((k) => <td key={k} className={`text-right ${c[k] == null ? 'text-white/30' : c[k] >= 1 ? 'text-up' : 'text-down'}`}>{x(c[k])}</td>)}
                  <td>{c.graduated_at ? <span className="text-accent2">{c.lead_to_graduation_s != null ? `+${mins(c.lead_to_graduation_s)}` : 'yes'}</span> : <span className="text-white/30">no</span>}</td>
                  <td>{c.first_trending_at ? <span className={c.lead_to_trending_s > 0 ? 'text-up' : 'text-white/50'}>{c.lead_to_trending_s > 0 ? `${mins(c.lead_to_trending_s)} later` : 'already'}</span> : <span className="text-white/30">—</span>}</td>
                  <td className="font-sans">
                    <div className="flex flex-wrap gap-1">
                      {(c.detectors || []).filter((x: any) => x.points > 0).map((x: any) => (
                        <span key={x.key} title={x.detail} className="flex items-center gap-1 rounded-full bg-up/10 px-1.5 py-[1px] text-[10px] font-semibold text-up"><Icon name={DET_ICON[x.key] || 'bolt'} size={10} />{x.label}</span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {d && !d.calls.length && <p className="p-12 text-center text-white/40">No calls in this window yet. The log starts the moment Radar is running against live pump.fun data — nothing is backfilled or simulated.</p>}
          {!d && <div className="skeleton m-6 h-40" />}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, big, sub }: { label: string; big: React.ReactNode; sub: string }) {
  return (
    <Reveal className="glass spotlight rounded-3xl p-6">
      <div className="eyebrow mb-2">{label}</div>
      {big}
      <div className="mt-1 text-[12px] text-white/50">{sub}</div>
    </Reveal>
  );
}
