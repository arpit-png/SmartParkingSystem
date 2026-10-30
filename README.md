# ParkGrid India

React/Vite + FastAPI parking sandbox for MP Nagar, Bhopal. Existing vehicle-fit search, map, bookings, directions, GPS tracking, QR/plate check-in, edge events, overflow, time simulation and RWA ledger remain available.

## Run locally

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
```

In a second terminal run `npm run dev -- --host 127.0.0.1`. Open http://localhost:5173. Vite proxies `/api` to port 8000. Preview the build with `npm run preview` (its API proxy also points at port 8000).

## Verify

```sh
npm run build
.venv/bin/python -m unittest discover -s tests -v
```

## Model configuration

No credentials are included. Copy `.env.example` to `.env`, provide your own `HF_TOKEN` with inference permissions and an available `HF_MODEL`, then start the API with `uvicorn main:app --env-file .env` (install `python-dotenv`), or export those variables before starting. On Vercel, add them under project environment variables. Never use a `VITE_` prefix for secrets. The assistant uses Hugging Face's server-side chat endpoint; if credentials are absent or inference fails, it visibly falls back to a local rules-based parking guide. Recommendations filter actual demo results by fit and vacancy, then sort by price; they are not ML predictions. `/api/v1/health` reports configuration, not a successful inference verification.

## Vercel

Import this directory as a Vite project. `vercel.json` builds `dist` and routes API requests to the Python ASGI function `api/index.py`; `requirements.txt` installs backend dependencies. No frontend API URL is required for same-origin deployment. Check `/api/v1/health` and perform a booking on the resulting preview deployment.

**This deploys a sandbox, not a production parking/payment system.** State is in memory and can reset or differ between serverless instances. Vahan data is seeded, escrow/insurance are simulations, and occupancy arrives through demo controls rather than a camera model. Before accepting real bookings, add shared transactional storage, authentication/authorization, authenticated camera webhooks, approved Vahan/payment/insurance integrations and monitoring. Simulation endpoints remain available to preserve the original features.

Map tiles use CARTO/OpenStreetMap. Address search uses Nominatim with a debounce; driving directions use the public OSRM demo service. These services need no supplied key but have public-use limits and no production availability guarantee. Obtain production service capacity before launch.

## Adapted components

The eight supplied reference files remain untouched in Downloads. Their useful patterns are adapted to this React app without Next.js aliases or component-demo dependencies:

| Reference | Parking adaptation |
| --- | --- |
| skiper3 | Expandable active-session timer pill |
| skiper26 | Persistent light/dark theme toggle |
| skiper37 | Animated availability and remaining-minute numbers |
| skiper58 | Rolling navigation and copilot text |
| skiper61 | Pointer-follow card spotlight using existing motion utilities |
| skiper87 | Faded, scrollable assistant bay list |
| skiper99 | Animated directional actions and expandable copilot control |
| skiper106 | Smooth focus inputs retaining native caret/selection and accessible labels |

Reduced-motion preferences disable decorative animation. All booking and demo tools remain available on mobile.

Provider/deployment references: https://huggingface.co/docs/inference-providers/en/index and https://vercel.com/docs/functions/runtimes/python.
