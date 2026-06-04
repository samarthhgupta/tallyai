-- Migration 024: Tally Export Architecture Decisions
-- Q5 of the product architecture Q&A session.

INSERT INTO prompt_rules (key, description, content) VALUES

('logic:export:batch_vs_invoice_export',
 'Export is batch-based with invoice-level checkbox selection',
 'The accountant selects any number of invoices from the Purchase Register using checkboxes (one per invoice + Select All in header) and exports them together. The generated XML contains only the selected invoices. There is no concept of a fixed batch size — the accountant decides: 1 invoice, 5 invoices, 100 invoices. The Purchase Register is the only place exports happen from.'),

('logic:export:only_accepted_invoices_in_register',
 'Purchase Register contains only accepted invoices — no pending concept at export stage',
 'By the time invoices reach the Purchase Register, they are already accepted. Pending invoices have not yet been reviewed. Rejected invoices live in the Rejected Archive or are permanently deleted. Therefore export operates only on accepted invoices. There is no need to handle pending invoices at the export stage.'),

('logic:export:export_clean_skip_broken',
 'Export Clean, Skip Broken — core export philosophy',
 'When the accountant selects N invoices for export, the system validates each one. Invoices that pass all checks are exported. Invoices that fail are skipped with a clear reason shown. Example: 20 selected, 17 clean, 3 have issues → export 17, skip 3, show exactly which 3 failed and why. One broken invoice must never block 99 clean ones. After export, show a prominent reminder: "3 invoices still pending — view them" with a direct filter link to the skipped invoices.'),

('logic:export:xml_triggers_export_status',
 'Only XML generation triggers Export Status = Exported, not Excel preview',
 'There are two export outputs: (1) Excel Summary — human-readable mapping verification for the accountant to review before importing. Generating this does NOT change Export Status. (2) Tally XML — the actual import file. Generating this sets Export Status = Exported. The Excel step is a verification step. The XML step is the actual export intent. Exported does NOT mean Successfully Imported Into Tally — it only means XML was generated.'),

('logic:export:invoice_export_tracking_fields',
 'Export tracking is invoice-centric, not batch-centric',
 'For every invoice in the Purchase Register, store: export_status (Not Exported / Exported), exported_at (date + time), exported_by (user name), export_count (integer, starts at 0). Export Count is the most important field — Export Count > 1 means the invoice was exported multiple times, which is a red flag for potential Tally duplicates. Show Export Count >= 2 visually highlighted in the UI. No Export Batch Master, no Export Batch Screen, no XML Archive Management needed at this stage.'),

('logic:export:no_export_batch_entity',
 'No Export Batch entity at this stage',
 'Batch-centric tracking answers "what was in Export #47?" — nobody asks that question. Invoice-centric tracking answers "has this invoice gone to Tally?" — that is the real question. Export Batch Masters, Export Batch Screens, and XML Archive Management introduce complexity without solving a real accounting problem. Defer batch architecture unless real-world testing proves it is genuinely needed.'),

('logic:export:exported_ne_imported',
 'Exported does not equal Imported Into Tally',
 'A critical distinction: Export Status = Exported means only that the XML was generated. It does NOT mean the XML was imported, imported successfully, or that every invoice reached Tally. The accountant may generate the XML and import it immediately, import it tomorrow, forget to import it, import it and receive errors, or successfully import only some invoices. The real solution to "did this invoice reach Tally?" is the future Purchase Register vs Tally Reconciliation module, not export tracking.'),

('logic:export:purchase_register_export_ui',
 'Purchase Register UI additions for export',
 'Add to Purchase Register: (1) Checkbox per invoice row + Select All checkbox in header. (2) Export Status column showing Not Exported / Exported. (3) Filters: Show All, Show Only Exported, Show Only Not Exported. (4) Export Selected Invoices button showing count of selected invoices. These are practical filters accountants will actually use daily.'),

('logic:export:filename_format',
 'System-generated filename, no customisation needed',
 'XML filename format: Purchase_[CompanyName]_[YYYYMMDD]_[HHMMSS].xml. Example: Purchase_KapraKothiEmporium_20260605_113245.xml. This is unique, human-readable, easy to search, and prevents accidental overwriting of files. No custom filename inputs, no naming convention settings. Accountants care about whether the XML imports correctly, not what it is named. Timestamp to the second ensures multiple exports on the same day do not overwrite each other.'),

('logic:export:company_level_hard_blocks',
 'Company-level hard blocks — export cannot happen without these',
 'Five company-level requirements that hard-block all exports: (1) Company selected — no target to export to. (2) Tally company name configured — XML header is invalid without it. (3) Financial year selected — every voucher needs a date context. (4) Ledger master available — cannot map anything without it. (5) Voucher type configured — Tally needs to know this is a Purchase voucher at the XML root level. These are company-level requirements. If any are missing, block all exports with a clear message explaining what needs to be configured.'),

('logic:export:invoice_level_soft_blocks',
 'Invoice-level soft blocks — block only the affected invoice, not the entire export',
 'Invoice-level issues block only the specific invoice, not the entire export. Examples: missing supplier mapping, missing stock item mapping, missing charge ledger mapping, missing tax ledger mapping, validation errors. Supplier Masters and Stock Item Masters are invoice-level requirements — if Invoice #4 is missing a supplier mapping, block Invoice #4 only. The other 99 invoices are unaffected. Never make per-invoice master data gaps into company-level hard blocks.'),

('logic:export:re_export_warning',
 'Warn before re-exporting an already exported invoice',
 'If an accountant selects an invoice that already has Export Status = Exported and attempts to export again, show a clear warning: "This invoice has already been exported on [date] at [time]. Exporting again may create a duplicate entry in Tally. Are you sure?" This is not a block — the accountant may legitimately need to re-export after fixing a mistake. But the warning must be explicit. The Export Count field tracks how many times each invoice has been exported.'),

('logic:export:export_readiness_checklist',
 'Export Readiness Checklist — the north star question',
 'Every invoice must pass an Export Readiness Checklist before being included in an export. Checklist items: Supplier Mapped, Stock Items Mapped (inventory clients), Charges Mapped, Tax Ledgers Mapped, Validation Passed, Company Configured. The guiding question for every checklist item is NOT "will Tally technically accept this?" but "would a competent accountant be comfortable posting this entry?" Tally may accept incomplete or poorly structured entries that later cause reconciliation, inventory, GST, or audit issues. The platform must hold a higher standard than Tally''s minimum technical requirements.'),

('logic:export:client_config_mandatory_on_first_export',
 'Client Configuration Questionnaire must be completed before first export',
 'For the first export ever for a company: hard block with message "Complete company configuration before first export." For subsequent exports: warn if configuration is incomplete but do not block — the accountant already knows their setup. The first export is the moment the accountant is most focused on setup. After that, blocking becomes friction without accounting benefit.'),

('logic:export:future_reconciliation_connection',
 'Export tracking connects to future PR vs Tally Reconciliation',
 'Export Status is a weak signal — it means XML was generated. The future Purchase Register vs Tally Reconciliation module will provide the strong signal — it will tell us: Missing in Tally, Found in Tally, Duplicate in Tally. When reconciliation is built, every invoice gets a second status field: tally_status (NULL for now, filled by reconciliation later). Design the DB schema today with a placeholder tally_status column so Phase 4 fills an existing column rather than requiring a schema change. At that point, export_status becomes historical context and tally_status becomes the ground truth.')

ON CONFLICT (key) DO UPDATE
  SET content     = EXCLUDED.content,
      description = EXCLUDED.description,
      updated_at  = NOW();
