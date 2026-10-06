#!/usr/bin/env node
// Connection check: can this machine reach every data source PULSE uses?
// Run with:  npm run doctor
const checks = [
  ['News: Federal Reserve RSS', 'https://www.federalreserve.gov/feeds/press_all.xml'],
  ['News: BBC Business RSS', 'https://feeds.bbci.co.uk/news/business/rss.xml'],
  ['News: CNBC RSS', 'https://www.cnbc.com/id/15839069/device/rss/rss.html'],
  ['News: CoinDesk RSS', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['News: Cointelegraph RSS', 'https://cointelegraph.com/rss'],
  ['Crypto: Coinbase', 'https://api.exchange.coinbase.com/products/BTC-USD/ticker'],
  ['Stocks/FX: Stooq', 'https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcp&h&e=csv'],
  ['VIX: Cboe', 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json'],
  ['Options: Cboe chains', 'https://cdn.cboe.com/api/global/delayed_quotes/options/SPY.json'],
  ['Calendar: ForexFactory', 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'],
  ['Earnings: Nasdaq', `https://api.nasdaq.com/api/calendar/earnings?date=${new Date().toISOString().slice(0, 10)}`],
  ['Crypto: alternative.me', 'https://api.alternative.me/fng/?limit=1'],
  ['Crypto: CoinGecko', 'https://api.coingecko.com/api/v3/global'],
  ['Crypto: OKX', 'https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP'],
];

console.log('\nPULSE connection check\n');
let ok = 0;
for (const [name, url] of checks) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'Mozilla/5.0 PulseTerminal/0.1', Accept: '*/*' } });
    const good = res.status < 400;
    if (good) ok++;
    console.log(`${good ? '✅' : '❌'} ${name.padEnd(28)} HTTP ${res.status}  ${Date.now() - t0}ms`);
  } catch (e) {
    const code = e?.cause?.code || e?.name || 'error';
    console.log(`❌ ${name.padEnd(28)} ${code}`);
  }
}
let worker = false;
try {
  worker = (await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(2000) })).ok;
} catch { /* not running */ }

console.log(`\n${ok}/${checks.length} sources reachable · PULSE on :3000 ${worker ? 'running ✅' : 'not running (start it with npm run dev)'}\n`);
if (ok === 0) {
  console.log('Nothing is reachable: this network is blocking outbound requests (office/school Wi-Fi, VPN,');
  console.log('firewall or proxy). Try a home network or a phone hotspot, or set HTTPS_PROXY if you use a proxy.\n');
} else if (ok < checks.length) {
  console.log('Some sources are blocked or down. PULSE keeps working with the rest; blocked streams show red.\n');
} else {
  console.log('All good — every data source is reachable from this machine.\n');
}
