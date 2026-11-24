/** Add Meta Ads to the durable, secret-free provider verification evidence. */
export async function up(client) {
  await client.query(`
    ALTER TABLE provider_verification_runs
      DROP CONSTRAINT IF EXISTS provider_verification_runs_platform_check;
    ALTER TABLE provider_verification_runs
      ADD CONSTRAINT provider_verification_runs_platform_check
      CHECK (platform IN ('facebook','instagram','whatsapp','meta_ads','youtube','gmail','resend'));
  `);
}

export async function down(client) {
  await client.query(`
    DELETE FROM provider_verification_runs WHERE platform = 'meta_ads';
    ALTER TABLE provider_verification_runs
      DROP CONSTRAINT IF EXISTS provider_verification_runs_platform_check;
    ALTER TABLE provider_verification_runs
      ADD CONSTRAINT provider_verification_runs_platform_check
      CHECK (platform IN ('facebook','instagram','whatsapp','youtube','gmail','resend'));
  `);
}
