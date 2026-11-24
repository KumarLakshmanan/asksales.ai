/**
 * Migration 095: Add header_type, header_media_url, and buttons columns to whatsapp_templates
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE whatsapp_templates 
    ADD COLUMN IF NOT EXISTS header_type VARCHAR(20) DEFAULT 'TEXT',
    ADD COLUMN IF NOT EXISTS header_media_url TEXT,
    ADD COLUMN IF NOT EXISTS buttons JSONB;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE whatsapp_templates 
    DROP COLUMN IF EXISTS header_type,
    DROP COLUMN IF EXISTS header_media_url,
    DROP COLUMN IF EXISTS buttons;
  `);
}
