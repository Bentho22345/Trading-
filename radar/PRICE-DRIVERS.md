# Memecoin price drivers in the Radar Score

What moves a memecoin, which of those Radar already scored, and what `radar/drivers.py` adds. Thresholds live in `config/scoring.yaml` (`drivers`, `catalyst`, `vetoes`) and are editable on the Settings page.

## Already scored before this change

| Driver | Where | Input |
|---|---|---|
| Volume / market cap | momentum | DexScreener 24h volume ÷ mcap |
| Buy/sell pressure, txn count | momentum | 5m buys vs sells |
| Absolute liquidity | momentum, veto under `min_liquidity_usd` | best pair liquidity |
| Liquidity growth | momentum | first vs last price tick in the hour |
| Price structure | momentum | higher lows vs lower lows over stored ticks |
| Unique buyers per minute | momentum | pump.fun trade stream |
| Holder count growth | momentum | RugCheck holder snapshots |
| Mint / freeze authority, rugged | safety + veto | RugCheck |
| LP locked % | safety | RugCheck |
| Top-10 holder share (static) | safety + veto | RugCheck, AMM vaults excluded |
| Insiders, RugCheck risk score | safety + veto | RugCheck |
| Dev initial buy %, dev sold % (cumulative) | safety | pump.fun trades |
| Snipers / bundles in first 5s | safety | pump.fun trades |
| Paid DexScreener boosts | safety penalty, weak catalyst | DexScreener |
| Deployer rug history | veto | Radar's token + safety tables |
| Narrative stage, velocity, spread, reach, bots, copycat | narrative | social engine |
| VIP CA / VIP mention / breaking news / listing chatter | catalyst | narrative flags |
| Smart-money buyers, KOL shill-and-dump | smart money | tracked wallets |
| BTC, SOL, meme sector, Fear & Greed | regime multiplier | market table |

Several drivers existed only as Rug Shield alerts (liquidity pulled, dev selling, top holder dumping) for watched tokens, and did not affect the score of anything else.

## Added

| Driver | Effect | How it is measured |
|---|---|---|
| **LP withdrawn** | safety −30 at `liq_removed_bad_pct` (20%); veto at `vetoes.max_liq_removed_pct_1h` (50%) | Liquidity change over the hour compared with sqrt(price change). Constant-product pools shrink with price on their own, so only the excess counts as withdrawal. |
| **Liquidity depth** | momentum credit up to `liq_mcap_good` (10% of mcap); safety −15 below `liq_mcap_thin` (3%) | liquidity ÷ market cap |
| **Largest single holder** | safety −2/pt above `max_holder_bad_pct` (5%) | RugCheck top holders, AMM vaults excluded |
| **Concentration trend** | safety −10 when top-10 share rises `top10_rise_bad_pts` (5 pts) in 1h | holder snapshots |
| **Token social volume** | blended into narrative (25%), or the whole narrative sub-score when no narrative is linked | Posts naming the CA (weight 1) or $TICKER (weight 0.5, shared with copycats) in the last hour, plus acceleration vs the hour before and distinct authors |
| **Dev selling now** | safety −20 | deployer sells in the last 15 minutes (pump.fun trades) |
| **Serial launcher** | safety −15 at `serial_launcher_7d` (5) launches | tokens by the same deployer in 7 days |
| **CEX listing for this token** | catalyst 80 | news headline naming a major exchange, a listing word and this token's ticker or name |
| **CoinGecko trending** | catalyst 45 | name and ticker both match CoinGecko's trending list |
| **pump.fun graduation** | catalyst 40 within `graduation_window_h` (6h) | `tokens.graduated_at` |

Every new value is stored in the signal's `inputs_json` under `drivers`, so backtests replay it. Older signals without `drivers` score exactly as before. The config `version` is now `v2`.

## Known limits

- Driver safety penalties apply only once a RugCheck report exists (the safety sub-score is empty before that). The LP-withdrawal veto applies regardless.
- Dev-selling detection uses pump.fun trades only. Dev sells on Raydium or other DEXes after graduation are not seen without Helius wallet history.
- $TICKER mentions cannot tell a coin from its copycats, which is why they count half. CA mentions are exact.
- Listing detection relies on the RSS/news feeds in `config/sources.yaml`; a listing announced only on X is caught by the narrative flag instead.
