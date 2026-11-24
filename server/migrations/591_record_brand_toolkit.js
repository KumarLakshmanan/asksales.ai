// Proposals and support tickets keep the Brand Toolkit they were created with.
// Before this, proposal emails, the public proposal page, support replies and
// ticket close/review emails re-read the business's *current* default toolkit,
// so changing the default rebranded proposals and tickets already in progress.
//
// Additive and idempotent: nullable columns, the same-owner/same-business guard
// from 589, and a NULL-only batched backfill. NULL keeps the previous behaviour
// (current default brand), so rollback is safe.
//
// Backfill order (first active, same-owner, same-business toolkit wins):
//   support_tickets: its outreach conversation's brand (filled by 589),
//                    then its chat thread's selected brand, then today's default.
//   proposals:       its outreach conversation's brand, then its support
//                    ticket's brand (metadata.supportTicketId), then its chat
//                    thread's selected brand, then today's default.

const TABLES = ['support_tickets', 'proposals'];

export async function up(client) {
  for (const table of TABLES) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS brand_toolkit_id integer`);
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${table}_brand_toolkit_id_fk') THEN
        ALTER TABLE ${table} ADD CONSTRAINT ${table}_brand_toolkit_id_fk
          FOREIGN KEY (brand_toolkit_id) REFERENCES brand_toolkits(id) ON DELETE SET NULL;
      END IF;
    END $$`);
    // enforce_workflow_brand_toolkit_owner() is owned by migration 589.
    // Named zzz_ so it runs after zz_business_ownership has filled business_profile_id.
    await client.query(`DROP TRIGGER IF EXISTS zzz_brand_toolkit_owner ON ${table}`);
    await client.query(`CREATE TRIGGER zzz_brand_toolkit_owner
      BEFORE INSERT OR UPDATE OF brand_toolkit_id ON ${table}
      FOR EACH ROW EXECUTE FUNCTION enforce_workflow_brand_toolkit_owner()`);
  }

  // Trusted migration context, as in 589.
  const previous = await client.query("SELECT current_setting('app.business_system',true) AS value");
  await client.query("SELECT set_config('app.business_system','on',true)");
  const BATCH = 2000;
  const drain = async (statement) => {
    for (;;) {
      const result = await client.query(statement, [BATCH]);
      if (!result.rowCount) return;
    }
  };
  const positiveId = (expression) => `CASE WHEN (${expression}) ~ '^[1-9][0-9]{0,9}$' THEN (${expression})::bigint END`;
  // Fill rows whose candidate toolkit (an expression over alias p) is active
  // and belongs to the same owner and business. Rows without one stay NULL for
  // the next step.
  const fill = (table, candidate, joins = '') => drain(`
    UPDATE ${table} w SET brand_toolkit_id = picked.toolkit_id
    FROM (
      SELECT p.id, t.id AS toolkit_id
      FROM ${table} p
      ${joins}
      JOIN brand_toolkits t
        ON t.id = (${candidate})
       AND t.user_id = p.user_id
       AND t.business_profile_id IS NOT DISTINCT FROM p.business_profile_id
       AND t.is_active = true
      WHERE p.brand_toolkit_id IS NULL
      ORDER BY p.id
      LIMIT $1
    ) picked
    WHERE w.id = picked.id AND w.brand_toolkit_id IS NULL`);
  const fromConversation = ['c.brand_toolkit_id', 'JOIN outreach_conversations c ON c.id = p.outreach_conversation_id AND c.user_id = p.user_id'];
  const fromThread = [positiveId("th.metadata->>'selectedBrandToolkitId'"), 'JOIN chat_threads th ON th.id = p.chat_thread_id AND th.user_id = p.user_id'];
  const defaultFor = (alias) => `(SELECT d.id FROM brand_toolkits d
    WHERE d.user_id = ${alias}.user_id
      AND d.business_profile_id IS NOT DISTINCT FROM ${alias}.business_profile_id
      AND d.is_active = true
    ORDER BY d.is_default DESC, d.created_at DESC
    LIMIT 1)`;

  // Tickets first: proposals can inherit a ticket's brand.
  await fill('support_tickets', ...fromConversation);
  await fill('support_tickets', ...fromThread);
  await fill('support_tickets', defaultFor('p'));

  await fill('proposals', ...fromConversation);
  await fill('proposals', 's.brand_toolkit_id', `JOIN support_tickets s
    ON s.id = ${positiveId("p.metadata->>'supportTicketId'")} AND s.user_id = p.user_id`);
  await fill('proposals', ...fromThread);
  await fill('proposals', defaultFor('p'));

  await client.query("SELECT set_config('app.business_system',$1,true)", [previous.rows[0]?.value || 'off']);
}

export async function down(client) {
  for (const table of TABLES) {
    await client.query(`DROP TRIGGER IF EXISTS zzz_brand_toolkit_owner ON ${table}`);
    await client.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS brand_toolkit_id`);
  }
  // enforce_workflow_brand_toolkit_owner() stays: migration 589 owns it.
}
