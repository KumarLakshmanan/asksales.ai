-- PROPOSAL ONLY: execute exclusively inside the isolated benchmark schema.
-- The integration owner must choose a new migration number and review rollout.
-- Match the existing RecipientSuppressionService expression, including legacy
-- lead_name fallback, whitespace trimming, and empty recipient_address handling.
CREATE INDEX benchmark_receipt_destination_idx
  ON sent_messages (
    business_profile_id,
    user_id,
    lower(trim(COALESCE(NULLIF(recipient_address,''),
      CASE WHEN lead_name ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN lead_name END)))
  )
  WHERE channel IN ('email','gmail','resend')
    AND (bounced_at IS NOT NULL OR status IN ('bounced','complained')
      OR delivery_status IN ('bounced','complained'));
