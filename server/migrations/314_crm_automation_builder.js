/** Transactional events and durable ordered CRM automation execution. Disabled until explicit cutover. */
export async function up(client) {
  await client.query(`
    ALTER TABLE crm_pipeline_automations ADD COLUMN IF NOT EXISTS definition jsonb;
    ALTER TABLE crm_pipeline_automations ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
    ALTER TABLE crm_pipeline_automations ADD COLUMN IF NOT EXISTS deleted_at timestamp;
    UPDATE crm_pipeline_automations SET definition=jsonb_build_object(
      'version',2,'trigger',jsonb_build_object('type',trigger_type,'config',jsonb_strip_nulls(jsonb_build_object(
        'fromStatus',NULLIF(trigger_config->>'fromStatus','any'),'toStatus',NULLIF(trigger_config->>'toStatus','any')))),
      'conditions',jsonb_build_object('match','all','rules','[]'::jsonb),
      'actions',jsonb_build_array(jsonb_build_object('id','legacy-action','type',action,'config',COALESCE(action_config,'{}'::jsonb))))
      WHERE definition IS NULL;
    CREATE TABLE crm_automation_runtime (
      id integer PRIMARY KEY DEFAULT 1 CHECK(id=1), enabled boolean NOT NULL DEFAULT false,
      cutover_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO crm_automation_runtime(id) VALUES(1);
    INSERT INTO business_scope_accounts(table_name) VALUES('crm_automation_runtime') ON CONFLICT DO NOTHING;
    GRANT SELECT ON crm_automation_runtime TO salesmarketing_business_runtime;
    CREATE TABLE crm_automation_events (
      id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      event_type varchar(80) NOT NULL, source_key varchar(800) NOT NULL, origin varchar(30) NOT NULL DEFAULT 'system',
      contact_id integer, conversation_id integer, campaign_id integer, context jsonb NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending', dispatch_count integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz, lease_token varchar(80), error_message text,
      occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), prepared_at timestamptz,
      CONSTRAINT crm_automation_events_status CHECK(status IN ('pending','queued','processing','completed','cancelled','failed')),
      CONSTRAINT crm_automation_events_source_uq UNIQUE(business_profile_id,user_id,event_type,source_key)
    );
    CREATE INDEX crm_automation_events_pending_idx ON crm_automation_events(status,available_at);
    CREATE TABLE crm_automation_receipts (
      id serial PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      channel varchar(30) NOT NULL,provider_account_id varchar(255) NOT NULL,provider_message_id varchar(1000) NOT NULL,
      status varchar(40) NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT crm_automation_receipts_uq UNIQUE(business_profile_id,user_id,channel,provider_account_id,provider_message_id,status)
    );
    CREATE TABLE crm_automation_runs (
      id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      automation_id integer NOT NULL REFERENCES crm_pipeline_automations(id) ON DELETE CASCADE,
      automation_name varchar(255) NOT NULL, revision integer NOT NULL, priority integer NOT NULL DEFAULT 0,
      event_id integer NOT NULL REFERENCES crm_automation_events(id) ON DELETE CASCADE, event_type varchar(80) NOT NULL,
      contact_id integer, contact_name text, definition jsonb NOT NULL, context jsonb NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'queued', error_message text, created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz, completed_at timestamptz,
      CONSTRAINT crm_automation_runs_status CHECK(status IN ('queued','running','retry','success','failed','skipped','cancelled','uncertain')),
      CONSTRAINT crm_automation_runs_event_rule_uq UNIQUE(automation_id,event_id)
    );
    CREATE INDEX crm_automation_runs_history_idx ON crm_automation_runs(business_profile_id,automation_id,id DESC);
    CREATE TABLE crm_automation_run_steps (
      id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      run_id integer NOT NULL REFERENCES crm_automation_runs(id) ON DELETE CASCADE,
      step_id varchar(80) NOT NULL, position integer NOT NULL, action_type varchar(50) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
      dispatch_started boolean NOT NULL DEFAULT false, error_message text, result jsonb, prepared jsonb,
      provider_message_id varchar(1000), provider_status varchar(40), channel varchar(30), provider_account_id varchar(255),
      reservation_transaction_id integer, conversation_id integer, message_id integer, refund_pending boolean NOT NULL DEFAULT false,
      available_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz, completed_at timestamptz,
      CONSTRAINT crm_automation_run_steps_status CHECK(status IN ('pending','running','retry','success','failed','cancelled','uncertain')),
      CONSTRAINT crm_automation_run_steps_step_uq UNIQUE(run_id,step_id)
    );
    CREATE INDEX crm_automation_run_steps_receipt_idx ON crm_automation_run_steps(business_profile_id,channel,provider_account_id,provider_message_id);
    CREATE UNIQUE INDEX wallet_crm_automation_step_charge_uq ON wallet_transactions(organization_id,reference_type,reference_id)
      WHERE type='deduction' AND reference_type='crm_automation_step';
  `);
  for (const [table, parentLinks] of [
    ['crm_automation_events', []],
    ['crm_automation_receipts', []],
    ['crm_automation_runs', [{ parent: 'crm_pipeline_automations', child_columns: ['automation_id'], parent_columns: ['id'] },
      { parent: 'crm_automation_events', child_columns: ['event_id'], parent_columns: ['id'] }]],
    ['crm_automation_run_steps', [{ parent: 'crm_automation_runs', child_columns: ['run_id'], parent_columns: ['id'] }]],
  ]) {
    const spec = { table_name: table, owner_column: 'user_id', global_read: false, parent_links: parentLinks, legacy_business_column: null };
    await client.query('INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links) VALUES($1,$2,false,$3::jsonb)', [table, 'user_id', JSON.stringify(parentLinks)]);
    const literal = JSON.stringify(spec).replaceAll("'", "''");
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY business_isolation ON ${table} FOR ALL USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));
      CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON ${table} NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO salesmarketing_business_runtime;
      GRANT USAGE,SELECT ON SEQUENCE ${table}_id_seq TO salesmarketing_business_runtime;`);
  }
  await client.query(`
    CREATE FUNCTION crm_automation_enabled() RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT COALESCE((SELECT enabled FROM crm_automation_runtime WHERE id=1),false)
    $$;
    CREATE FUNCTION crm_automation_contact_context(p_contact integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT jsonb_build_object('id',id,'name',trim(concat_ws(' ',first_name,last_name)),
        'email',email,'phone',phone,'status',status,'pipelineStatus',pipeline_status,'tags',COALESCE(tags,'[]'::jsonb),'dealValue',deal_value)
      FROM crm_contacts WHERE id=p_contact AND deleted_at IS NULL
    $$;
    CREATE FUNCTION crm_automation_emit(p_row jsonb,p_type text,p_source text,p_context jsonb,p_contact integer DEFAULT NULL,
      p_conversation integer DEFAULT NULL,p_campaign integer DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT crm_automation_enabled() OR COALESCE(current_setting('app.crm_automation_origin',true),'')='automation'
        OR p_row->>'business_profile_id' IS NULL OR p_row->>'user_id' IS NULL THEN RETURN; END IF;
      INSERT INTO crm_automation_events(user_id,business_profile_id,event_type,source_key,contact_id,conversation_id,campaign_id,context)
      VALUES((p_row->>'user_id')::integer,(p_row->>'business_profile_id')::integer,p_type,
        CASE WHEN length(p_source)>700 THEN left(p_source,660)||'-'||md5(p_source) ELSE p_source END,p_contact,p_conversation,p_campaign,
        jsonb_strip_nulls(p_context || CASE WHEN p_contact IS NOT NULL THEN jsonb_build_object('contact',crm_automation_contact_context(p_contact)) ELSE '{}'::jsonb END))
      ON CONFLICT(business_profile_id,user_id,event_type,source_key) DO NOTHING;
    END $$;
    CREATE FUNCTION crm_automation_capture_contact() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE n jsonb=to_jsonb(NEW); o jsonb; key text; fields text[]; a jsonb; b jsonb;
    BEGIN
      IF NEW.deleted_at IS NOT NULL OR NOT crm_automation_enabled() THEN RETURN NEW; END IF;
      key='contact-'||NEW.id||'-'||txid_current();
      IF TG_OP='INSERT' THEN
        PERFORM crm_automation_emit(n,'contact_created','contact-'||NEW.id||'-created','{}'::jsonb,NEW.id);
      ELSE
        o=to_jsonb(OLD);
        fields=ARRAY['first_name','last_name','email','phone','company','role','status','pipeline_status','tags','assigned_to','deal_value'];
        SELECT jsonb_object_agg(f,n->f),jsonb_object_agg(f,o->f) INTO a,b FROM unnest(fields) f;
        IF a IS DISTINCT FROM b THEN PERFORM crm_automation_emit(n,'contact_updated',key||'-'||md5(a::text),'{}'::jsonb,NEW.id); END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
          PERFORM crm_automation_emit(n,'status_change',key||'-status-'||md5(concat_ws(':',OLD.status,NEW.status)),
            jsonb_build_object('event',jsonb_build_object('oldValue',OLD.status,'newValue',NEW.status)),NEW.id);
        END IF;
        IF NEW.pipeline_status IS DISTINCT FROM OLD.pipeline_status THEN
          PERFORM crm_automation_emit(n,'pipeline_status_change',key||'-stage-'||md5(concat_ws(':',OLD.pipeline_status,NEW.pipeline_status)),
            jsonb_build_object('event',jsonb_build_object('oldValue',OLD.pipeline_status,'newValue',NEW.pipeline_status)),NEW.id);
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER crm_automation_capture AFTER INSERT OR UPDATE ON crm_contacts FOR EACH ROW EXECUTE FUNCTION crm_automation_capture_contact();

    CREATE FUNCTION crm_automation_capture_message() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE n jsonb=to_jsonb(NEW); o jsonb='{}'::jsonb; c record; contact integer; v_channel text; ctx jsonb; key text;
      provider text; accepted boolean; was_accepted boolean; native boolean; is_comment boolean; campaign integer;
    BEGIN
      IF NOT crm_automation_enabled() OR COALESCE(NEW.metadata->>'origin','')='crm_automation' THEN RETURN NEW; END IF;
      IF TG_OP='UPDATE' THEN o=to_jsonb(OLD); END IF;
      SELECT * INTO c FROM outreach_conversations WHERE id=NEW.conversation_id AND user_id=NEW.user_id;
      IF NOT FOUND THEN RETURN NEW; END IF;
      v_channel=CASE WHEN c.channel='gmail' THEN 'email' ELSE c.channel END;
      contact=c.crm_contact_id;
      IF contact IS NULL THEN SELECT id INTO contact FROM crm_contacts WHERE lead_id=c.lead_id AND user_id=NEW.user_id AND deleted_at IS NULL ORDER BY id LIMIT 1; END IF;
      provider=COALESCE(NULLIF(NEW.provider_message_id,''),NULLIF(NEW.external_message_id,''),NULLIF(NEW.waba_message_id,''));
      key=v_channel||'-'||COALESCE(c.provider_account_id,NEW.provider_account_id,NEW.phone_number_id,'')||'-'||COALESCE(provider,'local-'||NEW.id);
      campaign=COALESCE(NEW.campaign_id,CASE WHEN c.metadata->>'campaignId' ~ '^[0-9]{1,9}$' THEN (c.metadata->>'campaignId')::integer END);
      ctx=jsonb_build_object('event',jsonb_build_object('channel',v_channel,'accountId',COALESCE(c.provider_account_id,NEW.provider_account_id,NEW.phone_number_id),'status',NEW.status),
        'message',jsonb_build_object('id',NEW.id,'text',COALESCE(NEW.redacted_content,''),'status',NEW.status,'direction',NEW.direction),
        'conversation',jsonb_build_object('id',c.id,'status',c.status));
      IF campaign IS NOT NULL THEN ctx=ctx||jsonb_build_object('campaign',(SELECT jsonb_build_object('id',id,'name',name,'status',status) FROM outreach_campaigns WHERE id=campaign AND user_id=NEW.user_id)); END IF;
      native=COALESCE(NEW.metadata->>'origin','') IN ('native_app','external_app');
      is_comment=COALESCE(NEW.metadata->>'replySurface',NEW.metadata->>'reply_surface',c.metadata->>'replySurface','')='comment'
        OR NEW.metadata ? 'commentId' OR NEW.metadata ? 'comment_id';
      IF TG_OP='INSERT' AND NEW.direction='inbound' THEN
        IF v_channel='instagram' AND is_comment THEN
          PERFORM crm_automation_emit(n,'instagram_comment_received',key,ctx,contact,c.id,campaign);
        ELSIF v_channel IN ('whatsapp','instagram','facebook') THEN
          PERFORM crm_automation_emit(n,v_channel||'_message_received',key,ctx,contact,c.id,campaign);
        END IF;
        IF campaign IS NOT NULL THEN PERFORM crm_automation_emit(n,'campaign_reply_received',key,ctx,contact,c.id,campaign); END IF;
      END IF;
      IF TG_OP='INSERT' AND NEW.direction='outbound' AND native AND v_channel IN ('whatsapp','instagram','facebook') THEN
        PERFORM crm_automation_emit(n,v_channel||'_message_echo',key,ctx,contact,c.id,campaign);
      END IF;
      accepted=NEW.direction='outbound' AND NEW.status IN ('sent','delivered','read') AND provider IS NOT NULL
        AND COALESCE(NEW.provider_call_state,'not_started') NOT IN ('started','unknown','rejected');
      was_accepted=o->>'direction'='outbound' AND o->>'status' IN ('sent','delivered','read')
        AND COALESCE(NULLIF(o->>'provider_message_id',''),NULLIF(o->>'external_message_id',''),NULLIF(o->>'waba_message_id','')) IS NOT NULL;
      IF accepted AND NOT COALESCE(was_accepted,false) THEN
        IF NOT native AND v_channel IN ('whatsapp','instagram','facebook') THEN PERFORM crm_automation_emit(n,v_channel||'_message_sent',key,ctx,contact,c.id,campaign); END IF;
        IF NEW.is_ai_generated IS TRUE THEN PERFORM crm_automation_emit(n,'ai_response_sent',key,ctx,contact,c.id,campaign); END IF;
        IF NEW.message_kind='follow_up' THEN PERFORM crm_automation_emit(n,'follow_up_sent',key,ctx,contact,c.id,campaign); END IF;
        IF campaign IS NOT NULL THEN PERFORM crm_automation_emit(n,'campaign_message_sent',key,ctx,contact,c.id,campaign); END IF;
      END IF;
      IF NEW.direction='outbound' AND provider IS NOT NULL AND v_channel IN ('whatsapp','instagram','facebook')
        AND NEW.status IN ('delivered','read','failed','bounced') AND NEW.status IS DISTINCT FROM o->>'status'
        AND NOT(COALESCE(o->>'status','')='read' AND NEW.status<>'read') AND NOT(COALESCE(o->>'status','')='delivered' AND NEW.status='sent') THEN
        PERFORM crm_automation_emit(n,v_channel||'_message_status',key||'-'||NEW.status,ctx,contact,c.id,campaign);
      END IF;
      IF provider IS NOT NULL THEN
        UPDATE crm_automation_run_steps SET provider_status=NEW.status
        WHERE user_id=NEW.user_id AND business_profile_id=NEW.business_profile_id AND channel=v_channel
          AND provider_account_id=COALESCE(c.provider_account_id,NEW.provider_account_id,NEW.phone_number_id,'') AND provider_message_id=provider
          AND NEW.status IN ('delivered','read','failed','bounced') AND COALESCE(provider_status,'accepted')<>'read'
          AND NOT(COALESCE(provider_status,'')='delivered' AND NEW.status='sent');
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER crm_automation_capture AFTER INSERT OR UPDATE ON outreach_messages FOR EACH ROW EXECUTE FUNCTION crm_automation_capture_message();

    CREATE FUNCTION crm_automation_capture_ticket() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE n jsonb=to_jsonb(NEW); ctx jsonb; key text; old_assignee integer; new_assignee integer;
    BEGIN
      IF NEW.deleted_at IS NOT NULL OR NOT crm_automation_enabled() THEN RETURN NEW; END IF;
      ctx=jsonb_build_object('ticket',jsonb_build_object('id',NEW.id,'number',NEW.ticket_number,'subject',NEW.subject,'priority',NEW.priority,'status',NEW.status));
      key='ticket-'||NEW.id||'-'||txid_current();
      IF TG_OP='INSERT' THEN PERFORM crm_automation_emit(n,'ticket_created','ticket-'||NEW.id||'-created',ctx,NEW.contact_id,NEW.outreach_conversation_id);
      ELSE
        old_assignee=COALESCE(OLD.assigned_member_id,OLD.assigned_to); new_assignee=COALESCE(NEW.assigned_member_id,NEW.assigned_to);
        IF new_assignee IS DISTINCT FROM old_assignee THEN
          PERFORM crm_automation_emit(n,CASE WHEN new_assignee IS NULL THEN 'ticket_unassigned' ELSE 'ticket_assigned' END,
            key||'-assignee-'||COALESCE(new_assignee::text,'none'),ctx,NEW.contact_id,NEW.outreach_conversation_id);
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
          PERFORM crm_automation_emit(n,'ticket_status_changed',key||'-status-'||NEW.status,
            ctx||jsonb_build_object('event',jsonb_build_object('oldValue',OLD.status,'newValue',NEW.status)),NEW.contact_id,NEW.outreach_conversation_id);
        END IF;
      END IF; RETURN NEW;
    END $$;
    CREATE TRIGGER crm_automation_capture AFTER INSERT OR UPDATE ON support_tickets FOR EACH ROW EXECUTE FUNCTION crm_automation_capture_ticket();

    CREATE FUNCTION crm_automation_capture_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE n jsonb=to_jsonb(NEW); ctx jsonb;
    BEGIN
      IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.automation_mode IS NOT DISTINCT FROM OLD.automation_mode THEN RETURN NEW; END IF;
      ctx=jsonb_build_object('conversation',jsonb_build_object('id',NEW.id,'status',NEW.status),
        'event',jsonb_build_object('channel',NEW.channel,'accountId',NEW.provider_account_id,
          'oldValue',CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN OLD.status ELSE OLD.automation_mode END,
          'newValue',CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN NEW.status ELSE NEW.automation_mode END));
      PERFORM crm_automation_emit(n,'conversation_status_changed','conversation-'||NEW.id||'-'||txid_current()||'-'||md5(ctx::text),ctx,NEW.crm_contact_id,NEW.id);
      RETURN NEW;
    END $$;
    CREATE TRIGGER crm_automation_capture AFTER UPDATE ON outreach_conversations FOR EACH ROW EXECUTE FUNCTION crm_automation_capture_conversation();
    CREATE FUNCTION crm_automation_capture_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE n jsonb=to_jsonb(NEW); conversation integer; c record; contact integer; inbox_conversation integer;
      event_channel text; event_account text; event_status text;
    BEGIN
      conversation=COALESCE((n->>'outreach_conversation_id')::integer,(n->>'conversation_id')::integer);
      IF conversation>0 THEN
        SELECT * INTO c FROM outreach_conversations WHERE id=conversation AND user_id=(n->>'user_id')::integer;
        IF FOUND THEN contact=c.crm_contact_id;inbox_conversation=c.id;event_channel=c.channel;
          event_account=c.provider_account_id;event_status=c.status; END IF;
      END IF;
      PERFORM crm_automation_emit(n,'conversation_handoff','handoff-'||(n->>'id'),
        jsonb_build_object('conversation',jsonb_build_object('id',conversation,'status',COALESCE(event_status,n->>'status')),
          'event',jsonb_build_object('channel',COALESCE(event_channel,n->>'channel'),'accountId',event_account)),contact,inbox_conversation);
      RETURN NEW;
    END $$;
    CREATE TRIGGER crm_automation_capture AFTER INSERT ON handoff_queue FOR EACH ROW EXECUTE FUNCTION crm_automation_capture_handoff();
    CREATE FUNCTION crm_automation_capture_campaign() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE n jsonb=to_jsonb(NEW); event text;
    BEGIN
      IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
      event=CASE WHEN NEW.status IN ('running','active') THEN 'campaign_started' WHEN NEW.status='completed' THEN 'campaign_completed'
        WHEN NEW.status IN ('failed','partial_success','needs_attention') THEN 'campaign_failed' ELSE NULL END;
      IF event IS NOT NULL THEN PERFORM crm_automation_emit(n,event,'campaign-'||NEW.id||'-'||txid_current()||'-'||NEW.status,
        jsonb_build_object('campaign',jsonb_build_object('id',NEW.id,'name',NEW.name,'status',NEW.status),'event',jsonb_build_object('newValue',NEW.status)),NULL,NULL,NEW.id); END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER crm_automation_capture AFTER INSERT OR UPDATE ON outreach_campaigns FOR EACH ROW EXECUTE FUNCTION crm_automation_capture_campaign();
    CREATE FUNCTION crm_automation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status NOT IN ('delivered','read','failed','bounced') THEN RETURN NEW; END IF;
      UPDATE crm_automation_run_steps SET provider_status=NEW.status
        WHERE user_id=NEW.user_id AND business_profile_id=NEW.business_profile_id AND message_id=NEW.id
        AND COALESCE(provider_status,'accepted')<>'read'
        AND NOT(COALESCE(provider_status,'')='delivered' AND NEW.status IN ('failed','bounced'));
      RETURN NEW;
    END $$;
    CREATE TRIGGER crm_automation_receipt AFTER INSERT OR UPDATE ON outreach_messages FOR EACH ROW EXECUTE FUNCTION crm_automation_receipt();
  `);
}

export async function down(client) {
  const { rows } = await client.query('SELECT 1 FROM crm_automation_runs LIMIT 1');
  if (rows.length) throw new Error('Disable CRM automation runtime to roll back execution; retain run and delivery history.');
  for (const table of ['crm_contacts','outreach_messages','support_tickets','outreach_conversations','handoff_queue','outreach_campaigns']) {
    await client.query(`DROP TRIGGER IF EXISTS crm_automation_capture ON ${table}`);
  }
  await client.query(`DROP FUNCTION crm_automation_capture_contact(),crm_automation_capture_message(),crm_automation_capture_ticket(),
    crm_automation_capture_conversation(),crm_automation_capture_handoff(),crm_automation_capture_campaign();
    DROP FUNCTION crm_automation_emit(jsonb,text,text,jsonb,integer,integer,integer);
    DROP TRIGGER crm_automation_receipt ON outreach_messages;
    DROP FUNCTION crm_automation_receipt(),crm_automation_contact_context(integer),crm_automation_enabled();
    DROP TABLE crm_automation_run_steps,crm_automation_runs,crm_automation_events,crm_automation_receipts,crm_automation_runtime;
    DELETE FROM business_scope_tables WHERE table_name IN ('crm_automation_run_steps','crm_automation_runs','crm_automation_events','crm_automation_receipts');
    DELETE FROM business_scope_accounts WHERE table_name='crm_automation_runtime';
    DROP INDEX wallet_crm_automation_step_charge_uq;
    ALTER TABLE crm_pipeline_automations DROP COLUMN definition,DROP COLUMN revision,DROP COLUMN deleted_at;`);
}
