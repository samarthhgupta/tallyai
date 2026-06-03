-- Migration 015: Insert codebase & system learnings into prompt_rules
-- These are project-level learnings from the TallyAI dashboard development session.
-- Stored as individual rows so they can be retrieved, updated, or referenced independently.

INSERT INTO prompt_rules (key, description, content) VALUES

-- ── Supabase / Database ──────────────────────────────────────────────────────

('learning:supabase:postgrest_error_not_instanceof',
 'Supabase error handling pattern',
 'PostgrestError objects returned by the Supabase JS SDK are NOT instanceof Error. Doing `err instanceof Error ? err.message : "fallback"` always falls through to the fallback string, hiding the real error. Fix: always wrap Supabase errors as `throw new Error(error.message + (error.details ? " — " + error.details : ""))` before throwing.'),

('learning:supabase:rls_policy_pattern',
 'RLS policy pattern for this project',
 'All queries on invoices and related tables require the row''s company_id to be owned by the current user: `company_id IN (SELECT id FROM companies WHERE created_by = auth.uid())`. Queries that omit this context silently return 0 rows or fail with an RLS violation — they do not throw an obvious error.'),

('learning:supabase:selecting_nonexistent_column_crashes_query',
 'Selecting a non-existent column crashes the entire query',
 'If a column does not exist in the DB and is referenced in a .select("..., col_name") call, Supabase throws an error for the entire query — not just that field. Remove non-existent columns from SELECT before the migration that adds them is applied.'),

('learning:supabase:migration_failure_leaves_partial_schema',
 'Failed migrations leave the schema in a partial state',
 'If a GitHub Actions migration job fails (red ❌), none of the SQL in that file is applied. All runtime code referencing those columns must be made safe (columns removed from reads/writes) before the migration reruns. Do not assume a migration ran just because the file exists.'),

('learning:supabase:add_column_if_not_exists',
 'Use ADD COLUMN IF NOT EXISTS for safe re-run migrations',
 'When re-creating a failed migration, use `ALTER TABLE t ADD COLUMN IF NOT EXISTS col_name type` so the migration is idempotent and safe to apply even if it was partially applied before.'),

('learning:supabase:fk_to_auth_users_on_delete_set_null',
 'Foreign key to auth.users should use ON DELETE SET NULL',
 'When adding a column that references auth.users(id), always use ON DELETE SET NULL — not ON DELETE CASCADE. Cascading from auth.users would delete business data (invoices, records) when a user account is removed.'),

-- ── Git / GitHub Actions ─────────────────────────────────────────────────────

('learning:git:checkout_theirs_means_take_origin',
 'git checkout --theirs discards local changes',
 'During `git merge origin/main`, `--theirs` means "take the incoming branch version" (origin/main), which DISCARDS local changes. `--ours` keeps the local version. Using `--theirs` on a file with new local UI changes silently throws away the new code. Always manually resolve conflicts to preserve intended changes.'),

('learning:git:deploy_only_triggers_on_main',
 'GitHub Actions deploy only triggers on push to main',
 'The GitHub Pages deploy workflow only runs on push to main. Changes on a feature branch do nothing until merged. Always confirm the merge completed and the Actions job turned green before reporting changes as deployed.'),

('learning:git:migration_job_separate_from_deploy',
 'Migration job is separate from the frontend deploy job',
 'There are two independent GitHub Actions workflows: deploy.yml (Next.js → GitHub Pages) and migrate.yml (Supabase CLI migrations). Both trigger on push to main but can fail independently. A green deploy does not mean migrations ran successfully.'),

('learning:git:two_github_actions_jobs',
 'Two GitHub Actions jobs: deploy and migrate',
 'deploy.yml builds the Next.js static export and pushes to GitHub Pages. migrate.yml runs Supabase migrations using SUPABASE_ACCESS_TOKEN secret and the Supabase CLI. Check both jobs after every push to main.'),

-- ── Next.js / Frontend ───────────────────────────────────────────────────────

('learning:nextjs:static_export_for_github_pages',
 'Next.js static export — all DB calls are client-side',
 'The app uses `output: "export"` in next.config.js and deploys to GitHub Pages. There is no server-side rendering. All Supabase calls are made client-side via the Supabase JS SDK. No API routes or server actions are available.'),

