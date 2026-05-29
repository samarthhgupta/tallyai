# TallyAI Frontend

Next.js web application — the customer-facing interface.

## Setup

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000

## Environment Variables

Create a `.env.local` file:

```
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
NEXT_PUBLIC_API_URL=http://localhost:8000
```

## Screens (Phase 1)

- `/` — Landing page
- `/login` — Login / Signup
- `/dashboard` — Main dashboard
- `/upload` — Upload invoice
- `/review/[id]` — Review extracted data
- `/history` — Past invoices
- `/settings` — Company and Agent settings
