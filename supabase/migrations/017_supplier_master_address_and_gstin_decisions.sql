-- Migration 017: Supplier Master — address storage and multi-GSTIN decisions

INSERT INTO prompt_rules (key, description, content) VALUES

('logic:supplier:one_master_per_gstin',
 'Architecture decision: one supplier master record per GSTIN',
 'Each GSTIN gets its own independent supplier master record. A business with registrations in multiple states (e.g. Delhi and Mumbai) is stored as two separate supplier master records: "Shree Parshwanath Enterprises (Delhi)" and "Shree Parshwanath Enterprises (Mumbai)". This matches how the target accountants already think and record suppliers. It also aligns with how GSTR-2B works — reconciliation happens at the GSTIN level, not at the business entity level. Do not implement a parent-child supplier model. Keep it flat: one GSTIN = one supplier master record.'),

('logic:supplier:address_storage',
 'Vendor address — store as raw text, do not parse into structured fields',
 'Store the vendor address extracted from invoices as a single raw text field on the supplier master. Do not attempt to parse it into separate fields (street, area, city, state, PIN). Address formats in India are too unstructured and OCR accuracy on multi-line address blocks is poor. The address field is informational and used as a weak supporting signal in supplier identity resolution. It does not need to flow into any Excel or XML export file. Mark it as optional — if OCR cannot read it clearly, do not block the workflow.'),

('logic:supplier:pin_code_extraction',
 'PIN code — extract separately, higher value than full address',
 'Extract the 6-digit PIN code as a separate field from the vendor address. PIN codes are easier for OCR to read reliably than full address text. From a PIN code, the state can be derived with 100% accuracy. This makes PIN code more useful than full address for: (1) cross-checking the state derived from GSTIN, (2) flagging mismatches (GSTIN says Maharashtra, PIN code resolves to Delhi = extraction error). Store PIN code as its own field on the supplier master, separate from the raw address text. Mark it as optional.'),

('logic:supplier:address_as_matching_signal',
 'Address is a weak supporting signal in supplier resolution, PIN code is stronger',
 'In the supplier identity resolution engine, vendor address is a low-weight supporting signal. It adds value when GSTIN is unclear and name similarity is borderline — if a known address string appears on a new invoice, it increases confidence slightly. However, full address text matching is unreliable due to OCR variation. PIN code is a stronger sub-signal within address matching because it is a fixed 6-digit number that OCR reads more accurately. When scoring supplier resolution confidence, weight full address match low and PIN code match moderate.'),

('logic:supplier:billing_vs_registered_address',
 'Address on invoice is billing/shipping address, not registered GST address',
 'Invoices typically print the billing address or dispatch/warehouse address, not the officially registered GST address. These are often different — a supplier registered in Kanpur may dispatch from Noida and print the Noida warehouse address on invoices. The address stored in the supplier master should be understood as "address as printed on their invoices" and not treated as their official compliance address. This distinction is important so accountants do not confuse it for a legal or GST-registered address field.')

ON CONFLICT (key) DO UPDATE
  SET content     = EXCLUDED.content,
      description = EXCLUDED.description,
      updated_at  = NOW();
