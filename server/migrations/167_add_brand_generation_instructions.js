/**
 * Persist explicit brand rules that every content and media generation can use.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE brand_toolkits
      ADD COLUMN IF NOT EXISTS content_instructions TEXT,
      ADD COLUMN IF NOT EXISTS visual_instructions TEXT,
      ADD COLUMN IF NOT EXISTS logo_usage_guidelines TEXT
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE brand_toolkits
      DROP COLUMN IF EXISTS logo_usage_guidelines,
      DROP COLUMN IF EXISTS visual_instructions,
      DROP COLUMN IF EXISTS content_instructions
  `);
}
