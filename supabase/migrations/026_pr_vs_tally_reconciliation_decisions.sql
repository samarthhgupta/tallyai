-- Migration 026: Purchase Register vs Tally Reconciliation Architecture Decisions (Q6)

INSERT INTO prompt_rules (key, description, content) VALUES

('logic:reco:current_manual_process',
 'Current manual reconciliation process — the pain point being replaced',
 'Currently Tally IS the purchase register. Accountants maintain a physical invoice file. At month end, the accountant sits with the physical invoice file and opens Tally to check each voucher one by one — "Is this invoice in Tally? Yes. Next." This is purely manual, purely visual, one person, one screen, one pile of paper. Entire month checked invoice by invoice. Missing vouchers, wrong amounts, and duplicate entries are frequently missed. TallyAI replaces this with an automated comparison that reduces month-end reconciliation from half a day to 10 minutes.'),

('logic:reco:tally_data_input_method',
 'Tally data comes from accountant-uploaded export file (Option A)',
 'Phase 4 reconciliation uses Option A: accountant exports the Purchase Register report from Tally (Tally has a built-in Purchase Register report), saves it as Excel, and uploads it to TallyAI. TallyAI then matches it against its own Purchase Register. No direct Tally integration required. Option B (direct Tally connection via XML request/response mechanism) is deferred to a later phase — it requires Tally to be running on the same network and adds significant integration complexity. Validate the concept with Option A first.'),

('logic:reco:match_criteria',
 'Reconciliation matches on Invoice Number + Supplier + Amount (Option C)',
 'To determine whether an invoice in TallyAI is the same as a voucher in Tally, all three must match: (1) Invoice Number — exact match. (2) Supplier name — matched against the Tally ledger name. (3) Amount — total invoice amount must match. Invoice numbers alone can collide across suppliers. Amount mismatch is one of the most common and dangerous errors. All three together give near-certain identity. This is the tightest and most reliable matching strategy.'),

