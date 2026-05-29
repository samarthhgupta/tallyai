# TallyAI

> Upload a purchase invoice. AI reads it. You approve. It goes into Tally automatically.

---

## What This Is

TallyAI is a SaaS web tool that acts as a bridge between users and their Tally accounting software.

- Works from any device, any browser, anywhere
- AI extracts invoice data automatically
- One click to push approved entries into Tally
- Each customer's data is completely separate
- Supports multiple Tally companies per customer

---

## How It Works

```
Customer uploads invoice (phone/laptop)
        ↓
AI reads and extracts data
        ↓
Customer reviews and approves
        ↓
Cloud sends to Tally Agent on customer's PC
        ↓
Agent pushes entry into Tally silently
        ↓
"Entry successful" confirmation
```

---

## Project Structure

```
tallyai/
├── frontend/       # Next.js web app — what the customer sees
├── backend/        # Python FastAPI — cloud logic and AI
├── agent/          # Python — runs on customer's Tally PC
└── docs/           # Architecture and planning docs
```

---

## Phase 1 Scope (Building Now)

- [ ] Customer signup and login
- [ ] Add company and connect Tally Agent
- [ ] Upload purchase invoice (PDF or image)
- [ ] AI extracts vendor, date, amount, GST, line items
- [ ] Review and correct screen
- [ ] Approve and push to Tally
- [ ] Basic history log

---

## Tech Stack

| Layer | Technology |
|---|---|
| Web Tool | Next.js + Tailwind CSS |
| Backend | Python FastAPI |
| Database | Supabase |
| AI | Claude API (Anthropic) |
| Tally Agent | Python |
| Backend Hosting | Railway |
| Frontend Hosting | Vercel |

---

## Tally Integration

TallyAI uses Tally's built-in **XML API (TallyPrime)** to push data.
The Agent is a lightweight Python service installed once on the customer's Tally PC.
It connects outward to the TallyAI cloud — no inbound ports required.

---

## Future Phases

- Sales invoices
- Payment and receipt entries
- Email invoice forwarding
- Mobile app
- Multi-user per company
- Role based access
- Billing and subscriptions
