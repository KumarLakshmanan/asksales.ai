export async function up(client) {
  await client.query(`
    ALTER TABLE lead_inputs
    ADD COLUMN IF NOT EXISTS category VARCHAR(255);
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE lead_inputs
    DROP COLUMN IF EXISTS category;
  `);
}
