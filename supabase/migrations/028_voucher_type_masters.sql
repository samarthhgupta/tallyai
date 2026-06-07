-- Voucher Type Masters
-- Maps purchase categories (gst, non_gst, default) to exact Tally Voucher Type names.
-- Used in XML export to populate VOUCHERTYPENAME per invoice.

CREATE TABLE IF NOT EXISTS voucher_type_masters (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by              uuid REFERENCES auth.users(id),
  purchase_category       text NOT NULL CHECK (purchase_category IN ('gst', 'non_gst', 'default')),
  tally_voucher_type_name text NOT NULL,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now(),

  UNIQUE (company_id, purchase_category)
);

ALTER TABLE voucher_type_masters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage voucher_type_masters for their companies"
  ON voucher_type_masters
  FOR ALL
  TO authenticated
  USING (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid()
    )
  );
