// MLB / USA Baseball Pitch Smart guidelines (verified against mlb.com/pitch-smart pages, 2026).
// Rest bands: pitches thrown in a day → required days of rest.

export interface PitchSmartRow {
  ages: string;
  minAge: number;
  maxAge: number;
  dailyMax: number;
  /** upper pitch count for 0,1,2,3,4,(5) days of rest; Infinity = up to the daily max */
  bands: number[];
  inningsPer12Mo?: number;
}

export const PITCH_SMART: PitchSmartRow[] = [
  { ages: '8 and under', minAge: 0, maxAge: 8, dailyMax: 50, bands: [20, 35, 50] },
  { ages: '9–10', minAge: 9, maxAge: 10, dailyMax: 75, bands: [20, 35, 50, 65, Infinity], inningsPer12Mo: 80 },
  { ages: '11–12', minAge: 11, maxAge: 12, dailyMax: 85, bands: [20, 35, 50, 65, Infinity], inningsPer12Mo: 80 },
  { ages: '13–14', minAge: 13, maxAge: 14, dailyMax: 95, bands: [20, 35, 50, 65, Infinity], inningsPer12Mo: 100 },
  { ages: '15–16', minAge: 15, maxAge: 16, dailyMax: 95, bands: [30, 45, 60, 75, Infinity], inningsPer12Mo: 100 },
  { ages: '17–18', minAge: 17, maxAge: 18, dailyMax: 105, bands: [30, 45, 60, 80, Infinity], inningsPer12Mo: 100 },
  { ages: '19–22', minAge: 19, maxAge: 22, dailyMax: 120, bands: [30, 45, 60, 80, 105, Infinity] },
];

export const PITCH_SMART_RULES = [
  'Watch for fatigue: if a pitcher looks or says they are tired, stop.',
  'No overhead throwing of any kind for at least 2–3 continuous months per year, and at least 4 months off competitive pitching.',
  'Do not pitch on consecutive days in multiple games, and never 3 days in a row.',
  'Avoid playing catcher while not pitching, and avoid pitching for multiple teams with overlapping seasons.',
  'Learn good mechanics and a fastball/changeup first; pitching with pain is a hard stop — see a professional.',
];

export function rowForAge(age: number): PitchSmartRow | undefined {
  return PITCH_SMART.find((r) => age >= r.minAge && age <= r.maxAge);
}

/** Required days of rest after throwing `pitches` in a day. */
export function restDays(age: number, pitches: number): number | null {
  const r = rowForAge(age);
  if (!r || pitches <= 0) return pitches <= 0 ? 0 : null;
  for (let i = 0; i < r.bands.length; i++) if (pitches <= r.bands[i]) return i;
  return r.bands.length - 1;
}

export interface DayLog { date: string; pitches: number; pain?: boolean }

/** Check a pitch log against Pitch Smart for a given age; returns human-readable warnings. */
export function checkPitchSmart(age: number, log: DayLog[]): string[] {
  const r = rowForAge(age);
  const out: string[] = [];
  if (!r) return ['Pitch Smart guidelines cover ages up to 22.'];
  const days = [...log].filter((d) => d.pitches > 0).sort((a, b) => a.date.localeCompare(b.date));
  const dayNum = (s: string) => Math.round(Date.parse(s + 'T00:00:00Z') / 86400000);
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (d.pitches > r.dailyMax) out.push(`${d.date}: ${d.pitches} pitches is over the daily max of ${r.dailyMax} for ages ${r.ages}.`);
    if (d.pain) out.push(`${d.date}: pitched with pain — stop throwing and see a qualified professional.`);
    const need = restDays(age, d.pitches) ?? 0;
    const next = days[i + 1];
    if (next) {
      const gap = dayNum(next.date) - dayNum(d.date) - 1;
      if (gap < need) out.push(`${next.date}: pitched after ${gap} rest day${gap === 1 ? '' : 's'}, but ${d.pitches} pitches on ${d.date} needs ${need}.`);
    }
    const n2 = days[i + 2];
    if (next && n2 && dayNum(n2.date) - dayNum(d.date) === 2 && dayNum(next.date) - dayNum(d.date) === 1) out.push(`${n2.date}: pitched 3 days in a row — Pitch Smart says never do this.`);
  }
  return out;
}

/** Acute:chronic workload ratio (rolling sums). Returns null without enough history. */
export function acwr(log: { date: string; load: number }[], today: string, acuteDays = 9, chronicDays = 28): { acute: number; chronic: number; ratio: number | null } {
  const t = Date.parse(today + 'T00:00:00Z');
  const sum = (days: number) => log.filter((d) => { const dt = (t - Date.parse(d.date + 'T00:00:00Z')) / 86400000; return dt >= 0 && dt < days; }).reduce((s, d) => s + d.load, 0);
  const acute = sum(acuteDays) / acuteDays;
  const chronic = sum(chronicDays) / chronicDays;
  return { acute, chronic, ratio: chronic > 0 ? acute / chronic : null };
}
