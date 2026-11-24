/** Keep local WhatsApp drafts distinct from Meta approval and synchronization state. */
export async function up(client) {
  await client.query(`
    ALTER TABLE whatsapp_templates
      ADD COLUMN IF NOT EXISTS examples JSONB,
      ADD COLUMN IF NOT EXISTS meta_status VARCHAR(50),
      ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS has_local_changes BOOLEAN NOT NULL DEFAULT TRUE
  `);

  await client.query(`
    UPDATE whatsapp_templates
    SET
      meta_status = COALESCE(meta_status, status),
      last_synced_at = COALESCE(last_synced_at, updated_at),
      has_local_changes = FALSE
    WHERE waba_template_id IS NOT NULL
      AND meta_status IS NULL
  `);

  // Preserve every historical row while making duplicate-name validation
  // race-safe for future creates and renames.
  await client.query(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id, name ORDER BY id) AS occurrence
      FROM whatsapp_templates
    )
    UPDATE whatsapp_templates AS template
    SET name = LEFT(template.name, 230) || '_duplicate_' || template.id
    FROM ranked
    WHERE ranked.id = template.id
      AND ranked.occurrence > 1
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_templates_owner_name_uq
      ON whatsapp_templates(user_id, name)
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS whatsapp_templates_owner_name_uq;
    ALTER TABLE whatsapp_templates
      DROP COLUMN IF EXISTS has_local_changes,
      DROP COLUMN IF EXISTS last_synced_at,
      DROP COLUMN IF EXISTS meta_status,
      DROP COLUMN IF EXISTS examples
  `);
}
