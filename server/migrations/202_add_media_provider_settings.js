/**
 * Add tenant-selectable image and video generation provider/model defaults.
 * Existing users remain on the current Google Gemini / Vertex behavior.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE ai_settings
      ADD COLUMN IF NOT EXISTS image_provider VARCHAR(50) DEFAULT 'google',
      ADD COLUMN IF NOT EXISTS image_model TEXT DEFAULT 'gemini-2.5-flash-image',
      ADD COLUMN IF NOT EXISTS video_provider VARCHAR(50) DEFAULT 'google',
      ADD COLUMN IF NOT EXISTS video_model TEXT DEFAULT 'veo-3.1-fast-generate-001';

    UPDATE ai_settings
    SET image_provider = COALESCE(NULLIF(image_provider, ''), 'google'),
        image_model = COALESCE(NULLIF(image_model, ''), 'gemini-2.5-flash-image'),
        video_provider = COALESCE(NULLIF(video_provider, ''), 'google'),
        video_model = COALESCE(NULLIF(video_model, ''), 'veo-3.1-fast-generate-001');
  `);
}
export async function down(client) {
  await client.query(`
    ALTER TABLE ai_settings
      DROP COLUMN IF EXISTS video_model,
      DROP COLUMN IF EXISTS video_provider,
      DROP COLUMN IF EXISTS image_model,
      DROP COLUMN IF EXISTS image_provider;
  `);
}
