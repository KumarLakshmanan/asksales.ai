/** Durable dashboard/agent work, staged contact previews and snapshot downloads. */
export async function up(client) {
  await client.query(`
    CREATE TABLE dashboard_operation_inputs (
      id uuid PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      hash varchar(64) NOT NULL,
      bytes bytea NOT NULL CHECK(octet_length(bytes)>0),
      storage_reservation_id uuid,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(business_profile_id,user_id,hash)
    );
    CREATE TABLE dashboard_operations (
      id uuid PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      parent_id uuid REFERENCES dashboard_operations(id),
      kind text NOT NULL CHECK(kind IN('contact_analysis','contact_import','campaign_export','campaign_prepare','queue_retry')),
      status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','ready','completed','failed','review','cancelled')),
      request_key varchar(100) NOT NULL,
      fingerprint varchar(64) NOT NULL,
      origin jsonb NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}',
      result jsonb,
      processed integer NOT NULL DEFAULT 0,
      total integer NOT NULL DEFAULT 0,
      cursor integer NOT NULL DEFAULT 0,
      generation integer NOT NULL DEFAULT 0,
      lease_token uuid,
      lease_until timestamptz,
      error text,
      artifact_input_id uuid REFERENCES dashboard_operation_inputs(id),
      artifact_name text,
      artifact_type text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
      purged_at timestamptz,
      UNIQUE(business_profile_id,user_id,request_key)
    );
    CREATE INDEX dashboard_operation_recent_idx ON dashboard_operations(business_profile_id,user_id,created_at DESC);
    CREATE INDEX dashboard_operation_recovery_idx ON dashboard_operations(status,lease_until,updated_at) WHERE status IN('queued','running');
    CREATE TABLE dashboard_operation_files (
      id uuid PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      operation_id uuid NOT NULL REFERENCES dashboard_operations(id) ON DELETE CASCADE,
      name varchar(500) NOT NULL,
      hash varchar(64) NOT NULL,
      ordinal integer NOT NULL,
      input_id uuid NOT NULL REFERENCES dashboard_operation_inputs(id),
      UNIQUE(operation_id,ordinal)
    );
    CREATE TABLE dashboard_contact_rows (
      id bigserial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      operation_id uuid NOT NULL REFERENCES dashboard_operations(id) ON DELETE CASCADE,
      row_key text NOT NULL,
      ordinal integer NOT NULL,
      status text NOT NULL CHECK(status IN('ready','review','invalid','duplicate','excluded')),
      data jsonb NOT NULL,
      UNIQUE(operation_id,row_key),UNIQUE(operation_id,ordinal)
    );
    CREATE INDEX dashboard_contact_row_page_idx ON dashboard_contact_rows(business_profile_id,user_id,operation_id,status,ordinal);
    CREATE INDEX report_projection_receipt_idx ON sent_messages(business_profile_id,user_id,outreach_message_id) WHERE outreach_message_id IS NOT NULL AND is_reply IS NOT TRUE;
    CREATE INDEX report_message_campaign_idx ON outreach_messages(business_profile_id,user_id,campaign_id,created_at) WHERE direction='outbound' AND message_kind IN('outreach','follow_up');
    CREATE INDEX report_conversation_recipient_idx ON outreach_conversations(business_profile_id,user_id,lead_id,channel,provider_account_id);
  `);
  for(const [table,links] of [
    ['dashboard_operation_inputs',[]],
    ['dashboard_operations',[{parent:'dashboard_operations',child_columns:['parent_id'],parent_columns:['id']},{parent:'dashboard_operation_inputs',child_columns:['artifact_input_id'],parent_columns:['id']}]],
    ['dashboard_operation_files',[{parent:'dashboard_operations',child_columns:['operation_id'],parent_columns:['id']},{parent:'dashboard_operation_inputs',child_columns:['input_id'],parent_columns:['id']}]],
    ['dashboard_contact_rows',[{parent:'dashboard_operations',child_columns:['operation_id'],parent_columns:['id']}]],
  ]) {
    const spec={table_name:table,owner_column:'user_id',global_read:false,parent_links:links,legacy_business_column:null};
    await client.query('INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links) VALUES($1,$2,false,$3::jsonb)',[table,'user_id',JSON.stringify(links)]);
    const literal=JSON.stringify(spec).replaceAll("'","''");
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY business_isolation ON ${table} FOR ALL USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));
      CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON ${table} NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO salesmarketing_business_runtime;`);
  }
  await client.query('GRANT USAGE,SELECT ON SEQUENCE dashboard_contact_rows_id_seq TO salesmarketing_business_runtime');
  // Temporary bytes use the existing organization storage ledger. They remain
  // private processing inputs, not public storage URLs. Only these guarded
  // functions may create or replace their reservation identities.
  await client.query(`
    CREATE FUNCTION dashboard_input_storage_reserve(p_input uuid) RETURNS void LANGUAGE plpgsql
      SECURITY DEFINER SET search_path=public,pg_catalog AS $$
    DECLARE source dashboard_operation_inputs; held billing_storage_reservations; reservation uuid; org integer;
    BEGIN
      SELECT * INTO source FROM dashboard_operation_inputs WHERE id=p_input
        AND user_id=app_business_user_id() AND business_profile_id=app_business_profile_id() FOR UPDATE;
      IF source.id IS NULL THEN RAISE EXCEPTION 'Staged input access denied' USING ERRCODE='42501'; END IF;
      SELECT billing_organization_id INTO org FROM company_settings WHERE id=source.business_profile_id AND user_id=source.user_id;
      SELECT * INTO held FROM billing_storage_reservations WHERE id=source.storage_reservation_id
        AND user_id=source.user_id AND business_profile_id=source.business_profile_id;
      IF held.id IS NULL OR held.expires_at<=now() OR held.organization_id IS DISTINCT FROM org THEN
        IF held.id IS NOT NULL THEN PERFORM billing_release_storage(held.id,source.business_profile_id,source.user_id); END IF;
        reservation:=billing_reserve_storage(source.business_profile_id,source.user_id,octet_length(source.bytes)::bigint);
        UPDATE dashboard_operation_inputs SET storage_reservation_id=reservation WHERE id=source.id;
      ELSE reservation:=held.id;
      END IF;
      UPDATE billing_storage_reservations SET expires_at=LEAST(source.expires_at,now()+interval '30 days 1 minute')
        WHERE id=reservation AND user_id=source.user_id AND business_profile_id=source.business_profile_id;
    END $$;
    REVOKE ALL ON FUNCTION dashboard_input_storage_reserve(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION dashboard_input_storage_reserve(uuid) TO salesmarketing_business_runtime;
    CREATE FUNCTION dashboard_input_storage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' AND (NEW.hash IS DISTINCT FROM OLD.hash OR NEW.bytes IS DISTINCT FROM OLD.bytes) THEN
        RAISE EXCEPTION 'A staged input is immutable; create a new input' USING ERRCODE='23514';
      END IF;
      IF current_user='salesmarketing_business_runtime' AND
        ((TG_OP='INSERT' AND NEW.storage_reservation_id IS NOT NULL) OR
          (TG_OP='UPDATE' AND NEW.storage_reservation_id IS DISTINCT FROM OLD.storage_reservation_id)) THEN
        RAISE EXCEPTION 'Storage reservation identity is server-managed' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER staged_input_storage_guard BEFORE INSERT OR UPDATE ON dashboard_operation_inputs
      FOR EACH ROW EXECUTE FUNCTION dashboard_input_storage_guard();
    CREATE FUNCTION dashboard_input_storage_account() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN
        IF OLD.storage_reservation_id IS NOT NULL THEN PERFORM billing_release_storage(OLD.storage_reservation_id,OLD.business_profile_id,OLD.user_id); END IF;
        RETURN OLD;
      END IF;
      PERFORM dashboard_input_storage_reserve(NEW.id);
      RETURN NEW;
    END $$;
    CREATE TRIGGER staged_input_storage_account AFTER INSERT OR DELETE OR UPDATE OF expires_at,bytes ON dashboard_operation_inputs
      FOR EACH ROW EXECUTE FUNCTION dashboard_input_storage_account();
  `);
}
export async function down(client) {
  if((await client.query('SELECT 1 FROM dashboard_operations LIMIT 1')).rows.length) throw new Error('Dashboard operation history exists. Retain the history and roll forward.');
  await client.query(`DROP TABLE dashboard_contact_rows,dashboard_operation_files,dashboard_operations,dashboard_operation_inputs;
    DROP FUNCTION dashboard_input_storage_account(),dashboard_input_storage_guard(),dashboard_input_storage_reserve(uuid);
    DELETE FROM business_scope_tables WHERE table_name IN('dashboard_contact_rows','dashboard_operation_files','dashboard_operations','dashboard_operation_inputs');
    DROP INDEX report_projection_receipt_idx,report_message_campaign_idx,report_conversation_recipient_idx;`);
}
