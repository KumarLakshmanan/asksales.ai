export async function up(client) {
  await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS crm_configuration jsonb;`);
}

export async function down(client) {
  await client.query(`ALTER TABLE company_settings DROP COLUMN IF EXISTS crm_configuration;`);
}
