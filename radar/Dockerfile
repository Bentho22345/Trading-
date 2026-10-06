# One image: Next.js UI is built to static files and served by the FastAPI backend on one port.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM python:3.12-slim AS run
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/radar ./radar
COPY config /app/config
COPY --from=web /web/out /app/web/out
ENV RADAR_WEB_DIR=/app/web/out RADAR_DB_PATH=/app/data/radar.db PYTHONUNBUFFERED=1
RUN useradd -m radar && mkdir -p /app/data && chown radar /app/data
USER radar
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
CMD ["python", "-m", "radar"]
