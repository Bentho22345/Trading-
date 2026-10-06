// Deep links only — these terminals have no public data APIs, so we never scrape them.
export function tokenLinks(address: string, chain = 'solana', pair?: string) {
  if (chain !== 'solana') {
    return [
      { label: 'DexScreener', href: `https://dexscreener.com/${chain}/${pair || address}` },
      { label: 'GMGN', href: `https://gmgn.ai/${chain === 'ethereum' ? 'eth' : chain}/token/${address}` },
    ];
  }
  return [
    { label: 'DexScreener', href: `https://dexscreener.com/solana/${pair || address}` },
    { label: 'RugCheck', href: `https://rugcheck.xyz/tokens/${address}` },
    { label: 'Axiom', href: `https://axiom.trade/t/${address}` },
    { label: 'Photon', href: `https://photon-sol.tinyastro.io/en/lp/${pair || address}` },
    { label: 'GMGN', href: `https://gmgn.ai/sol/token/${address}` },
    { label: 'BullX', href: `https://neo.bullx.io/terminal?chainId=1399811149&address=${address}` },
    { label: 'Solscan', href: `https://solscan.io/token/${address}` },
    { label: 'pump.fun', href: `https://pump.fun/coin/${address}` },
  ];
}
