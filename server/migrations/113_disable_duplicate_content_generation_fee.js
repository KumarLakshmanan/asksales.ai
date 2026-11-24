/**
 * Content generation is already billed from measured provider usage. Disable
 * the legacy fixed per-piece fee to avoid charging the same generation twice.
 */
export async function up(client) {
  await client.query(`
    UPDATE credit_pricing
    SET is_active = FALSE, updated_at = NOW()
    WHERE event_key = 'content_generation'
  `);
}

export async function down(client) {
  await client.query(`
    UPDATE credit_pricing
    SET is_active = TRUE, updated_at = NOW()
    WHERE event_key = 'content_generation'
  `);
}
