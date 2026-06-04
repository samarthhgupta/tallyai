-- Migration 016: Store Supplier Identity Resolution Engine architecture decisions
-- These are product-level architectural decisions for the Supplier Master module.

INSERT INTO prompt_rules (key, description, content) VALUES

('logic:supplier:identity_resolution_overview',
 'Supplier Identity Resolution Engine — core principle',
 'The goal is not supplier creation. The goal is supplier identity resolution. The system must intelligently determine which existing supplier master record an incoming invoice belongs to, or whether it belongs to a new supplier. The design principle is: high automation when confidence is high, human intervention only when ambiguity exists. If GSTIN is an exact match, automate with no friction. If GSTIN is uncertain or missing, ask the accountant.'),

('logic:supplier:gstin_as_primary_identifier',
 'GSTIN is the strongest supplier identity signal',
 'GSTIN is government-issued, unique per registration, and structured. It is the most trustworthy supplier identifier available in India. GSTIN structure: chars 1-2 = state code, chars 3-12 = PAN of the business, char 13 = registration sequence, chars 14-15 = checksum. When GSTIN matches exactly between an incoming invoice and an existing supplier master: automatically map with no confirmation popup, no approval required, no interruption to accountant workflow. The name on the invoice may differ slightly — that is acceptable and expected.'),

('logic:supplier:gstin_exact_match_workflow',
 'Exact GSTIN match — automatic mapping with advisory',
 'When incoming invoice GSTIN matches exactly with an existing supplier master GSTIN: (1) Automatically link the invoice to that supplier master. (2) If the supplier name on the invoice differs from the name on the supplier master, show a non-blocking advisory notification on the dashboard. The advisory says: "Supplier was automatically matched using GSTIN. Detected name: [X]. Mapped to: [Y]. Reason: GSTIN matched exactly. Supplier name differs slightly. Please review if required." The advisory must NOT prevent acceptance, NOT require acknowledgement, NOT require confirmation. It is informational only. Accountant can override by editing the invoice and changing the supplier manually, or rejecting the invoice entirely.'),

('logic:supplier:no_gstin_similarity_scoring',
 'CRITICAL: Never compute GSTIN similarity scores',
 'GSTIN is a structured 15-character code with specific meaning in each position. Two GSTINs that look 85% similar could belong to completely different businesses in different states. NEVER compute a similarity score between two GSTINs. A GSTIN either matches exactly or it does not. When OCR partially extracts a GSTIN (e.g. "09ABCDE123" instead of "09ABCDE1234F1Z5"), treat it as GSTIN UNKNOWN — do not attempt partial matching. Fall back entirely to secondary signals: name similarity, invoice series, historical behaviour.'),

