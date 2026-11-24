/** Draft recovery metadata and bounded revision history stay on the existing
 * table. This migration does not replace the tenancy/RLS prerequisites from
 * migrations 299/304; legacy local databases can receive these columns safely. */
export async function up(client) {
  await client.query(`ALTER TABLE whatsapp_templates
    ADD COLUMN IF NOT EXISTS variable_labels jsonb,
    ADD COLUMN IF NOT EXISTS auth_config jsonb,
    ADD COLUMN IF NOT EXISTS activity_history jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS approved_snapshot jsonb,
    ADD COLUMN IF NOT EXISTS submitted_snapshot jsonb;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_attribute
        WHERE attrelid='whatsapp_templates'::regclass
          AND attname='business_profile_id' AND NOT attisdropped) THEN
        CREATE INDEX IF NOT EXISTS whatsapp_templates_workspace_updated_idx
          ON whatsapp_templates(business_profile_id,user_id,updated_at DESC,id DESC);
      ELSE
        CREATE INDEX IF NOT EXISTS whatsapp_templates_owner_updated_idx
          ON whatsapp_templates(user_id,updated_at DESC,id DESC);
      END IF;
    END $$;`);
}
export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS whatsapp_templates_workspace_updated_idx;
    DROP INDEX IF EXISTS whatsapp_templates_owner_updated_idx;
    ALTER TABLE whatsapp_templates DROP COLUMN IF EXISTS variable_labels,
      DROP COLUMN IF EXISTS auth_config, DROP COLUMN IF EXISTS activity_history,
      DROP COLUMN IF EXISTS approved_snapshot, DROP COLUMN IF EXISTS submitted_snapshot;`);
}
