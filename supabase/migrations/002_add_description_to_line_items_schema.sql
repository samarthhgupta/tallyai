-- Add 'description' field to line_items schema in the live system prompt.
-- This is a targeted string replacement — only the schema block is changed.

UPDATE prompt_rules
SET
  content = replace(
    content,
    '"hsn": string (HSN or SAC code),',
    '"description": string (product or service name exactly as printed in the line items table),
      "hsn": string (HSN or SAC code),'
  ),
  updated_at = NOW()
WHERE key = 'system_prompt';
