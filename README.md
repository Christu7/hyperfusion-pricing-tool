# Pricing Tool

## Docker Compose (one command)

Prereq: Docker Desktop running.

1. Ensure `/Users/christiantufro/Desktop/Chris/Code/Codex/backend/.env` has:
- `PRICELIST_CSV_URL`
- `VOLUME_CSV_URL`
- `UPLIFTS_CSV_URL`
- `USE_CASE_MAPPINGS_CSV_URL`

2. Start full stack:
```bash
cd /Users/christiantufro/Desktop/Chris/Code/Codex
docker compose up --build
```

3. Open:
- App: `http://localhost:8080`
- Backend health: `http://localhost:8001/health`

Stop:
```bash
docker compose down
```

## Backend (FastAPI)

### Setup
```bash
cd /Users/christiantufro/Desktop/Chris/Code/Codex/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Set real CSV URLs in `.env`:
- `PRICELIST_CSV_URL`
- `VOLUME_CSV_URL`
- `UPLIFTS_CSV_URL`
- `USE_CASE_MAPPINGS_CSV_URL`

### Run
```bash
cd /Users/christiantufro/Desktop/Chris/Code/Codex/backend
source .venv/bin/activate
set -a; source .env; set +a
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

API endpoints:
- `GET /health`
- `GET /skus`
- `GET /uplifts`
- `GET /use-cases`
- `POST /quote`

## Frontend (React + Vite)

### Setup
```bash
cd /Users/christiantufro/Desktop/Chris/Code/Codex/frontend
npm install
cp .env.example .env
```

Set frontend CSV URLs in `.env`:
- `VITE_COMPETITORS_NA_CSV_URL`
- `VITE_COMPETITORS_EU_CSV_URL`
- `VITE_COMPETITORS_AP_CSV_URL`

### Run
```bash
cd /Users/christiantufro/Desktop/Chris/Code/Codex/frontend
npm run dev
```

Default API base URL is `/api` (set via `VITE_API_BASE_URL`).
