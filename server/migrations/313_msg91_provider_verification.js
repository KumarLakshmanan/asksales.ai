/** Allow MSG91 in the existing immutable provider verification audit. */
export async function up(client) {
  await client.query(`
    ALTER TABLE provider_verification_runs
      DROP CONSTRAINT IF EXISTS provider_verification_runs_platform_check;
    ALTER TABLE provider_verification_runs
      ADD CONSTRAINT provider_verification_runs_platform_check
      CHECK (platform IN ('facebook','instagram','whatsapp','meta_ads','google_ads','youtube','gmail','resend','msg91'));
    CREATE UNIQUE INDEX IF NOT EXISTS msg91_delivery_receipt_uq
      ON webhook_events (business_profile_id, user_id, (payload->>'receiptKey'))
      WHERE platform = 'msg91' AND payload ? 'receiptKey';
  `);
}

export async function down(client) {
  // Keep existing immutable audit evidence. NOT VALID applies the old allowlist
  // to new writes without deleting MSG91 history or disabling audit protection.
  await client.query(`
    DROP INDEX IF EXISTS msg91_delivery_receipt_uq;
    ALTER TABLE provider_verification_runs
      DROP CONSTRAINT IF EXISTS provider_verification_runs_platform_check;
    ALTER TABLE provider_verification_runs
      ADD CONSTRAINT provider_verification_runs_platform_check
      CHECK (platform IN ('facebook','instagram','whatsapp','meta_ads','google_ads','youtube','gmail','resend')) NOT VALID;
  `);
}
