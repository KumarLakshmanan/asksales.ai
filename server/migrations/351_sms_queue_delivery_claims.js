/** Durable SMS attempts retain provider uncertainty; never erase them on rollback. */
export const irreversible = true;
export async function up(client) {
  const { rows } =
    await client.query(`SELECT to_regprocedure('app_business_profile_id()') AS scope,
    to_regprocedure('app_business_access(integer)') AS access,
    to_regprocedure('enforce_business_ownership()') AS guard,
    to_regclass('business_scope_tables') AS manifest`);
  if (Object.values(rows[0]).some((value) => value === null))
    throw new Error(
      "SMS delivery claims require business isolation migrations 299/304.",
    );
  await client.query(`CREATE TABLE IF NOT EXISTS sms_queue_deliveries (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id),
    business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id),
    business_actor_user_id integer NOT NULL, billing_actor_user_id integer NOT NULL, billing_organization_id integer NOT NULL,
    job_id text NOT NULL, payload_hash text NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','preparing','started','confirmed','unknown','stopped','rejected')),
    claim_token uuid, claimed_at timestamptz, reservation_reference text, reservation_id integer,
    provider_message_id text, activity_message_id integer, activity_confirmed_at timestamptz, error text, created_at timestamptz NOT NULL DEFAULT NOW(), updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT sms_queue_deliveries_intent UNIQUE(business_profile_id,user_id,job_id));`);
  const spec = {
    table_name: "sms_queue_deliveries",
    owner_column: "user_id",
    global_read: false,
    parent_links: [
      {
        parent: "sent_messages",
        child_columns: ["activity_message_id"],
        parent_columns: ["id"],
      },
    ],
    legacy_business_column: null,
  };
  await client.query(
    `INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links)
    VALUES('sms_queue_deliveries','user_id',false,$1::jsonb) ON CONFLICT(table_name) DO UPDATE SET parent_links=EXCLUDED.parent_links`,
    [JSON.stringify(spec.parent_links)],
  );
  const literal = JSON.stringify(spec).replaceAll("'", "''");
  await client.query(`ALTER TABLE sms_queue_deliveries ENABLE ROW LEVEL SECURITY; ALTER TABLE sms_queue_deliveries FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS business_isolation ON sms_queue_deliveries;
    CREATE POLICY business_isolation ON sms_queue_deliveries FOR ALL USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));
    DROP TRIGGER IF EXISTS zz_business_ownership ON sms_queue_deliveries;
    CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON sms_queue_deliveries FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
    DROP TRIGGER IF EXISTS business_ownership_guard ON sms_queue_deliveries;
    CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON sms_queue_deliveries NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
    GRANT SELECT,INSERT,UPDATE,DELETE ON sms_queue_deliveries TO salesmarketing_business_runtime;
    GRANT USAGE,SELECT ON SEQUENCE sms_queue_deliveries_id_seq TO salesmarketing_business_runtime;`);
}
export async function down() {
  throw new Error(
    "SMS provider-start and receipt evidence is retained; use a forward migration.",
  );
}
