# ── Stage 1: Build React frontend ────────────────────────────────────────────
FROM node:20-slim AS frontend

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./

# Vite outDir is '../backend/dist' → outputs to /app/backend/dist
RUN npm run build

# ── Stage 2: Production Python server ────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .

# Copy built frontend from stage 1
COPY --from=frontend /app/backend/dist ./dist

ENV PORT=8080
EXPOSE 8080

CMD ["python", "server.py"]
