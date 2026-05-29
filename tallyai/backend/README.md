# TallyAI Backend

Python FastAPI backend — cloud logic, AI processing, and Agent communication.

## Setup

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

API runs at http://localhost:8000
Docs at http://localhost:8000/docs

## Environment Variables

Create a `.env` file:

```
ANTHROPIC_API_KEY=your_claude_api_key
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_supabase_service_key
SECRET_KEY=your_secret_key
```

## API Routes (Phase 1)

- `POST /auth/signup` — Register new customer
- `POST /auth/login` — Login
- `GET /companies` — List customer's companies
- `POST /companies` — Add new company
- `POST /invoices/upload` — Upload invoice file
- `GET /invoices/{id}` — Get extracted invoice data
- `POST /invoices/{id}/approve` — Approve and push to Tally
- `GET /invoices` — Invoice history
- `WS /agent/connect` — Agent websocket connection
