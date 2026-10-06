"""Contract-address and ticker detection in free text."""
from __future__ import annotations

import re

SOL_CA = re.compile(r"(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])")
EVM_CA = re.compile(r"\b0x[a-fA-F0-9]{40}\b")
CASHTAG = re.compile(r"(?<![\w$])\$([A-Za-z][A-Za-z0-9]{1,14})\b")
NOT_TICKERS = {"USD", "USDT", "USDC"}


def _plausible_sol(s: str) -> bool:
    # real mints mix cases and digits; plain words/hashes of one class are false positives
    return any(c.isdigit() for c in s) + any(c.islower() for c in s) + any(c.isupper() for c in s) >= 3 or s.endswith("pump")


def detect(text: str) -> dict[str, list[str]]:
    sol = [m for m in dict.fromkeys(SOL_CA.findall(text or "")) if _plausible_sol(m)]
    evm = list(dict.fromkeys(EVM_CA.findall(text or "")))
    tags = [t.upper() for t in dict.fromkeys(CASHTAG.findall(text or "")) if t.upper() not in NOT_TICKERS]
    return {"solana": sol, "evm": evm, "cashtags": tags}
