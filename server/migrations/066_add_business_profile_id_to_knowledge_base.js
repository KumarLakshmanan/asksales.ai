/**
 * Migration: add_business_profile_id_to_knowledge_base
 * Adds business_profile_id FK to knowledge_base table for multi-profile support.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE knowledge_base
    ADD COLUMN IF NOT EXISTS business_profile_id INTEGER
    REFERENCES company_settings(id) ON DELETE SET NULL
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_base_business_profile_id
    ON knowledge_base(business_profile_id)
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_knowledge_base_business_profile_id`);
  await client.query(`ALTER TABLE knowledge_base DROP COLUMN IF EXISTS business_profile_id`);
}
