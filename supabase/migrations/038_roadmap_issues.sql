-- Migration 038: Roadmap issues tracker
CREATE TABLE IF NOT EXISTS roadmap_issues (
  id          TEXT PRIMARY KEY,  -- e.g. 'P1', 'P2'
  old_id      TEXT,              -- original GitHub issue number e.g. '#12'
  title       TEXT NOT NULL,
  phase       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'resolved', 'pending_decision')),
  notes       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO roadmap_issues (id, old_id, title, phase, status, notes) VALUES
  ('P1',  '#12', 'Ledger Mapping Architecture Audit',        'Phase A — Export Preview & Ledger Mapping',  'pending_decision', 'Audit delivered. Architecture decision pending.'),
  ('P2',  '#8',  'Editable Ledger Mappings in Export Preview','Phase A — Export Preview & Ledger Mapping',  'resolved',         'Resolved during P3 work session.'),
  ('P3',  '#7',  'Wrong Stock Item Ledger Mapping',           'Phase A — Export Preview & Ledger Mapping',  'resolved',         'HSN-driven mode deployed for Kapra Kothi Emporium. stock_item_mode column added to companies. stock_item_masters hsn_code/gst_percent corrected.'),
  ('P4',  '#4',  'Duplicate CGST / SGST / IGST Ledgers',      'Phase A — Export Preview & Ledger Mapping',  'resolved',         'Resolved.'),
  ('P5',  '#2',  'Company Mismatch Must Block Acceptance',    'Phase B — Invoice Validation Controls',       'open',             NULL),
  ('P6',  '#5',  'Seller GSTIN Cannot Equal Buyer GSTIN',     'Phase B — Invoice Validation Controls',       'open',             NULL),
  ('P7',  '#1',  'Duplicate Invoice Detection',               'Phase B — Invoice Validation Controls',       'open',             NULL),
  ('P8',  '#6',  'Supplier Master Dropdown',                  'Phase C — Workflow Improvements',             'open',             NULL),
  ('P9',  '#3',  'Multi-UOM Resolution',                      'Phase C — Workflow Improvements',             'open',             NULL),
  ('P10', '#9',  'Company Data Export / Import',              'Phase D — Administration',                    'open',             NULL),
  ('P11', '#10', 'Company Deletion Workflow',                 'Phase D — Administration',                    'open',             NULL),
  ('P12', '#11', 'Duplicate Company Name Prevention',         'Phase D — Administration',                    'open',             NULL)
ON CONFLICT (id) DO UPDATE SET
  status     = EXCLUDED.status,
  notes      = EXCLUDED.notes,
  updated_at = NOW();
