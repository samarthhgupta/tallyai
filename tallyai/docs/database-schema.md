# TallyAI — Database Schema

## Tables

### users
| Column | Type | Description |
|---|---|---|
| id | uuid | Primary key |
| email | text | Login email |
| name | text | Full name |
| created_at | timestamp | Signup date |

### companies
| Column | Type | Description |
|---|---|---|
| id | uuid | Primary key |
| user_id | uuid | Owner (links to users) |
| name | text | Company name |
| tally_company_name | text | Exact name in Tally |
| agent_token | text | Unique token for Agent |
| agent_connected | boolean | Is Agent online? |
| created_at | timestamp | |

### invoices
| Column | Type | Description |
|---|---|---|
| id | uuid | Primary key |
| company_id | uuid | Which company |
| user_id | uuid | Who uploaded |
| file_url | text | Stored file location |
| status | text | pending / reviewed / pushed / failed |
| created_at | timestamp | Upload time |
| pushed_at | timestamp | When pushed to Tally |

### invoice_data
| Column | Type | Description |
|---|---|---|
| id | uuid | Primary key |
| invoice_id | uuid | Links to invoices |
| vendor_name | text | Extracted vendor |
| invoice_number | text | Invoice number |
| invoice_date | date | Invoice date |
| line_items | jsonb | Array of line items |
| subtotal | numeric | Before tax |
| cgst | numeric | CGST amount |
| sgst | numeric | SGST amount |
| igst | numeric | IGST amount |
| total | numeric | Final total |
| tally_ledger | text | Mapped Tally ledger |
| ai_confidence | numeric | AI confidence score |
| corrected_by_user | boolean | Did user edit AI output |

### audit_log
| Column | Type | Description |
|---|---|---|
| id | uuid | Primary key |
| user_id | uuid | Who did it |
| company_id | uuid | Which company |
| invoice_id | uuid | Which invoice |
| action | text | uploaded / reviewed / approved / pushed |
| timestamp | timestamp | When |
| details | jsonb | Extra info |
