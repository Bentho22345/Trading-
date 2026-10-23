import os

import uvicorn

uvicorn.run("radar.app:app", host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", 8000)),
            proxy_headers=True, log_level=os.environ.get("LOG_LEVEL", "info").lower())
