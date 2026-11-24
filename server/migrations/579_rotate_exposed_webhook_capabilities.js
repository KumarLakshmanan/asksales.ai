export async function up(client) {
  const previous = await client.query("SELECT current_setting('app.business_system',true) AS value");
  await client.query("SELECT set_config('app.business_system','on',true)");
  // Ordinary members could previously retrieve these durable capabilities.
  await client.query(`UPDATE users SET webhook_token_nonce=replace(gen_random_uuid()::text,'-','') ||
    replace(gen_random_uuid()::text,'-',''), updated_at=NOW()`);
  await client.query(`UPDATE channel_credentials SET legacy_webhook_token_hash=NULL, updated_at=NOW()
    WHERE platform='whatsapp' AND legacy_webhook_token_hash IS NOT NULL`);
  await client.query("SELECT set_config('app.business_system',$1,true)", [previous.rows[0]?.value || 'off']);
}

export const irreversible = true;
