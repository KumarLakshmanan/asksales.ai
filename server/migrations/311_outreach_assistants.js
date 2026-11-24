/** Additive and disabled by default. No legacy binding is guessed or activated. */
export async function up(client) {
  await client.query(`
    CREATE TABLE outreach_assistants (
      id uuid PRIMARY KEY, business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id),
      user_id integer NOT NULL REFERENCES users(id), draft jsonb NOT NULL, draft_version integer NOT NULL DEFAULT 1,
      published_revision integer, state varchar(24) NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','live','paused','needs_attention')),
      legacy_config_id integer REFERENCES ai_agent_configs(id), migration_review_required boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(business_profile_id,legacy_config_id)
    );
    CREATE TABLE outreach_assistant_revisions (
      id bigserial PRIMARY KEY, business_profile_id integer NOT NULL DEFAULT app_business_profile_id(), user_id integer NOT NULL,
      assistant_id uuid NOT NULL REFERENCES outreach_assistants(id), revision integer NOT NULL, configuration jsonb NOT NULL,
      checksum varchar(64) NOT NULL, published_by integer NOT NULL REFERENCES users(id), published_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(assistant_id,revision)
    );
    CREATE TABLE outreach_assistant_bindings (
      id bigserial PRIMARY KEY, business_profile_id integer NOT NULL DEFAULT app_business_profile_id(), user_id integer NOT NULL,
      assistant_id uuid NOT NULL REFERENCES outreach_assistants(id), revision integer NOT NULL,
      channel varchar(20) NOT NULL CHECK(channel IN ('whatsapp','instagram','facebook','email','web')),
      surface varchar(20) NOT NULL CHECK(surface IN ('private','public_comment')),
      account_id varchar(255) NOT NULL CHECK(length(account_id)>0), enabled boolean NOT NULL DEFAULT true,
      version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(assistant_id,revision) REFERENCES outreach_assistant_revisions(assistant_id,revision),
      CHECK(surface='private' OR channel IN ('instagram','facebook'))
    );
    CREATE UNIQUE INDEX outreach_assistant_unique_binding ON outreach_assistant_bindings(business_profile_id,channel,surface,account_id) WHERE enabled;
    CREATE TABLE outreach_assistant_audit (
      id bigserial PRIMARY KEY, business_profile_id integer NOT NULL DEFAULT app_business_profile_id(), user_id integer NOT NULL,
      assistant_id uuid NOT NULL REFERENCES outreach_assistants(id), actor_user_id integer NOT NULL REFERENCES users(id),
      action varchar(40) NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE outreach_assistant_away_receipts (
      id bigserial PRIMARY KEY, business_profile_id integer NOT NULL DEFAULT app_business_profile_id(), user_id integer NOT NULL,
      binding_id bigint NOT NULL REFERENCES outreach_assistant_bindings(id), customer_key varchar(64) NOT NULL,
      channel varchar(20) NOT NULL, account_id varchar(255) NOT NULL,
      last_sent_at timestamptz, reserved_until timestamptz, reservation_token uuid,
      UNIQUE(business_profile_id,channel,account_id,customer_key)
    );
    CREATE TABLE outreach_assistant_follow_up_schedules (
      id bigserial PRIMARY KEY, business_profile_id integer NOT NULL DEFAULT app_business_profile_id(), user_id integer NOT NULL,
      conversation_id integer NOT NULL UNIQUE REFERENCES outreach_conversations(id),
      anchor_message_id integer NOT NULL REFERENCES outreach_messages(id),
      binding_id bigint NOT NULL REFERENCES outreach_assistant_bindings(id), assistant_provenance jsonb NOT NULL,
      steps jsonb NOT NULL, next_step integer NOT NULL DEFAULT 0 CHECK(next_step BETWEEN 0 AND 3),
      next_run_at timestamptz NOT NULL, anchor_sent_at timestamptz NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'active' CHECK(status IN ('active','queued','completed','cancelled','uncertain','stopped')),
      version integer NOT NULL DEFAULT 1, cancellation_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX outreach_assistant_follow_up_due ON outreach_assistant_follow_up_schedules(next_run_at) WHERE status IN ('active','queued');
    ALTER TABLE social_follow_up_schedules ADD COLUMN assistant_provenance jsonb;
    ALTER TABLE sent_messages ADD COLUMN smart_reply_assistant jsonb;
    ALTER TABLE tool_approvals ADD COLUMN assistant_provenance jsonb;
    CREATE FUNCTION preserve_outreach_assistant_revision() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Published assistant revisions are immutable; publish a new revision instead' USING ERRCODE='42501';
    END $$;
    CREATE TRIGGER assistant_revision_immutable BEFORE UPDATE OR DELETE ON outreach_assistant_revisions
      FOR EACH ROW EXECUTE FUNCTION preserve_outreach_assistant_revision();
  `);
  for (const [table, parentLinks] of [
    ["outreach_assistants", []],
    [
      "outreach_assistant_revisions",
      [
        {
          parent: "outreach_assistants",
          child_columns: ["assistant_id"],
          parent_columns: ["id"],
        },
      ],
    ],
    [
      "outreach_assistant_bindings",
      [
        {
          parent: "outreach_assistants",
          child_columns: ["assistant_id"],
          parent_columns: ["id"],
        },
      ],
    ],
    [
      "outreach_assistant_audit",
      [
        {
          parent: "outreach_assistants",
          child_columns: ["assistant_id"],
          parent_columns: ["id"],
        },
      ],
    ],
    [
      "outreach_assistant_away_receipts",
      [
        {
          parent: "outreach_assistant_bindings",
          child_columns: ["binding_id"],
          parent_columns: ["id"],
        },
      ],
    ],
    [
      "outreach_assistant_follow_up_schedules",
      [
        {
          parent: "outreach_assistant_bindings",
          child_columns: ["binding_id"],
          parent_columns: ["id"],
        },
        {
          parent: "outreach_conversations",
          child_columns: ["conversation_id"],
          parent_columns: ["id"],
        },
        {
          parent: "outreach_messages",
          child_columns: ["anchor_message_id"],
          parent_columns: ["id"],
        },
      ],
    ],
  ]) {
    const spec = {
      table_name: table,
      owner_column: "user_id",
      global_read: false,
      parent_links: parentLinks,
      legacy_business_column: null,
    };
    await client.query(
      "INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links) VALUES($1,$2,false,$3::jsonb)",
      [table, "user_id", JSON.stringify(parentLinks)],
    );
    const literal = JSON.stringify(spec).replaceAll("'", "''");
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY business_isolation ON ${table} FOR ALL USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));
      CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON ${table} NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO salesmarketing_business_runtime;`);
    if (table !== "outreach_assistants")
      await client.query(
        `GRANT USAGE,SELECT ON SEQUENCE ${table}_id_seq TO salesmarketing_business_runtime`,
      );
  }
}
export async function down(client) {
  // Refuse to erase published configurations/audit history during rollback.
  const { rows } = await client.query(
    "SELECT 1 FROM outreach_assistant_revisions LIMIT 1",
  );
  if (rows.length)
    throw new Error(
      "Disable SUPPORT_ASSISTANTS_ENABLED to roll back routing; published assistant history must be retained.",
    );
  await client.query(`DROP TABLE outreach_assistant_follow_up_schedules,outreach_assistant_away_receipts,outreach_assistant_audit,outreach_assistant_bindings,outreach_assistant_revisions,outreach_assistants;
    DROP FUNCTION preserve_outreach_assistant_revision();
    ALTER TABLE social_follow_up_schedules DROP COLUMN assistant_provenance;
    ALTER TABLE sent_messages DROP COLUMN smart_reply_assistant;
    ALTER TABLE tool_approvals DROP COLUMN assistant_provenance;
    DELETE FROM business_scope_tables WHERE table_name IN ('outreach_assistants','outreach_assistant_revisions','outreach_assistant_bindings','outreach_assistant_audit','outreach_assistant_away_receipts','outreach_assistant_follow_up_schedules');`);
}
