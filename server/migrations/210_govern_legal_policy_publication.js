/** Add version and counsel-approval gates to public legal policies. */
export async function up(client) {
  await client.query(`ALTER TABLE policy_pages ADD COLUMN IF NOT EXISTS legal_version VARCHAR(40) NOT NULL DEFAULT '1.0-draft'`);
  await client.query(`ALTER TABLE policy_pages ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'draft'`);
  await client.query(`ALTER TABLE policy_pages ADD COLUMN IF NOT EXISTS counsel_approved_at TIMESTAMP`);
  await client.query(`ALTER TABLE policy_pages ADD COLUMN IF NOT EXISTS counsel_approved_by VARCHAR(255)`);
  await client.query(`ALTER TABLE policy_pages ADD COLUMN IF NOT EXISTS effective_at TIMESTAMP`);
  await client.query(`
    UPDATE policy_pages
    SET published = FALSE,
        approval_status = 'draft',
        legal_version = '2.0-draft',
        updated_at = NOW()
    WHERE slug = 'privacy-policy'
      AND content_markdown LIKE '%We respect your privacy and process your data responsibly.%'
  `);
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_pages_approval_status_check') THEN
        ALTER TABLE policy_pages ADD CONSTRAINT policy_pages_approval_status_check
          CHECK (approval_status IN ('draft', 'legal_review', 'approved', 'published', 'retired'));
      END IF;
    END $$
  `);
}

export async function down(client) {
  await client.query(`ALTER TABLE policy_pages DROP CONSTRAINT IF EXISTS policy_pages_approval_status_check`);
  await client.query(`ALTER TABLE policy_pages DROP COLUMN IF EXISTS effective_at`);
  await client.query(`ALTER TABLE policy_pages DROP COLUMN IF EXISTS counsel_approved_by`);
  await client.query(`ALTER TABLE policy_pages DROP COLUMN IF EXISTS counsel_approved_at`);
  await client.query(`ALTER TABLE policy_pages DROP COLUMN IF EXISTS approval_status`);
  await client.query(`ALTER TABLE policy_pages DROP COLUMN IF EXISTS legal_version`);
}
