/**
 * Migration: add_image_video_margin_pricing
 * Adds image_margin and video_margin rows to api_pricing table for margin-based
 * billing (like LLM margin) instead of fixed credits per image/video.
 */

export async function up(client) {
  // Add image_margin row (similar to llm_margin)
  await client.query(`
    INSERT INTO api_pricing (category, pricing_key, name, provider, margin_percentage, unit_label, sort_order)
    VALUES ('image_generation', 'image_margin', 'Image Generation Margin', 'gemini', 0, '% margin on model cost', 99)
    ON CONFLICT (pricing_key) DO NOTHING
  `);

  // Add video_margin row (similar to llm_margin)
  await client.query(`
    INSERT INTO api_pricing (category, pricing_key, name, provider, margin_percentage, unit_label, sort_order)
    VALUES ('video_generation', 'video_margin', 'Video Generation Margin', 'gemini', 0, '% margin on model cost', 100)
    ON CONFLICT (pricing_key) DO NOTHING
  `);
}

export async function down(client) {
  await client.query(`DELETE FROM api_pricing WHERE pricing_key IN ('image_margin', 'video_margin')`);
}