('learning:nextjs:useref_click_outside_tooltip',
 'useRef pattern for click-outside tooltip detection',
 'To close a tooltip when the user clicks outside it: attach a ref to the tooltip container element, add a mousedown listener on document, and close if `!ref.current.contains(e.target)`. Clean up the listener in the useEffect return function.'),

('learning:nextjs:supabase_db_helper_pattern',
 'Supabase JS SDK db() helper pattern',
 'The app wraps createClient(url, key) in a db() helper function so the Supabase client is initialised once and reused across all DB calls in lib/db.ts. All database operations import and call db() rather than creating their own client.'),

-- ── UI / UX Patterns ─────────────────────────────────────────────────────────

('learning:ui:gstin_font_mono',
 'GSTINs and alphanumeric IDs should use font-mono font-medium',
 'Render GSTINs and similar alphanumeric identifiers with Tailwind classes `text-sm font-medium font-mono text-gray-600`. This makes them readable at a glance. Avoid tiny grey micro-text which makes them hard to scan.'),

('learning:ui:confidence_reasons_regex_parsing',
 'Parsing confidence_reasons strings into a breakdown table',
 'confidence_reasons[] contains strings in the format "Field: XX%". Parse each string with the regex `r.match(/^(.+?):\\s*(\\d+%?)$/)` to split into label and value. Render as a table inside a tooltip. Show "✓ All key fields verified" if all scores are high.'),

('learning:ui:sticky_header_detail_panel',
 'Sticky header pattern for invoice detail panels',
 'Use `position: sticky; top: 0; z-index: 10` on the header bar inside a detail panel so that Invoice No., Confidence score, and Total remain visible while the user scrolls through line items. Split into three sections: left (identity), center (scores), right (total + close).'),

('learning:ui:table_layout_for_line_items',
 'Table layout is better than card-per-row for line items',
 'Line items in invoice detail should use a proper <table> with fixed column widths and minWidth: "860px" on the container. Card-per-row layouts are harder to scan when comparing values across many rows. Column widths: Description min-200px, HSN 112px, GST% 64px, Qty 80px, UOM 64px, Rate 96px, Disc% 80px, Taxable 96px.'),

('learning:ui:collapsible_sections_chevron',
 'Collapsible sections with rotating chevron',
 'Wrap each panel section in a component that toggles open state. Rotate the chevron icon 180deg (transform: rotate(180deg)) when the section is closed. This reduces scroll distance in dense panels. Default all sections to open on first load.'),

('learning:ui:live_hsn_summary_reconciliation',
 'Live HSN Summary and Live Reconciliation during editing',
 'In edit mode, recompute HSN Summary and Reconciliation totals on every onChange of any line item field. This gives the user real-time feedback without saving. The Round Off field lives inside the Reconciliation section, not in the Invoice Header.'),

('learning:ui:type_to_confirm_destructive_action',
 'Type-to-confirm pattern for destructive actions',
 'For "Delete All" or similarly destructive bulk operations, require the user to type the company name exactly (case-insensitive) before enabling the confirm button. Disable the button with `disabled={inputValue.trim().toLowerCase() !== companyName.toLowerCase()}`. Reset the input when the modal opens or is cancelled.'),

('learning:ui:pulsing_dot_edit_mode_indicator',
 'Pulsing dot to indicate active edit mode',
 'Show a small `animate-pulse` indigo dot with the label "Editing" in the panel header when the user has unsaved changes. This provides clear visual feedback that a save is pending without blocking the UI.'),

-- ── Security ─────────────────────────────────────────────────────────────────

('learning:security:service_role_key_never_commit',
 'Supabase service role key must never be committed',
 'The SUPABASE_SERVICE_ROLE_KEY is stored in .claude/settings.local.json which is gitignored. Never commit .env, .env.local, .env.production, config.env, or any file containing the service role key or other secrets. The key grants full DB bypass of RLS and must stay out of version control.')

ON CONFLICT (key) DO UPDATE
  SET content     = EXCLUDED.content,
      description = EXCLUDED.description,
      updated_at  = NOW();
