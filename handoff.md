# Hyperfusion Pricing Tool - Handoff

## Project Snapshot
- Repo: `Christu7/hyperfusion-pricing-tool`
- Frontend: React + Vite (`frontend/`)
- Backend: FastAPI (`backend/app/main.py`)
- Local orchestration: Docker Compose (`docker-compose.yml`)
- Production: Vercel (frontend + Python serverless API via `api/index.py`)

## Current Deployment Context
- External API paths on Vercel:
  - `/api/health`
  - `/api/skus`
  - `/api/uplifts`
  - `/api/use-cases`
  - `/api/quote`
- Internal FastAPI route decorators remain:
  - `/health`, `/skus`, `/uplifts`, `/use-cases`, `/quote`

## Auth Model (Current)
- Backend requires `x-api-key` for:
  - `GET /skus`
  - `GET /uplifts`
  - `GET /use-cases`
  - `POST /quote`
- `GET /health` is public.
- Backend env var:
  - `PRICING_API_KEY`
- Frontend auto-sends `x-api-key` from:
  - `VITE_PRICING_API_KEY`
- Frontend helper:
  - `frontend/src/apiClient.js`

## Core Files to Know
- Backend API + pricing logic:
  - `backend/app/main.py`
- Vercel API entrypoint:
  - `api/index.py`
- Vercel Python deps:
  - `api/requirements.txt`
- Vercel routing:
  - `vercel.json`
- Frontend app:
  - `frontend/src/App.jsx`
- Competitor CSV data layer:
  - `frontend/src/data/competitorRates.js`
- API contract doc:
  - `API_Integration_Contract.txt`
  - `API_Integration_Contract.pdf`

## Required Env Vars

### Backend
- `PRICELIST_CSV_URL`
- `VOLUME_CSV_URL`
- `UPLIFTS_CSV_URL`
- `USE_CASE_MAPPINGS_CSV_URL`
- `PRICING_API_KEY`

### Frontend
- `VITE_API_BASE_URL` (local dev often `http://localhost:8001`, deployed should be relative `/api`)
- `VITE_COMPETITORS_NA_CSV_URL`
- `VITE_COMPETITORS_EU_CSV_URL`
- `VITE_COMPETITORS_AP_CSV_URL`
- `VITE_PRICING_API_KEY`

## Known Working Behavior
- Competitor rates are loaded client-side from Google Sheets CSV URLs.
- Supports Google published links including `pubhtml` via conversion to CSV URL.
- Supports semicolon CSV and decimal commas (e.g. `1,89`).
- GPU selector aligned to: `A100`, `B200`, `GH200`, `H100`, `H200`, `L40S`.
- Hyperfusion row is bold in provider results.

## Quick Verification Commands
```bash
export BASE_URL='https://hyperfusion-pricing-tool.vercel.app'
export API_KEY='<your_key>'

curl -i "$BASE_URL/api/health"
curl -i -H "x-api-key: $API_KEY" "$BASE_URL/api/skus"
curl -i -H "x-api-key: $API_KEY" "$BASE_URL/api/uplifts"
curl -i -H "x-api-key: $API_KEY" "$BASE_URL/api/use-cases"
```

## Local Run
```bash
cd /Users/christiantufro/Desktop/Chris/Code/Codex
docker compose up --build
```

## Open Items / Next Work
- [ ] Add any new feature request here.
- [ ] Record production incident notes here.
- [ ] Record latest deployed commit hash here.

## Session Notes Template
- Date:
- Goal:
- Changes made:
- Files changed:
- Commands run:
- Validation results:
- Follow-ups:

Chat GPT 

# Recent Architecture & Auth Update (API Key Rollout)

## Decision Summary

* Public site remains accessible (no password protection).
* Backend endpoints are protected via `x-api-key`.
* Frontend automatically injects API key at build time.
* API key exposure in browser is accepted (internal tool assumption).

---

## Final Auth Architecture

### Backend (FastAPI)

Protected endpoints:

* GET /skus
* GET /uplifts
* GET /use-cases
* POST /quote

Public endpoint:

* GET /health

Auth mechanism:

* Required header: x-api-key
* Env var: PRICING_API_KEY
* Missing header → 401
* Incorrect header → 401
* Missing env var → 500
* Implemented via FastAPI dependency injection (Depends(require_api_key))

---

### Frontend (React + Vite)

* Automatically sends header:
  x-api-key: import.meta.env.VITE_PRICING_API_KEY
* Centralized in:
  frontend/src/apiClient.js
* No UI login or manual key input.
* VITE_PRICING_API_KEY must match PRICING_API_KEY.
* Any change to VITE_* variables requires redeploy (build-time injection).

---

## Production Environment Model (Vercel)

### Backend Environment Variables

* PRICELIST_CSV_URL
* VOLUME_CSV_URL
* UPLIFTS_CSV_URL
* USE_CASE_MAPPINGS_CSV_URL
* PRICING_API_KEY

### Frontend Environment Variables

* VITE_API_BASE_URL (prod should be `/api`)
* VITE_COMPETITITORS_NA_CSV_URL
* VITE_COMPETITITORS_EU_CSV_URL
* VITE_COMPETITITORS_AP_CSV_URL
* VITE_PRICING_API_KEY

---

## Incident Note – Competitor Rates Failure

Cause:

* VITE_COMPETITORS_*_CSV_URL not set in Vercel.
* Worked locally via .env, failed in production.

Resolution:

* Added variables to Vercel.
* Redeployed.

Lesson:

* All VITE_* variables must be explicitly defined in Vercel.
* Build must be redeployed after changes.

---

## Security Posture

* API key is embedded in frontend bundle.
* Visible via DevTools.
* Accepted risk due to internal distribution.
* Key acts as soft barrier, not strong security boundary.

Possible future upgrades:

* IP allowlist
* Vercel middleware auth
* Server-side proxy layer
* Per-client API keys

---

## System Status

* Auth model stable.
* Frontend and backend aligned.
* Competitor CSV loading verified.
* API contract documented.
* Production deployment stable.
