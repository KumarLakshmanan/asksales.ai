/** Keep hourly private-reply reservations efficient as delivery receipts grow. */
export async function up(client) {
  const result = await client.query("SELECT to_regclass('instagram_automation_effects') AS effects");
  if (!result.rows[0].effects) throw new Error('Apply Instagram automation migration 316 before migration 318.');
  await client.query(`CREATE INDEX IF NOT EXISTS instagram_automation_private_budget_idx
    ON instagram_automation_effects(business_profile_id,user_id,created_at,run_id) WHERE effect_key='private'`);
}
export async function down(client) {
  await client.query('DROP INDEX IF EXISTS instagram_automation_private_budget_idx');
}
