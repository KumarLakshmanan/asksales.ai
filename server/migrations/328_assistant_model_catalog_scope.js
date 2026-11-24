/** The model catalog is shared admin configuration, with its own RLS policies. */
export async function up(client) {
  await client.query(`INSERT INTO business_scope_accounts(table_name)
    VALUES('assistant_model_catalog') ON CONFLICT DO NOTHING`);
}

export async function down(client) {
  await client.query("DELETE FROM business_scope_accounts WHERE table_name='assistant_model_catalog'");
}