('logic:supplier:multi_signal_matching',
 'Multi-signal matching for ambiguous cases (no GSTIN or partial GSTIN)',
 'When GSTIN is unknown or unreadable, use four signals with the following weights and logic:
SIGNAL 1 — GSTIN (exact match only): If exact → confidence 100%, auto-map. If partial/unclear → treat as unknown, do not use similarity.
SIGNAL 2 — Supplier Name Similarity: Use fuzzy matching algorithm (handles abbreviations, typos, missing words). Score 0-100%. Weight: high.
SIGNAL 3 — Invoice Number Series Pattern: Match the PREFIX pattern of the invoice number (e.g. "SPE/2026-27/"). If the system has seen this prefix from a known supplier, this increases confidence. Weight: moderate. Caution: some suppliers use different series for different buyers, or reset mid-year — do not over-weight.
SIGNAL 4 — Historical Product Categories: Only a supporting signal. If the supplier has historically supplied similar product categories, this slightly increases confidence. Weight: low. Never use as a primary driver. A supplier may expand into new categories.
CONFIDENCE SCORING FORMULA (explicit):
- Exact GSTIN → 100%, auto-map, no confirmation
- GSTIN unknown + name similarity >= 85% + invoice series match → 75% confidence, show suggestion, require accountant confirmation
- GSTIN unknown + name similarity >= 85% + no series match → 50% confidence, show suggestion, require accountant confirmation
- GSTIN unknown + name similarity < 85% → low confidence, do not suggest automatically, ask accountant to search manually or create new'),

('logic:supplier:accountant_confirmation_popup',
 'Supplier suggestion popup for ambiguous cases',
 'When confidence is below 100% (i.e. GSTIN was not an exact match), show a supplier suggestion popup before the accountant accepts the invoice. The popup shows: Suggested Supplier name, Reasons why it was suggested (each signal that matched, shown as checkmarks), and three options: (1) Confirm Suggested Supplier, (2) Choose Another Existing Supplier from a searchable dropdown, (3) Create New Supplier inline without leaving the screen. The popup is blocking — the accountant must make a choice before proceeding. This is different from the advisory notification (which is non-blocking) used for exact GSTIN matches with name differences.'),

('logic:supplier:create_inline',
 'Create new supplier without leaving the invoice review screen',
 'If the accountant determines an incoming invoice is from a brand new supplier, they must be able to create the supplier master record directly from the invoice review screen — specifically from within the supplier dropdown or the supplier suggestion popup. The workflow is: Supplier Dropdown → Create New Supplier → Fill details → Save → Continue reviewing invoice. The accountant must never be forced to navigate away from the invoice review screen to create a supplier. Losing context mid-review causes mistakes.'),

('logic:supplier:merge_and_split_operations',
 'Supplier Master must support Merge and Split operations',
 'The resolution engine will sometimes make mistakes. Two critical correction operations must be supported from day one:
MERGE: When an accountant realises that two separate supplier master records are actually the same business, they must be able to merge them into one. All invoices linked to both records must automatically re-link to the merged record. The merged record keeps the GSTIN as the canonical identifier.
SPLIT: When an accountant realises that one supplier master record was incorrectly used for two different businesses, they must be able to split it — reassigning invoices to two separate records.
Without merge and split, every resolution mistake becomes permanent and can never be cleanly corrected. These are not optional features — they are architectural requirements.'),

('logic:supplier:pan_as_secondary_signal',
 'PAN number — hidden inside GSTIN, useful for multi-GSTIN suppliers',
 'Characters 3 to 12 of a GSTIN are the PAN number of the business. If two different GSTINs share the same PAN (characters 3-12 are identical), they represent the same legal entity registered in different states. Example: a large distributor with warehouses in Delhi and Mumbai will have two different GSTINs but the same PAN. This is a strong signal that both GSTINs belong to the same supplier. The system should detect shared PAN across GSTINs and flag this to the accountant as a potential same-entity match, even though the GSTINs differ.'),

('logic:supplier:resolution_engine_as_standalone_module',
 'Supplier Identity Resolution must be a standalone module, separate from Supplier Master CRUD',
 'The resolution engine (deciding which supplier master an invoice belongs to) must be architecturally separate from the supplier master management (creating, editing, deleting supplier records). Reasons: (1) Resolution logic will evolve independently as the algorithm improves. (2) Every resolution decision must be logged with its signals and scores for auditability and algorithm improvement. (3) The same resolution logic will later apply to item matching. (4) Easier to test in isolation. The resolution engine answers one question only: which supplier does this invoice belong to? Everything else is a separate concern.'),

('logic:supplier:resolution_audit_log',
 'Every resolution decision must be logged with full signal details',
 'The system must maintain an audit log of every supplier resolution decision. Each log entry records: invoice ID, timestamp, GSTIN found on invoice, name found on invoice, invoice series prefix found, matched supplier master ID (if any), each signal''s score, overall confidence score, decision made (auto-mapped / suggestion shown / not matched), whether accountant overrode the decision, and if overridden — what they chose instead. This log serves two purposes: (1) Accountants can audit why a specific match was made. (2) The algorithm can be improved over time by studying where it was wrong.'),

('logic:supplier:async_resolution',
 'Resolution engine must run asynchronously, not during upload',
 'Supplier identity resolution must not block or slow down the invoice upload and extraction pipeline. The correct sequence is: (1) Invoice uploaded → (2) AI extraction runs → (3) Resolution engine runs in background → (4) By the time accountant opens invoice for review, supplier suggestion is already computed and ready. Running resolution synchronously during upload will slow down the system at scale and create a poor user experience.'),

('logic:supplier:fuzzy_name_matching',
 'Supplier name similarity must use fuzzy matching, not string comparison',
 'Simple string comparison will not catch "Shree Parshwanath Enterprises" vs "Shree Parshwanth Ent." — they are clearly the same but differ in characters, abbreviation, and length. A proper fuzzy matching algorithm must be used that handles: abbreviations (Enterprises → Ent.), missing characters (Parshwanath → Parshwanth), word order variations, common suffix/prefix differences. This is a solved problem in software engineering. The algorithm must be plugged in from the start — retrofitting fuzzy matching onto a system built with string comparison is expensive.'),

('logic:supplier:multi_gstin_per_supplier',
 'Architecture decision needed: one supplier with multiple GSTINs',
 'Large businesses register for GST in each state separately, resulting in one GSTIN per state for the same legal entity. A national distributor may supply from their Delhi GSTIN sometimes and their Mumbai GSTIN other times. Architecture question that must be answered before building: should the Supplier Master support one record with multiple GSTINs (parent-child model), or should each GSTIN be a separate supplier record with a link between them? This decision affects Tally ledger creation, GSTR-2B reconciliation, and ITC tracking. Currently unresolved — needs accountant input.')

ON CONFLICT (key) DO UPDATE
  SET content     = EXCLUDED.content,
      description = EXCLUDED.description,
      updated_at  = NOW();
