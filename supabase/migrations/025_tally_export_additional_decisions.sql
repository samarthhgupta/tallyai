-- Migration 025: Additional Tally Export Architecture Decisions
-- Fills in details missed in migration 024.

INSERT INTO prompt_rules (key, description, content) VALUES

('logic:export:excel_preview_before_xml',
 'Excel Summary is a verification step before XML generation',
 'The export workflow has two outputs in sequence: (1) Excel Summary — a human-readable spreadsheet showing all mapped fields: supplier name, Tally ledger names, HSN codes, GST amounts, charge ledgers, tax ledgers, line item details. The accountant reviews this to verify mapping is correct before committing to import. Generating the Excel does NOT set Export Status. (2) Tally XML — generated only after accountant is satisfied with the Excel review. This sets Export Status = Exported. The Excel step exists because accountants need to verify mapping correctness before sending to Tally. A wrong mapping that reaches Tally is harder to fix than one caught at the Excel stage.'),

('logic:export:validation_before_export',
 'System validates every selected invoice before generating XML',
 'Before generating any XML, the system runs a full validation pass on every selected invoice. Validation checks per invoice: (1) Supplier has a Tally ledger name configured. (2) All line items have HSN codes (inventory clients). (3) All line items are mapped to stock items or purchase ledgers. (4) All charges have ledger names assigned. (5) All charges have GST treatment assigned. (6) Tax ledgers exist for all applicable GST components. (7) Invoice totals reconcile (taxable + GST = total). Invoices that pass all checks go into the export. Invoices that fail are listed with specific failure reasons.'),

('logic:export:warning_display_before_download',
 'Show full validation summary before download, not after',
 'The validation result must be shown to the accountant BEFORE the XML is generated and downloaded — not as an error after the fact. Format: "Export Summary: 17 invoices ready to export. 3 invoices have issues: Invoice #45 — Supplier has no Tally ledger name. Invoice #67 — Line item missing HSN code. Invoice #89 — Freight charge has no ledger assigned. Export 17 clean invoices?" The accountant then confirms or cancels. This gives them a chance to fix issues before export rather than discovering problems during Tally import.'),

('logic:export:post_export_pending_reminder',
 'After every export, show a prominent reminder of skipped invoices',
 'After XML is generated and downloaded, immediately show: "Export complete. 17 invoices exported successfully. 3 invoices still pending — they were not included in this export. [View Pending Invoices]" The "View Pending Invoices" link opens the Purchase Register pre-filtered to show only the skipped invoices. This prevents the accountant from mentally closing the task when broken invoices are still outstanding. Without this reminder, skipped invoices can silently age in the register for weeks.'),

('logic:export:tally_xml_structure_requirements',
 'Tally XML must include all master definitions alongside voucher entries',
 'The Tally XML import file must be self-contained. It cannot assume that all ledgers and stock items already exist in Tally. The XML must include: (1) LEDGER definitions for every supplier, purchase ledger, expense ledger, and tax ledger referenced in the vouchers. (2) STOCKITEM definitions for every stock item referenced in inventory vouchers. (3) UNIT definitions for every unit of measure used. (4) VOUCHERTYPE definition. (5) VOUCHER entries — one per invoice. If a ledger or stock item already exists in Tally with the same name, Tally will update it. If it does not exist, Tally will create it. This is why exact Tally name matching is critical — a name mismatch creates a duplicate ledger in Tally.'),

('logic:export:tally_name_exact_match_critical',
 'Tally ledger and stock item names must match exactly — no tolerance for variation',
 'When the XML contains a ledger name or stock item name, Tally looks for an exact match in its master data. "Freight Inward A/c" and "Freight Inward Ac" are two different ledgers in Tally. "Input CGST 18%" and "Input CGST @ 18%" are two different ledgers. A name mismatch does not cause an import error — Tally silently creates a new ledger with the slightly different name, polluting the chart of accounts. This is one of the most common and hardest-to-detect errors in Tally imports. The system must store and use the exact Tally name as entered by the accountant, with zero modification, zero trimming of special characters, zero case normalisation.'),

('logic:export:voucher_date_from_invoice',
 'Voucher date in Tally XML comes from invoice date, not export date',
 'The date on the Tally voucher must be the invoice date — the date printed on the supplier invoice — not the date the export was generated. Booking a March invoice with a June date (the export date) would corrupt the accounts for both months. The invoice date determines which accounting period the entry belongs to. If the invoice date falls outside the current financial year, warn the accountant but do not block — some clients legitimately process delayed invoices.'),

('logic:export:round_off_handling',
 'Round off must be handled as a separate ledger entry in the XML',
 'Invoice totals often have small rounding differences (e.g. calculated total = 10,847.32, invoice total = 10,847.00, difference = 0.32). This difference must be booked to a Round Off ledger in Tally — it cannot be silently absorbed into any other ledger. The Round Off ledger name is client-specific and must be configured in the Client Accounting Policy. If the round off difference exceeds a threshold (e.g. > Rs. 5), flag it to the accountant as a potential calculation error rather than rounding.'),

('logic:export:cgst_sgst_vs_igst_determination',
 'CGST+SGST vs IGST is determined at export time from supplier state',
 'The tax split (CGST+SGST for intra-state, IGST for inter-state) is determined by comparing the supplier state code (first 2 digits of supplier GSTIN) with the buyer company state code. This calculation happens at export time, not at extraction time. Reason: the company state may be configured after extraction. The export engine must: (1) Read supplier GSTIN state code. (2) Read company GSTIN state code. (3) If same state → use CGST + SGST ledgers. (4) If different state → use IGST ledger. (5) If supplier is unregistered → apply RCM rules from Client Accounting Policy.'),

('logic:export:export_status_not_editable',
 'Export Status cannot be manually edited by the accountant',
 'Export Status (Not Exported / Exported) is set only by the system when XML is generated. Accountants must not be able to manually mark an invoice as Exported or reset it to Not Exported. Reason: Export Status feeds into future reconciliation. If it can be manually changed, the reconciliation data becomes unreliable. The only way to change Export Status from Not Exported to Exported is to actually generate an XML containing that invoice. Export Count is also system-managed and not manually editable.'),

('logic:export:accounting_only_vs_inventory_xml',
 'Two XML structures: accounting-only voucher and inventory voucher',
 'The Tally XML structure differs based on the client voucher mode configured in Client Accounting Policy: (1) Accounting-only mode: voucher contains LEDGERENTRIES only — debit to purchase ledger, credits to supplier and tax ledgers, no stock item entries. Simpler structure. (2) Inventory mode: voucher contains ALLINVENTORYENTRIES (one per line item with stock item name, qty, rate, UOM, HSN) plus LEDGERENTRIES for charges, taxes, supplier, and purchase ledger. The export engine must check the company voucher mode before generating XML and use the correct structure.')

ON CONFLICT (key) DO UPDATE
  SET content     = EXCLUDED.content,
      description = EXCLUDED.description,
      updated_at  = NOW();
