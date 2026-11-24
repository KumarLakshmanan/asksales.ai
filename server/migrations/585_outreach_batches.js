/**
 * Outreach message tracking. Each launch from the outreach composer gets a
 * durable record, and every message it creates points back to it, so delivery
 * can be reported per outreach, per template and per day.
 *
 * This migration only changes catalogs: a new table, three nullable columns
 * and two small triggers. The indexes on outreach_messages are built without
 * blocking writes in 586.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE outreach_batches (
      id uuid PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      name varchar(200) NOT NULL,
      channel varchar(20) NOT NULL,
      provider_account_id varchar(255),
      template_name varchar(512),
      template_language varchar(20),
      scheduled_at timestamptz,
      source varchar(24) NOT NULL CHECK(source IN('new_outreach','prepared','assistant','legacy_inferred','legacy_prepared')),
      prepared_outreach_id uuid,
      request_fingerprint varchar(64) NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'admitting' CHECK(status IN('admitting','queued','interrupted')),
      requested_count integer NOT NULL,
      admitted_count integer NOT NULL DEFAULT 0,
      skipped_count integer NOT NULL DEFAULT 0,
      skipped_reasons jsonb NOT NULL DEFAULT '{}',
      -- Whether the channel reports delivery and read receipts at all.
      receipt_support varchar(8) NOT NULL DEFAULT 'full' CHECK(receipt_support IN('full','partial','none')),
      expires_at timestamptz,
      -- Counts by delivery state, kept by a background job so pages never count every message on load.
      counts jsonb,
      follow_up_counts jsonb,
      next_attempt_at timestamptz,
      last_activity_at timestamptz,
      counts_at timestamptz,
      counts_dirty boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(business_profile_id,user_id,request_fingerprint),
      UNIQUE(business_profile_id,user_id,id)
    );
    CREATE INDEX outreach_batches_recent_idx ON outreach_batches(business_profile_id,user_id,created_at DESC,id DESC);
    CREATE INDEX outreach_batches_dirty_idx ON outreach_batches(counts_at) WHERE counts_dirty;
    CREATE INDEX outreach_batches_admitting_idx ON outreach_batches(updated_at) WHERE status='admitting';

    ALTER TABLE outreach_messages
      ADD COLUMN batch_id uuid,
      ADD COLUMN template_name varchar(512),
      ADD COLUMN template_language varchar(20),
      ADD CONSTRAINT outreach_messages_batch_owner_fk
        FOREIGN KEY (business_profile_id,user_id,batch_id)
        REFERENCES outreach_batches(business_profile_id,user_id,id) ON DELETE SET NULL (batch_id);
  `);
  const table = 'outreach_batches';
  const spec = { table_name: table, owner_column: 'user_id', global_read: false, parent_links: [], legacy_business_column: null };
  await client.query('INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links) VALUES($1,$2,false,$3::jsonb)', [table, 'user_id', '[]']);
  const literal = JSON.stringify(spec).replaceAll("'", "''");
  await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY business_isolation ON ${table} FOR ALL USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));
    CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
    CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON ${table} NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
    GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO salesmarketing_business_runtime;`);

  // A message changing state marks its outreach for a recount. It only writes
  // when the flag actually flips, so a busy outreach is not one hot row, and it
  // swallows its own errors: tracking must never stop a message being saved.
  await client.query(`
    CREATE FUNCTION outreach_batch_counts_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE outreach_batches SET counts_dirty=true WHERE id=NEW.batch_id AND NOT counts_dirty;
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END $$;
    CREATE TRIGGER outreach_batch_counts_dirty_insert AFTER INSERT ON outreach_messages
      FOR EACH ROW WHEN (NEW.batch_id IS NOT NULL) EXECUTE FUNCTION outreach_batch_counts_dirty();
    CREATE TRIGGER outreach_batch_counts_dirty_update AFTER UPDATE ON outreach_messages
      FOR EACH ROW WHEN (NEW.batch_id IS NOT NULL AND (
        OLD.batch_id IS DISTINCT FROM NEW.batch_id OR OLD.status IS DISTINCT FROM NEW.status
        OR OLD.sent_at IS DISTINCT FROM NEW.sent_at OR OLD.delivered_at IS DISTINCT FROM NEW.delivered_at
        OR OLD.read_at IS DISTINCT FROM NEW.read_at OR OLD.failed_at IS DISTINCT FROM NEW.failed_at
        OR OLD.manual_review_required IS DISTINCT FROM NEW.manual_review_required
        OR OLD.metadata->'outreachQueue' IS DISTINCT FROM NEW.metadata->'outreachQueue'
        OR OLD.metadata->>'scheduledAt' IS DISTINCT FROM NEW.metadata->>'scheduledAt'))
      EXECUTE FUNCTION outreach_batch_counts_dirty();
  `);
}

export async function down(client) {
  await client.query(`
    DROP TRIGGER IF EXISTS outreach_batch_counts_dirty_insert ON outreach_messages;
    DROP TRIGGER IF EXISTS outreach_batch_counts_dirty_update ON outreach_messages;
    DROP FUNCTION IF EXISTS outreach_batch_counts_dirty();
    ALTER TABLE outreach_messages DROP COLUMN batch_id, DROP COLUMN template_name, DROP COLUMN template_language;
    DROP TABLE outreach_batches;
    DELETE FROM business_scope_tables WHERE table_name='outreach_batches';
  `);
}
