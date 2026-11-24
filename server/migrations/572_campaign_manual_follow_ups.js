/** Campaign manual settings are immutable revisions. No legacy campaign is guessed. */
export const irreversible = true;
export async function up(client) {
  await client.query(`
    CREATE TABLE campaign_manual_sequences (
      id bigserial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id),
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id),
      chat_thread_id integer REFERENCES chat_threads(id), outreach_campaign_id integer REFERENCES outreach_campaigns(id),
      channel text NOT NULL CHECK(channel IN ('email','sms','instagram','facebook','whatsapp')),
      version integer NOT NULL CHECK(version>0), updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK(num_nonnulls(chat_thread_id,outreach_campaign_id)=1)
    );
    CREATE UNIQUE INDEX campaign_manual_thread_channel ON campaign_manual_sequences(business_profile_id,chat_thread_id,channel) WHERE chat_thread_id IS NOT NULL;
    CREATE UNIQUE INDEX campaign_manual_outreach_channel ON campaign_manual_sequences(business_profile_id,outreach_campaign_id,channel) WHERE outreach_campaign_id IS NOT NULL;
    CREATE TABLE campaign_manual_sequence_revisions (
      id bigserial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id),
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id(),
      sequence_id bigint NOT NULL REFERENCES campaign_manual_sequences(id), version integer NOT NULL,
      configuration jsonb NOT NULL, checksum text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(sequence_id,version)
    );
    CREATE TABLE campaign_manual_reviews (
      id uuid PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id), business_profile_id integer NOT NULL DEFAULT app_business_profile_id(),
      sequence_id bigint NOT NULL REFERENCES campaign_manual_sequences(id), sequence_version integer NOT NULL,
      snapshot jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(sequence_id,sequence_version) REFERENCES campaign_manual_sequence_revisions(sequence_id,version)
    );
    CREATE FUNCTION preserve_campaign_manual_revision() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Campaign manual revisions and reviews are immutable' USING ERRCODE='42501'; END $$;
    CREATE TRIGGER immutable_campaign_manual_revision BEFORE UPDATE OR DELETE ON campaign_manual_sequence_revisions
      FOR EACH ROW EXECUTE FUNCTION preserve_campaign_manual_revision();
    CREATE TRIGGER immutable_campaign_manual_review BEFORE UPDATE OR DELETE ON campaign_manual_reviews
      FOR EACH ROW EXECUTE FUNCTION preserve_campaign_manual_revision();
  `);
  for (const [table, links] of [
    [
      "campaign_manual_sequences",
      [
        {
          parent: "chat_threads",
          child_columns: ["chat_thread_id"],
          parent_columns: ["id"],
        },
        {
          parent: "outreach_campaigns",
          child_columns: ["outreach_campaign_id"],
          parent_columns: ["id"],
        },
      ],
    ],
    [
      "campaign_manual_sequence_revisions",
      [
        {
          parent: "campaign_manual_sequences",
          child_columns: ["sequence_id"],
          parent_columns: ["id"],
        },
      ],
    ],
    [
      "campaign_manual_reviews",
      [
        {
          parent: "campaign_manual_sequences",
          child_columns: ["sequence_id"],
          parent_columns: ["id"],
        },
      ],
    ],
  ]) {
    const spec = {
      table_name: table,
      owner_column: "user_id",
      global_read: false,
      parent_links: links,
      legacy_business_column: null,
    };
    await client.query(
      "INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links) VALUES($1,$2,false,$3::jsonb)",
      [table, "user_id", JSON.stringify(links)],
    );
    const literal = JSON.stringify(spec).replaceAll("'", "''");
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY business_isolation ON ${table} FOR ALL USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));
      CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON ${table} NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO salesmarketing_business_runtime;`);
    if (table !== "campaign_manual_reviews")
      await client.query(
        `GRANT USAGE,SELECT ON SEQUENCE ${table}_id_seq TO salesmarketing_business_runtime`,
      );
  }
  // Previously prepared global manual content has no immutable campaign revision.
  // Keep provider-started/uncertain work for reconciliation; never infer a campaign.
  const previous = await client.query("SELECT current_setting('app.business_system',true) AS value");
  await client.query("SELECT set_config('app.business_system','on',true)");
  await client.query(`
    UPDATE outreach_messages SET status='manual_review',manual_review_required=true,
    error_message='CAMPAIGN_MANUAL_REVIEW_REQUIRED: Review the campaign and manual sequence before scheduling again.',updated_at=now()
    WHERE message_kind='follow_up' AND status IN ('pending','queued','scheduled')
      AND COALESCE(provider_call_state,'not_started')='not_started'
      AND ((metadata->'configuredFollowUpDispatch'->'payload'->'followUpProvenance'->>'templateId') IS NOT NULL
        OR (metadata->'outreachCreation' IS NOT NULL AND metadata->'outreachCreation'->'campaignManual' IS NULL
          AND COALESCE(metadata->'outreachCreation'->>'followUpSource','')<>'channel_settings'));
    UPDATE social_follow_up_schedules SET status='cancelled',cancellation_reason='campaign_manual_review_required',
      cancelled_at=now(),version=version+1,updated_at=now()
    WHERE status IN ('active','queued') AND EXISTS (SELECT 1 FROM jsonb_array_elements(steps) step WHERE (step->>'templateId')::text ~ '^[1-9][0-9]*$');`);
  await client.query("SELECT set_config('app.business_system',$1,true)", [previous.rows[0]?.value || 'off']);
}
export async function down(client) {
  const { rows } = await client.query(
    "SELECT 1 FROM campaign_manual_sequence_revisions LIMIT 1",
  );
  if (rows.length)
    throw new Error(
      "Retain campaign manual history on rollback. Hold manual delivery and roll forward; never restore global template fallback.",
    );
  await client.query(`DROP TABLE campaign_manual_reviews,campaign_manual_sequence_revisions,campaign_manual_sequences;
    DROP FUNCTION preserve_campaign_manual_revision();
    DELETE FROM business_scope_tables WHERE table_name IN ('campaign_manual_reviews','campaign_manual_sequence_revisions','campaign_manual_sequences');`);
}
