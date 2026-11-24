export async function up(client) {
  await client.query(`ALTER TABLE social_publish_attempts DROP CONSTRAINT social_publish_attempts_platform_check;
    ALTER TABLE social_publish_attempts ADD CONSTRAINT social_publish_attempts_platform_check
      CHECK (platform IN ('instagram','facebook','youtube','linkedin'))`);
}

export async function down(client) {
  const retained = await client.query("SELECT 1 FROM social_publish_attempts WHERE platform='linkedin' LIMIT 1");
  if (retained.rows.length) throw new Error('LinkedIn publication history exists; retain its receipts and use a forward migration.');
  await client.query(`ALTER TABLE social_publish_attempts DROP CONSTRAINT social_publish_attempts_platform_check;
    ALTER TABLE social_publish_attempts ADD CONSTRAINT social_publish_attempts_platform_check
      CHECK (platform IN ('instagram','facebook','youtube'))`);
}
