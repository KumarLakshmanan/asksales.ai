/**
 * Persist generated outreach sequences with explicit tenant ownership.
 * Campaigns reference these records from outreach_campaigns.settings.sequenceId.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS outreach_sequences (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      icp_id INTEGER REFERENCES icp_profiles(id) ON DELETE SET NULL,
      sequence_type VARCHAR(20) NOT NULL CHECK (sequence_type IN ('email', 'sms')),
      campaign_name VARCHAR(255) NOT NULL,
      total_steps INTEGER NOT NULL CHECK (total_steps > 0),
      steps JSONB NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  // Earlier request-time fallback code could have created a legacy version of
  // this table without tenant ownership or updated_at. Reconcile it in place.
  await client.query(`ALTER TABLE outreach_sequences ADD COLUMN IF NOT EXISTS user_id INTEGER`);
  await client.query(`ALTER TABLE outreach_sequences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`);
  await client.query(`ALTER TABLE outreach_sequences ALTER COLUMN icp_id DROP NOT NULL`);
  await client.query(`
    UPDATE outreach_sequences os
    SET user_id = ip.user_id
    FROM icp_profiles ip
    WHERE os.user_id IS NULL AND os.icp_id = ip.id
  `);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'outreach_sequences_user_id_users_id_fk'
      ) THEN
        ALTER TABLE outreach_sequences
          ADD CONSTRAINT outreach_sequences_user_id_users_id_fk
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      END IF;
    END $$
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS outreach_sequences_user_id_idx
    ON outreach_sequences(user_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS outreach_sequences_user_icp_idx
    ON outreach_sequences(user_id, icp_id)
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS outreach_sequences');
}
