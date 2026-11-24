/** A report occurrence gets one durable ledger reservation across worker replicas/retries. */
export async function up(client) {
  await client.query(`ALTER TABLE social_report_deliveries ADD COLUMN IF NOT EXISTS delivery_key VARCHAR(255)`);
  await client.query(`UPDATE social_report_deliveries SET delivery_key = 'legacy:' || id::text WHERE delivery_key IS NULL`);
  await client.query(`ALTER TABLE social_report_deliveries ALTER COLUMN delivery_key SET NOT NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS social_report_delivery_occurrence_uq ON social_report_deliveries(report_id, delivery_key)`);
}
export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS social_report_delivery_occurrence_uq`);
  await client.query(`ALTER TABLE social_report_deliveries DROP COLUMN IF EXISTS delivery_key`);
}
