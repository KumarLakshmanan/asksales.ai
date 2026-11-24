// Each outreach workflow keeps the Brand Toolkit it was created with.
// Before this, every outreach/follow-up email re-read the business's *current*
// default toolkit at send time, so changing the default (or picking another
// brand for content) rebranded ongoing campaigns.
//
// Additive and idempotent: nullable columns, a same-business ownership guard,
// and a backfill that only fills NULLs. NULL keeps the previous behaviour
// (current default brand), so rollback is safe.

const TABLES = ['outreach_conversations', 'outreach_campaigns'];

export async function up(client) {
  for (const table of TABLES) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS brand_toolkit_id integer`);
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${table}_brand_toolkit_id_fk') THEN
        ALTER TABLE ${table} ADD CONSTRAINT ${table}_brand_toolkit_id_fk
          FOREIGN KEY (brand_toolkit_id) REFERENCES brand_toolkits(id) ON DELETE SET NULL;
      END IF;
    END $$`);
  }

  // A plain FK bypasses RLS. Reject a toolkit from another owner or business.
  // Named zzz_ so it runs after zz_business_ownership has filled business_profile_id.
  await client.query(`CREATE OR REPLACE FUNCTION enforce_workflow_brand_toolkit_owner() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.brand_toolkit_id IS NULL THEN RETURN NEW; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM brand_toolkits t
      WHERE t.id = NEW.brand_toolkit_id AND t.user_id = NEW.user_id
        AND t.business_profile_id IS NOT DISTINCT FROM NEW.business_profile_id
    ) THEN
      RAISE EXCEPTION 'Brand Toolkit is not available in this business' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END $$`);
  for (const table of TABLES) {
    await client.query(`DROP TRIGGER IF EXISTS zzz_brand_toolkit_owner ON ${table}`);
    await client.query(`CREATE TRIGGER zzz_brand_toolkit_owner
      BEFORE INSERT OR UPDATE OF brand_toolkit_id ON ${table}
      FOR EACH ROW EXECUTE FUNCTION enforce_workflow_brand_toolkit_owner()`);
  }

  // Backfill existing workflows (NULLs only) so a later default change cannot
  // rebrand them. Trusted migration context, as in 571/572.
  const previous = await client.query("SELECT current_setting('app.business_system',true) AS value");
  await client.query("SELECT set_config('app.business_system','on',true)");
  // Batched so no single statement approaches the runner's statement timeout;
  // every batch only touches rows it can fill, so each loop always finishes.
  const BATCH = 2000;
  const drain = async (statement) => {
    for (;;) {
      const result = await client.query(statement, [BATCH]);
      if (!result.rowCount) return;
    }
  };

  // 1. Email conversations launched from a chat thread that had a brand selected.
  await drain(`
    UPDATE outreach_conversations c SET brand_toolkit_id = picked.toolkit_id
    FROM (
      SELECT DISTINCT ON (m.conversation_id) m.conversation_id, t.id AS toolkit_id
      FROM outreach_messages m
      JOIN outreach_conversations oc ON oc.id = m.conversation_id
      JOIN chat_threads th
        ON th.id = CASE WHEN (m.metadata->'outreachCreation'->'delivery'->>'threadId') ~ '^[1-9][0-9]{0,9}$'
          THEN (m.metadata->'outreachCreation'->'delivery'->>'threadId')::bigint END
       AND th.user_id = oc.user_id
      JOIN brand_toolkits t
        ON t.id = CASE WHEN (th.metadata->>'selectedBrandToolkitId') ~ '^[1-9][0-9]{0,9}$'
          THEN (th.metadata->>'selectedBrandToolkitId')::bigint END
       AND t.user_id = oc.user_id
       AND t.business_profile_id IS NOT DISTINCT FROM oc.business_profile_id
       AND t.is_active = true
      WHERE oc.brand_toolkit_id IS NULL AND oc.channel IN ('email','gmail')
      ORDER BY m.conversation_id, m.id
      LIMIT $1
    ) picked
    WHERE c.id = picked.conversation_id AND c.brand_toolkit_id IS NULL`);

  // 2. Remaining email conversations and campaigns: snapshot the brand in
  //    effect for their business today (its active default).
  const defaultFor = (alias) => `SELECT t.id FROM brand_toolkits t
    WHERE t.user_id = ${alias}.user_id
      AND t.business_profile_id IS NOT DISTINCT FROM ${alias}.business_profile_id
      AND t.is_active = true
    ORDER BY t.is_default DESC, t.created_at DESC
    LIMIT 1`;
  for (const [table, channelFilter] of [
    ['outreach_conversations', "AND p.channel IN ('email','gmail')"],
    ['outreach_campaigns', ''],
  ]) {
    await drain(`
      UPDATE ${table} w SET brand_toolkit_id = (${defaultFor('w')})
      WHERE w.id IN (
        SELECT p.id FROM ${table} p
        WHERE p.brand_toolkit_id IS NULL ${channelFilter} AND EXISTS (${defaultFor('p')})
        ORDER BY p.id
        LIMIT $1)`);
  }
  await client.query("SELECT set_config('app.business_system',$1,true)", [previous.rows[0]?.value || 'off']);
}

export async function down(client) {
  for (const table of TABLES) {
    await client.query(`DROP TRIGGER IF EXISTS zzz_brand_toolkit_owner ON ${table}`);
    await client.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS brand_toolkit_id`);
  }
  await client.query('DROP FUNCTION IF EXISTS enforce_workflow_brand_toolkit_owner()');
}
