import asyncio
import time

from radar.ratelimit import TokenBucket


def test_bucket_paces_requests():
    async def run():
        b = TokenBucket(per_minute=600, burst=2)  # 10/s
        t0 = time.monotonic()
        for _ in range(7):
            await b.acquire()
        return time.monotonic() - t0
    elapsed = asyncio.run(run())
    assert 0.4 <= elapsed < 1.0  # 2 burst + 5 paced at 10/s


def test_penalize_blocks():
    b = TokenBucket(per_minute=600, burst=5)
    b.penalize(0.3)
    assert b.headroom() == 0.0
