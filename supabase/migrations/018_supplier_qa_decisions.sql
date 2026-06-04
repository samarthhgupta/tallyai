-- Migration 018: Supplier architecture decisions from Q&A session

INSERT INTO prompt_rules (key, description, content) VALUES

('logic:supplier:gstin_partial_means_unknown',
 'Q&A Decision: Partial GSTIN must be treated as unknown, not similarity-scored',
 'DECISION FROM ARCHITECT REVIEW: When OCR extracts a partial or unclear GSTIN (e.g. "09ABCDE123" instead of "09ABCDE1234F1Z5"), the system must treat it as GSTIN UNKNOWN. Do not compute a similarity score between two GSTINs. A GSTIN is a structured identifier — two GSTINs that appear 85% similar may belong to completely different businesses in different states. Partial GSTIN = fall back entirely to secondary signals: name similarity, invoice series pattern, address/PIN. This was identified as the biggest risk in the original design and must be enforced strictly.'),

('logic:supplier:invoice_series_moderate_weight',
 'Q&A Decision: Invoice number series is a moderate signal, not a strong one',
 'DECISION FROM ARCHITECT REVIEW: Invoice number series prefix (e.g. "SPE/2026-27/") is a useful but moderate-weight signal in supplier resolution. It must not be over-weighted because: (1) some suppliers use different series for different buyers, (2) some reset numbering mid-year, (3) some run multiple series simultaneously (cash vs GST invoices). Use it as a supporting confirmatory signal when name similarity is already high. Never use it as a primary driver for auto-mapping.'),

('logic:supplier:product_history_signal_optional',
 'Q&A Decision: Historical product categories is a weak signal, consider removing',
 'DECISION FROM ARCHITECT REVIEW: Historical product category matching was identified as a weak signal that adds implementation complexity for marginal benefit. A supplier may expand into entirely new product categories at any time, making this signal unreliable. Recommendation: either remove it entirely from the resolution engine, or assign it the lowest possible weight (near zero). It must never drive or confirm a supplier match on its own.'),

('logic:supplier:confidence_formula_explicit',
 'Q&A Decision: Confidence scoring formula must be explicitly defined, not vague',
 'DECISION FROM ARCHITECT REVIEW: "Overall Confidence: High" is not an acceptable output from the resolution engine. The formula must be explicit and consistent. Agreed formula: (1) Exact GSTIN match → 100% confidence, auto-map, no confirmation required. (2) GSTIN unknown + name similarity >= 85% + invoice series match → 75% confidence, show suggestion popup, require accountant confirmation. (3) GSTIN unknown + name similarity >= 85% + no series match → 50% confidence, show suggestion popup, require accountant confirmation. (4) GSTIN unknown + name similarity < 85% → low confidence, do not suggest, ask accountant to search manually or create new. Exact thresholds (85%, 75%, 50%) can be tuned over time but must be documented and consistent.'),

('logic:supplier:merge_split_day_one',
 'Q&A Decision: Merge and Split operations are mandatory from day one',
 'DECISION FROM ARCHITECT REVIEW: The supplier resolution engine will make mistakes. Two correction operations are non-negotiable and must be built from day one — they cannot be deferred. MERGE: when accountant realises two supplier master records are the same business, they merge them into one. All invoices previously linked to both records automatically re-link to the merged record. SPLIT: when accountant realises one supplier master record incorrectly combined two different businesses, they split it and reassign invoices. Without these operations, every resolution mistake becomes permanent and irrecoverable.'),

('logic:supplier:resolution_module_standalone',
 'Q&A Decision: Resolution engine is a standalone module separate from Supplier Master CRUD',
 'DECISION FROM ARCHITECT REVIEW: The supplier identity resolution engine (deciding which supplier an invoice belongs to) must be architecturally separate from the supplier master management screens (creating, editing, deleting supplier records). The resolution engine has its own logging, its own confidence scoring, its own audit trail. It can be improved independently without touching the supplier master UI. This separation also allows the same resolution pattern to be reused for item matching later.'),

('logic:supplier:pan_cross_check',
 'Q&A Decision: PAN number (hidden in GSTIN) used to detect same-entity multi-state registrations',
 'DECISION FROM ARCHITECT REVIEW: Characters 3 to 12 of a GSTIN are the PAN of the business. If two different GSTINs share the same PAN, they represent the same legal entity registered in different states. The system should detect this and flag it to the accountant as a potential same-entity match, even though the GSTINs differ. This is especially relevant for large distributors who supply from multiple state warehouses. Detection of shared PAN does not auto-merge — it surfaces a suggestion to the accountant.'),

('logic:supplier:one_per_gstin_flat_model',
 'Q&A Decision: One supplier master record per GSTIN — flat model, no parent-child',
 'DECISION CONFIRMED BY USER: Each GSTIN gets its own independent supplier master record. A business registered in multiple states (e.g. Delhi and Mumbai) is stored as two separate supplier master records — "Shree Parshwanath Enterprises (Delhi)" and "Shree Parshwanath Enterprises (Mumbai)". This matches how the target accountants already think and record suppliers in their books. It also aligns with GSTR-2B which reconciles at the GSTIN level. No parent-child or entity-group model is needed. Keep it flat: one GSTIN = one supplier master record.'),

('logic:supplier:address_raw_text_optional',
 'Q&A Decision: Store vendor address as raw text, optional, does not flow into exports',
 'DECISION CONFIRMED BY USER: Extract and store vendor address from invoices as a single raw text field on the supplier master. Do not parse into structured sub-fields (street, city, state, PIN). Reasons: Indian address formats are too unstructured, OCR accuracy on multi-line address blocks is poor, and parsed fields would require complex logic with unreliable results. The address is used only as a weak supporting signal in supplier resolution and for accountant reference. It must NOT flow into Excel exports or Tally XML exports. Mark as optional — if OCR cannot read it cleanly, do not block the workflow.'),

('logic:supplier:pin_code_separate_field',
 'Q&A Decision: PIN code extracted as separate field, stronger signal than full address',
 'DECISION CONFIRMED BY USER: Extract the 6-digit PIN code as a separate field from the vendor address, stored independently on the supplier master. PIN codes are significantly easier for OCR to read accurately than full address text (fixed 6-digit numeric format). From a PIN code the state can be derived with 100% accuracy, making it useful as a cross-check against the state derived from the GSTIN first two characters. If GSTIN says Maharashtra state but PIN code resolves to Delhi, this indicates an extraction error and the invoice should be flagged. PIN code is optional — do not block the workflow if unreadable.'),

('logic:supplier:address_is_billing_not_registered',
 'Q&A Decision: Address on invoice is billing/dispatch address, not registered GST address',
 'DECISION FROM ARCHITECT REVIEW: Invoices typically print the billing address or dispatch/warehouse address, not the officially registered GST address. These are often different — a supplier GST-registered in Kanpur may dispatch from a Noida warehouse and print the Noida address on invoices. The address stored in the supplier master must be labelled and understood as "address as printed on invoices" — not treated as the legal or GST-registered address. Accountants must not confuse this field with a compliance field. Do not use it for any official GST reporting.')

ON CONFLICT (key) DO UPDATE
  SET content     = EXCLUDED.content,
      description = EXCLUDED.description,
      updated_at  = NOW();
