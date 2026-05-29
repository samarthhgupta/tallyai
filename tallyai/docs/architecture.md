# TallyAI — Architecture

## The 4 Layers

### Layer 1: Frontend (Web Tool)
- Built with Next.js
- Hosted on Vercel
- Accessible from any browser, any device
- Each customer has their own workspace
- Supports multiple Tally companies per account

**Key screens:**
- Login / Signup
- Dashboard
- Upload Invoice
- Review Extracted Data
- Push to Tally
- Invoice History

---

### Layer 2: Backend (Cloud Logic)
- Built with Python FastAPI
- Hosted on Railway
- Handles all business logic
- Calls Claude AI API for invoice reading
- Manages customer data isolation
- Routes approved entries to correct Tally Agent

**Key responsibilities:**
- Authentication and authorization
- Invoice processing pipeline
- AI extraction and mapping
- Agent communication
- Audit trail

---

### Layer 3: Database
- Supabase (PostgreSQL)
- Row Level Security ensures each customer sees only their data

**Key tables:**
- users
- companies (each customer can have multiple)
- invoices
- transactions
- agent_connections

---

### Layer 4: Tally Agent
- Lightweight Python service
- Installed once on customer's Tally PC
- Connects outward to TallyAI cloud (no firewall issues)
- Uses Tally's built-in XML API on port 9000
- Sends confirmation back after successful entry

---

## Data Flow — Purchase Invoice

```
1. Customer selects company
2. Uploads invoice (PDF/image)
3. Backend receives file
4. Claude AI extracts:
   - Vendor name
   - Invoice number
   - Invoice date
   - Line items (description, qty, rate, amount)
   - GST (CGST, SGST, IGST)
   - Total amount
5. Extracted data shown to customer
6. Customer reviews, corrects if needed
7. Customer clicks Approve
8. Backend formats data as Tally XML voucher
9. Sends to Agent via secure websocket
10. Agent pushes XML to Tally on localhost:9000
11. Tally creates entry
12. Agent confirms success
13. Backend marks invoice as "pushed"
14. Customer sees "Entry successful"
```

---

## Multi-Company Support

Each customer can register multiple Tally companies.
Each company has its own Agent connection.
Invoice routing is based on company selected at upload time.

---

## Security

- All data encrypted in transit (HTTPS/WSS)
- Each customer's data isolated via Supabase RLS
- Agent uses unique token per installation
- No customer can access another customer's data
- Full audit trail of every action

---

## Scalability Design

- Stateless backend — can run multiple instances
- Queue-based invoice processing (can add Redis later)
- Database connection pooling via Supabase
- Agent connections managed via websocket pool
- Designed for 1000 customers, 50000 transactions/month from day one
