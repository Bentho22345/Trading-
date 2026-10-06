"""Payloads shaped exactly like the real upstream APIs (trimmed)."""
MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"
MINT_BAD = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
PAIR = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"

PUMP_CREATE = {
    "signature": "3sig1", "mint": MINT, "traderPublicKey": "Dev1111111111111111111111111111111111111111",
    "txType": "create", "initialBuy": 35_000_000, "solAmount": 1.0, "bondingCurveKey": "Curve111",
    "vTokensInBondingCurve": 1_037_000_000, "vSolInBondingCurve": 31.0, "marketCapSol": 29.9,
    "name": "Hawk Tuah", "symbol": "HAWKTUAH", "uri": "https://ipfs.io/ipfs/Qm", "pool": "pump",
}
PUMP_TRADE = {"signature": "3sig2", "mint": MINT, "traderPublicKey": "Buyer11111111111111111111111111111111111111",
              "txType": "buy", "tokenAmount": 1000.0, "solAmount": 0.5, "newTokenBalance": 1000.0,
              "bondingCurveKey": "Curve111", "vTokensInBondingCurve": 1, "vSolInBondingCurve": 31.5,
              "marketCapSol": 31.2, "pool": "pump"}
PUMP_MIGRATE = {"signature": "3sig3", "mint": MINT, "txType": "migrate", "pool": "pump-amm"}

DEX_PAIR = {
    "chainId": "solana", "dexId": "pumpswap", "url": f"https://dexscreener.com/solana/{PAIR.lower()}",
    "pairAddress": PAIR, "labels": [],
    "baseToken": {"address": MINT, "name": "Hawk Tuah", "symbol": "HAWKTUAH"},
    "quoteToken": {"address": "So11111111111111111111111111111111111111112", "name": "Wrapped SOL", "symbol": "SOL"},
    "priceNative": "0.0000004", "priceUsd": "0.0000612",
    "txns": {"m5": {"buys": 120, "sells": 80}, "h1": {"buys": 900, "sells": 610}, "h6": {"buys": 900, "sells": 610},
             "h24": {"buys": 900, "sells": 610}},
    "volume": {"h24": 412000.5, "h6": 412000.5, "h1": 300100.2, "m5": 41000},
    "priceChange": {"m5": 12.5, "h1": 140.2, "h6": 300, "h24": 300},
    "liquidity": {"usd": 52000.1, "base": 400000000, "quote": 170.2},
    "fdv": 61200, "marketCap": 61200, "pairCreatedAt": 1759766400000,
    "info": {"imageUrl": "https://dd.dexscreener.com/ds-data/tokens/solana/x.png",
             "websites": [{"label": "Website", "url": "https://hawk.example"}],
             "socials": [{"type": "twitter", "url": "https://x.com/hawk"}]},
    "boosts": {"active": 10},
}

RUG_REPORT = {
    "mint": MINT, "creator": "Dev1111111111111111111111111111111111111111",
    "token": {"mintAuthority": None, "freezeAuthority": None, "supply": 1_000_000_000, "decimals": 6},
    "topHolders": [
        {"address": "Pool1", "owner": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "pct": 20.0, "insider": False},
        {"address": "H1", "owner": "W1", "pct": 4.0, "insider": False},
        {"address": "H2", "owner": "W2", "pct": 3.5, "insider": True},
    ],
    "knownAccounts": {"pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": {"name": "Pump Fun AMM", "type": "AMM"}},
    "markets": [{"lp": {"lpLockedPct": 100.0}}],
    "risks": [{"name": "Low Liquidity", "value": "$52k", "description": "Low amount of liquidity", "score": 300, "level": "warn"}],
    "score": 301, "score_normalised": 5, "rugged": False, "totalHolders": 812, "graphInsidersDetected": 2,
}
RUG_REPORT_MINTABLE = {**RUG_REPORT, "mint": MINT_BAD,
                       "token": {"mintAuthority": "Auth11111111111111111111111111111111111111", "freezeAuthority": None},
                       "risks": [{"name": "Mint Authority still enabled", "level": "danger", "score": 30000}]}

GECKO_TRENDING = {
    "data": [{
        "id": f"solana_{PAIR}", "type": "pool",
        "attributes": {"address": PAIR, "name": "HAWKTUAH / SOL", "base_token_price_usd": "0.0000612",
                       "pool_created_at": "2026-10-06T16:00:00Z", "fdv_usd": "61200", "market_cap_usd": None,
                       "price_change_percentage": {"m5": "12.5", "h1": "140.2", "h24": "300"},
                       "transactions": {"h1": {"buys": 900, "sells": 610, "buyers": 400, "sellers": 300}},
                       "volume_usd": {"m5": "41000", "h1": "300100.2", "h24": "412000.5"}, "reserve_in_usd": "52000.1"},
        "relationships": {"base_token": {"data": {"id": f"solana_{MINT}", "type": "token"}},
                          "dex": {"data": {"id": "pumpswap", "type": "dex"}}},
    }],
    "included": [{"id": f"solana_{MINT}", "type": "token",
                  "attributes": {"address": MINT, "name": "Hawk Tuah", "symbol": "HAWKTUAH", "image_url": "missing.png"}}],
}
GECKO_OHLCV = {"data": {"attributes": {"ohlcv_list": [[1759766700, 2, 3, 1, 2.5, 100], [1759766400, 1, 2, 0.5, 2, 50]]}}}