('logic:reco:six_reconciliation_outcomes',
 'Six possible reconciliation outcomes for each invoice',
 'Every invoice in TallyAI gets one of six statuses after reconciliation:
1. Matched — found in Tally, supplier matches, amount matches. All good.
2. Missing in Tally — invoice is in TallyAI register but not found in Tally at all. Either never imported or import failed silently.
3. Amount Mismatch — invoice found in Tally (same number + supplier) but amount differs. Could be manual entry error in Tally or wrong amount in XML.
4. Supplier Mismatch — invoice number found in Tally but under a different supplier name. Could be wrong ledger in Tally or naming mismatch.
5. Duplicate in Tally — same invoice appears more than once in Tally. Imported twice. Silently inflates purchases and ITC.
6. Extra in Tally — voucher exists in Tally but has no matching invoice in TallyAI register. Could be a manually entered voucher or a deleted invoice that was already imported.'),

('logic:reco:reconciliation_is_computation_not_filter',
 'Reconciliation is a computation that runs once, filtering happens after',
 'Reconciliation and filtering are two separate operations. Reconciliation = a computation that runs once on a defined period and produces a complete result set. Filtering = how the accountant explores that result set after it is computed. The accountant should never pre-filter before reconciliation. Run reconciliation on full data first, then let the accountant apply filters to the result on the dashboard. This ensures: (1) The reconciliation result is a complete saved snapshot. (2) Multiple people can view the same result and filter differently. (3) Exports accurately reflect what is on screen. (4) No risk of accidentally excluding something by pre-filtering.'),

('logic:reco:post_reco_dashboard_filters',
 'Filters available on reconciliation dashboard after results are computed',
 'Once reconciliation is complete, the accountant can apply these filters to the results on the dashboard: (1) Supplier filter — show only specific supplier. (2) Discrepancy type filter — show only specific outcome types (Matched, Missing, Mismatch etc). (3) Amount threshold filter — show only mismatches where difference exceeds a set value (eliminates rounding noise). (4) GSTIN filter. (5) Voucher type filter. (6) Ledger filter. Filters 4-6 are Phase 5+ territory — build 1-3 first. Filters apply to the display only — they do not re-run the reconciliation.'),

('logic:reco:exportable_reconciliation_report',
 'Reconciliation results are exportable as Excel with category selection',
 'The accountant can export reconciliation results to Excel. Before export, show a checkbox selection of which categories to include: Matched, Missing in Tally, Amount Mismatch, Supplier Mismatch, Duplicate in Tally, Extra in Tally. Default: all checked. The export produces: (1) Sheet 1 — Summary: total counts per category, reconciliation period, date run. (2) One sheet per selected category with full invoice detail. The export respects active dashboard filters — if the accountant has filtered to one supplier, the export contains only that supplier''s data. This allows exporting full results OR only the filtered view.'),

('logic:reco:reconciliation_period_selection',
 'Reconciliation period selection hierarchy — Financial Year first',
 'Period selection follows a strict hierarchy that mirrors how accountants think: Step 1 — Select Company. Step 2 — Select Financial Year (mandatory, no cross-year reconciliation allowed). Step 3 — Select period via Month Range OR Quarter shortcut. Step 4 — Optional Custom Date Range override (must stay within selected FY). The hierarchy is Company → Financial Year → Month/Quarter → Optional Custom Dates. This same hierarchy must be used as a reusable platform-wide component across Purchase Register, Tally Reconciliation, GSTR-2B Reconciliation, GST modules, and all future reports.'),

('logic:reco:financial_year_as_primary_anchor',
 'Financial Year is the mandatory primary anchor for all reconciliation',
 'All reconciliation must happen within a single financial year. Cross-financial-year reconciliation is not allowed. Reason: accounting records, GST compliance, audits, and Tally itself are organised around financial years. The only edge case — a late invoice from March posted in April of the next year — is handled by the invoice date field, not by cross-year reconciliation. Once a Financial Year is selected, all subsequent month and quarter dropdowns automatically adjust to show only months/quarters within that FY.'),

('logic:reco:quarter_as_shortcut',
 'Quarter selection is a shortcut that populates the underlying date range',
 'Quarter is not a separate mode — it is a preset shortcut. Selecting Q1 automatically fills From Date = 01-Apr and To Date = 30-Jun. Quarter dropdown options: Q1 (Apr-Jun), Q2 (Jul-Sep), Q3 (Oct-Dec), Q4 (Jan-Mar), Full Year (Apr-Mar). Full Year is the 5th item in the Quarter dropdown, not a separate control. Month Range and Quarter both populate the same underlying From Date / To Date fields. Custom Date Range is simply the same date fields edited manually. One source of truth: the date range. Multiple ways to populate it quickly.'),

('logic:reco:financial_year_dropdown_logic',
 'Financial Year dropdown drives all subsequent period controls',
 'When FY 2025-26 is selected, month dropdown shows April-25 through March-26. When FY 2026-27 is selected, month dropdown shows April-26 through March-27. Quarter date definitions adjust automatically: Q1 = Apr 1 to Jun 30 of the selected FY start year, Q2 = Jul 1 to Sep 30, Q3 = Oct 1 to Dec 31, Q4 = Jan 1 to Mar 31 of the selected FY end year. This same FY-driven date logic must be reused identically across all platform modules.'),

('logic:reco:additional_filters_post_computation',
 'Three filters to build first on reconciliation dashboard',
 'Build these three filters first on the reconciliation results dashboard: (1) Supplier filter — useful when a specific supplier account is under dispute. (2) Discrepancy type filter — already covered by export checkbox but should also work as a live screen filter. (3) Amount threshold filter — show only mismatches where difference exceeds X rupees. This eliminates noise from tiny rounding differences that accountants do not care about. GSTIN, voucher type, and ledger filters are useful but defer to Phase 5+.')

ON CONFLICT (key) DO UPDATE
  SET content     = EXCLUDED.content,
      description = EXCLUDED.description,
      updated_at  = NOW();
