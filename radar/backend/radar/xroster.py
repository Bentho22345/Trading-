"""The starting X roster: public accounts whose posts have moved memecoins, or that memecoin traders watch.

Tiers decide how often Radar checks an account (S every ~10s, A ~30s, B ~90s) and how loud its tweets are.
Radar then learns: callers whose calls perform get promoted (and new ones added), the ones that don't get demoted.
Edit freely on the X Radar page: add anyone, change tiers, mute, remove. An unknown handle simply returns nothing.
"""
from __future__ import annotations

# (handle, category, tier, include_replies)
SEED: list[tuple[str, str, str, bool]] = [
    # --- the accounts whose posts have historically moved memecoins the most ---
    ("elonmusk", "celebrity", "S", True),            # replies included: his one-word replies have tokenized coins
    ("realDonaldTrump", "politician", "S", False),
    ("POTUS", "politician", "S", False),
    ("WhiteHouse", "politician", "S", False),
    ("JDVance", "politician", "S", False),
    ("DonaldJTrumpJr", "politician", "S", False),
    ("EricTrump", "politician", "S", False),
    ("MELANIATRUMP", "politician", "S", False),
    ("cz_binance", "founder", "S", False),
    ("heyibinance", "founder", "S", False),
    ("pumpdotfun", "launchpad", "S", False),
    ("a1lon9", "founder", "S", False),
    ("DogeDesigner", "kol", "S", False),
    ("BillyM2k", "founder", "S", False),
    # --- politicians / officials ---
    ("DavidSacks", "politician", "A", False),
    ("SenLummis", "politician", "A", False),
    ("nayibbukele", "politician", "A", False),
    ("JavierMilei", "politician", "A", False),
    ("SpeakerJohnson", "politician", "A", False),
    ("GovRonDeSantis", "politician", "B", False),
    ("RobertKennedyJr", "politician", "B", False),
    # --- crypto founders & ecosystem ---
    ("VitalikButerin", "founder", "A", False),
    ("brian_armstrong", "founder", "A", False),
    ("aeyakovenko", "founder", "A", False),
    ("rajgokal", "founder", "A", False),
    ("saylor", "founder", "A", False),
    ("justinsuntron", "founder", "A", False),
    ("jessepollak", "founder", "A", False),
    ("0xMert_", "founder", "A", False),
    ("weremeow", "founder", "A", False),
    ("ShawMakesMagic", "founder", "B", False),
    ("solana", "ecosystem", "A", False),
    ("phantom", "ecosystem", "B", False),
    ("JupiterExchange", "ecosystem", "B", False),
    ("bonk_inu", "ecosystem", "B", False),
    ("aixbt_agent", "kol", "B", False),
    # --- celebrities / creators who launch or touch coins ---
    ("Cobratate", "celebrity", "A", False),
    ("kanyewest", "celebrity", "A", False),
    ("MrBeast", "celebrity", "B", False),
    ("MattFurie", "celebrity", "B", False),
    ("snoopdogg", "celebrity", "B", False),
    ("cb_doge", "kol", "A", False),
    # --- memecoin KOLs / traders ---
    ("blknoiz06", "kol", "A", False),
    ("MustStopMurad", "kol", "A", False),
    ("frankdegods", "kol", "A", False),
    ("notthreadguy", "kol", "A", False),
    ("theunipcs", "kol", "A", False),
    ("Cupseyy", "kol", "A", False),
    ("orangie", "kol", "A", False),
    ("cobie", "kol", "B", False),
    ("HsakaTrades", "kol", "B", False),
    ("CryptoKaleo", "kol", "B", False),
    ("inversebrah", "kol", "B", False),
    ("GiganticRebirth", "kol", "B", False),
    ("ZssBecker", "kol", "B", False),
    ("Pentosh1", "kol", "B", False),
    ("gainzy222", "kol", "B", False),
    ("zachxbt", "kol", "B", False),
    # --- fast news & viral culture (memes are born here) ---
    ("WatcherGuru", "news", "A", False),
    ("tier10k", "news", "A", False),
    ("DeItaone", "news", "A", False),
    ("unusual_whales", "news", "B", False),
    ("PopBase", "culture", "A", False),
    ("PopCrave", "culture", "A", False),
    ("dexerto", "culture", "B", False),
    ("disclosetv", "news", "B", False),
    ("Breaking911", "news", "B", False),
    ("BBCBreaking", "news", "B", False),
    ("Reuters", "news", "B", False),
    ("AP", "news", "B", False),
    ("lookonchain", "onchain", "B", False),
    ("whale_alert", "onchain", "B", False),
    ("bubblemaps", "onchain", "B", False),
    # --- exchanges (listings move coins) ---
    ("binance", "exchange", "A", False),
    ("coinbase", "exchange", "A", False),
    ("CoinbaseAssets", "exchange", "A", False),
    ("Robinhood", "exchange", "B", False),
    ("krakenfx", "exchange", "B", False),
]

# accounts whose newest follows are checked (Elon following a tiny coin's account sent it up ~10,000% in minutes)
FOLLOW_WATCH = ["elonmusk"]

# which roster categories count as which social tier in the narrative engine
SOCIAL_TIER = {"politician": "vip", "celebrity": "vip", "founder": "vip", "launchpad": "vip", "kol": "kol", "caller": "kol",
               "news": "news", "culture": "news", "exchange": "news", "onchain": "news", "ecosystem": "kol"}
