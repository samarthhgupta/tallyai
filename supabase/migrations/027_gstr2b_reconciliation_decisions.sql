-- Migration 027: GSTR-2B Reconciliation Architecture Decisions (Q7)

INSERT INTO prompt_rules (key, description, content) VALUES

('logic:gstr2b:data_input_method',
 'GSTR-2B data enters via accountant-uploaded Excel or JSON file (Phase 1)',
 'Phase 1 uses manual upload: accountant downloads GSTR-2B Excel or JSON from the GST Portal and uploads it into TallyAI. No API integration in Phase 1. Future phases will fetch GSTR-2B automatically via GST Portal APIs or Tally APIs, but Phase 1 must not be designed around APIs. Flow: GST Portal → Download GSTR-2B → Upload into TallyAI. Always use GSTR-2B (locked, period-specific) as the authoritative source, never GSTR-2A (real-time, changes as suppliers file). Accountants who confuse the two and use GSTR-2A for ITC claims face compliance risk — flag this distinction in the UI.'),

('logic:gstr2b:reconciliation_direction',
 'Reconciliation is bidirectional — both Books-missing-in-2B and 2B-missing-in-Books',
 'GSTR-2B reconciliation must check both directions. Scenario A: Purchase exists in Books but not in GSTR-2B — possible causes: supplier has not filed GSTR-1, filed incorrectly, uploaded wrong GSTIN, invoice is fake or cancelled, data entry error. Action: vendor follow-up required. Scenario B: GSTR-2B entry exists but not in Books — possible causes: accountant missed booking, invoice never received, purchase omitted, supplier uploaded incorrect invoice. Action: book purchase entry or investigate.'),

('logic:gstr2b:long_term_architecture',
 'Long-term reconciliation is Books (Tally) vs GSTR-2B, not Purchase Register vs GSTR-2B',
 'The Purchase Register is an intermediate staging area. Once data reaches Tally, Tally becomes the official accounting record and the source of GST filing. The correct long-term architecture is: Purchase Register → Export to Tally → Books (Tally) → Books vs GSTR-2B Reconciliation → GSTR-3B Preparation. Phase 1 uses Purchase Register as a proxy for books. The reconciliation module must be designed for Books vs GSTR-2B from day one so the data model and matching logic do not need rewriting when Tally integration arrives in Phase 3.'),

('logic:gstr2b:seven_reconciliation_categories',
 'Seven reconciliation outcome categories for GSTR-2B matching',
 'Every invoice gets one of seven reconciliation statuses:
1. Fully Matched — Books=Yes, 2B=Yes, ITC=Claimed. No action needed.
2. Missing in 2B — Books=Yes, 2B=No. Supplier has not filed or filed incorrectly. Action: vendor follow-up required.
3. Missing in Books — Books=No, 2B=Yes. Accountant missed booking. Action: book purchase entry required.
4. Review ITC Treatment — Present in both Books and 2B, but ITC not claimed despite being eligible. Action: review whether ITC should be claimed or kept as unclaimed.
5. Value Mismatch — Present in both, but amounts differ (e.g. Books=₹1,00,000 vs 2B=₹1,05,000). Could be amendment or data entry error. Action: investigate and correct.
6. GSTIN Mismatch — Invoice in both Books and 2B, but supplier GSTIN in books differs from GSTR-2B. ITC is GSTIN-linked so a typo means the credit will not match. Action: correct the GSTIN in books.
7. Duplicate in 2B — Same invoice appears more than once in GSTR-2B (supplier filed twice). ITC would be double-counted if claimed both times. Action: claim only once, flag for audit trail.'),

('logic:gstr2b:itc_not_claimed_handling',
 'Intentionally unclaimed ITC treatment in reconciliation — deferred to real data phase',
 'Some invoices are intentionally booked with unclaimed GST (GST absorbed into item cost instead of Input GST account). The reconciliation must not treat intentional unclaimed ITC as an error. The correct treatment depends on ITC status: if status is not_applicable or potentially_ineligible, show as ITC Not Claimed (Intentional) with no action required. If status is eligible but not claimed, show as Review ITC Treatment with action required. Full handling logic will be defined when reconciliation is built with real data. The Client Accounting Policy Engine will eventually govern this per supplier and industry.'),

('logic:gstr2b:matching_signals',
 'Matching hierarchy: GSTIN + Invoice Number primary, with Amount and Date as validation',
 'Matching priority: (1) GSTIN + Invoice Number — primary signal, handles ~90% of cases. (2) + Amount — secondary validation; same invoice number but different amount likely means an amendment was filed. (3) + Invoice Date — tertiary; catches backdated invoices filed in the wrong period. (4) GSTIN + Amount + Date with no invoice number — fallback for cases where supplier filed without invoice number. Critical edge case: amendments (B2BA records in GSTR-1). When a supplier files an amendment, the original invoice appears as cancelled and a new amended entry appears. The engine must understand B2BA records — otherwise it creates false Missing in 2B for the original and false Missing in Books for the amended entry.'),

('logic:gstr2b:section_17_5_blocked_credits',
 'Section 17(5) blocked ITC must be identified during reconciliation, not at GSTR-3B time',
 'Invoices for blocked credit categories under Section 17(5) — cars, food, club memberships, personal use items — must be flagged during GSTR-2B reconciliation as ITC Blocked - Section 17(5). The accountant must know not to claim these in Table 4D of GSTR-3B. Identifying blocked credits at reconciliation time prevents errors at filing time. The blocked credit determination will eventually be governed by the Client Accounting Policy Engine.'),

('logic:gstr2b:rule_42_43_reversal_tagging',
 'Invoices subject to Rule 42/43 ITC reversal must be tagged during reconciliation',
 'Businesses with both taxable and exempt supplies must partially reverse ITC under Rule 42 (inputs) and Rule 43 (capital goods). The actual reversal calculation happens in the GSTR-3B preparation module, not in reconciliation. However, the reconciliation module must tag invoices that may be subject to reversal so the GSTR-3B module can pick them up. Reconciliation tags the invoice; GSTR-3B calculates the reversal amount.'),

('logic:gstr2b:dashboard_summary_first',
 'Reconciliation dashboard shows summary counts before invoice-level detail',
 'The GSTR-2B reconciliation dashboard must display a summary panel first: Total Invoices in Books, Matched, Missing in Books, Missing in 2B, ITC Not Claimed, Value Mismatch, GSTIN Mismatch, Duplicate in 2B. This immediately tells the accountant where action is required before they scroll into invoice-level details. Same export model as PR vs Tally reconciliation: export respects active filters, category checkboxes before export.')

ON CONFLICT (key) DO UPDATE
  SET content     = EXCLUDED.content,
      description = EXCLUDED.description,
      updated_at  = NOW();
