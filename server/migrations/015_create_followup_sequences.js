/**
 * Migration: create_followup_sequences
 * Source: migrations/create_followup_sequences.sql
 * Generated: 2026-03-06T08:18:41.168Z
 */

export async function up(client) {
    // Add FK only if it doesn't already exist (may have been created in initial migration)
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'followup_sequences_user_id_users_id_fk') THEN
        ALTER TABLE "followup_sequences" ADD CONSTRAINT "followup_sequences_user_id_users_id_fk"
        FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
      END IF;
    END $$`);

    await client.query(`CREATE INDEX IF NOT EXISTS "followup_sequences_user_id_idx" ON "followup_sequences" USING btree ("user_id")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "followup_sequences_thread_key_idx" ON "followup_sequences" USING btree ("thread_key")`);

    await client.query(`CREATE INDEX IF NOT EXISTS "followup_sequences_completed_idx" ON "followup_sequences" USING btree ("completed")`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for create_followup_sequences)');
}
