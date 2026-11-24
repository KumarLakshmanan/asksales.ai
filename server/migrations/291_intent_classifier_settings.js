export async function up(client) {
  await client.query(`ALTER TABLE platform_settings
    ADD COLUMN IF NOT EXISTS intent_classifier_provider varchar(50) NOT NULL DEFAULT 'openrouter',
    ADD COLUMN IF NOT EXISTS intent_classifier_model text NOT NULL DEFAULT 'typesafe/jev-1.13'`);
}

export async function down(client) {
  await client.query(`ALTER TABLE platform_settings
    DROP COLUMN IF EXISTS intent_classifier_provider,
    DROP COLUMN IF EXISTS intent_classifier_model`);
}
