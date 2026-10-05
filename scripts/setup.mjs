#!/usr/bin/env node
// Interactive key setup: paste free API keys, they're written to .env (server-side only).
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const rl = createInterface({ input: process.stdin, output: process.stdout });
if (!existsSync('.env')) copyFileSync('.env.example', '.env');
let env = readFileSync('.env', 'utf8');

const ask = [
  ['FINNHUB_API_KEY', 'Finnhub — real-time US stocks + market news + earnings (free: https://finnhub.io/register)'],
  ['ALPACA_API_KEY_ID', 'Alpaca Key ID — real-time IEX stock trades (free: https://app.alpaca.markets/signup)'],
  ['ALPACA_API_SECRET_KEY', 'Alpaca Secret'],
  ['TWELVEDATA_API_KEY', 'Twelve Data — FX quotes (free: https://twelvedata.com/register)'],
  ['ANTHROPIC_API_KEY', 'Anthropic — optional AI TL;DRs (https://console.anthropic.com)'],
];

console.log('\nPULSE key setup — press Enter to skip any. Without keys, everything still runs on keyless live sources.\n');
for (const [k, label] of ask) {
  const v = (await rl.question(`${label}\n  ${k}: `)).trim();
  if (!v) continue;
  env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${env}\n${k}=${v}\n`;
}
writeFileSync('.env', env);
rl.close();
console.log('\nSaved to .env. Start with: npm run dev\n');
