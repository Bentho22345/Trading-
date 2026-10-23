# One image: Next.js UI built to static files, served by the FastAPI backend (UI + API + live WebSocket on one port).
# Works on Render (reads $PORT), Railway, Fly, or `docker compose up`.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_RADAR_API=
RUN npm run build

FROM python:3.12-slim AS run
WORKDIR /app/backend
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt
COPY backend/radar ./radar
COPY config /app/config
COPY --from=web /web/out /app/web/out
# Data (SQLite DB + encryption key) lives on a persistent disk mounted at /app/data.
# Runs as root so a freshly mounted host disk (Render, Docker volume) is always writable.
ENV RADAR_WEB_DIR=/app/web/out RADAR_DB_PATH=/app/data/radar.db PORT=8000 HOST=0.0.0.0
RUN mkdir -p /app/data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/api/healthz', timeout=4)"
CMD ["python", "-m", "radar"]
