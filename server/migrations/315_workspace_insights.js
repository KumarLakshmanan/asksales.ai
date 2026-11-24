/** Additive analytics projections. Existing wallet entries are never rewritten. */
const usageSources = ['openai_usages', 'gemini_usages', 'embedding_usages', 'apify_usages', 'zerobounce_usages', 'support_tool_executions'];

export async function up(client) {
  await client.query(`
    CREATE TABLE ai_usage_events (
      id serial PRIMARY KEY,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, actor_user_id integer NOT NULL,
      organization_id integer, source_table varchar(80) NOT NULL, source_id varchar(120) NOT NULL,
      attempt_id varchar(160) NOT NULL, operation_id varchar(160) NOT NULL,
      kind varchar(30) NOT NULL, process varchar(100) NOT NULL, provider varchar(50), model varchar(150),
      channel varchar(30) NOT NULL, conversation_kind varchar(30), conversation_id integer, contact_id integer,
      agent varchar(150), input_tokens integer, output_tokens integer, total_tokens integer,
      cached_tokens integer, reasoning_tokens integer, units numeric(20,6) NOT NULL DEFAULT 1,
      unit varchar(30) NOT NULL DEFAULT 'request', status varchar(30) NOT NULL, duration_ms integer,
      provider_cost_usd numeric(20,10), pricing_snapshot jsonb, billing_transaction_id integer,
      started_at timestamptz NOT NULL, completed_at timestamptz, occurred_at timestamptz NOT NULL,
      CONSTRAINT ai_usage_events_source_uq UNIQUE(business_profile_id,source_table,source_id),
      CONSTRAINT ai_usage_events_attempt_uq UNIQUE(business_profile_id,attempt_id),
      CONSTRAINT ai_usage_events_channel CHECK(channel IN ('whatsapp','instagram','facebook','email','sms','widget','workspace','unattributed')),
      CONSTRAINT ai_usage_events_kind CHECK(kind IN ('text','embedding','image','video','audio','tool','service'))
    );
    CREATE INDEX ai_usage_events_period_idx ON ai_usage_events(business_profile_id,occurred_at);
    CREATE INDEX ai_usage_events_conversation_idx ON ai_usage_events(business_profile_id,conversation_kind,conversation_id);
    CREATE TABLE sales_outcome_events (
      id serial PRIMARY KEY,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, actor_user_id integer NOT NULL,
      source_key varchar(500) NOT NULL, kind varchar(40) NOT NULL, contact_id integer, booking_id integer,
      conversation_kind varchar(30), conversation_id integer, channel varchar(30) NOT NULL DEFAULT 'unattributed',
      amount numeric(20,6), currency varchar(10), evidence varchar(30) NOT NULL, payment_id varchar(255),
      verified boolean NOT NULL DEFAULT false, occurred_at timestamptz NOT NULL,
      CONSTRAINT sales_outcome_events_source_uq UNIQUE(business_profile_id,source_key),
      CONSTRAINT sales_outcome_events_kind CHECK(kind IN ('contact_created','contact_won','booking_confirmed','booking_cancelled','payment_captured','payment_refunded')),
      CONSTRAINT sales_outcome_events_amount CHECK(amount IS NULL OR amount>=0)
    );
    CREATE INDEX sales_outcome_events_period_idx ON sales_outcome_events(business_profile_id,occurred_at);
    CREATE INDEX sales_outcome_events_contact_idx ON sales_outcome_events(business_profile_id,contact_id,occurred_at);
    CREATE TABLE workspace_insights_runtime (
      id integer PRIMARY KEY DEFAULT 1 CHECK(id=1), enabled boolean NOT NULL DEFAULT false,
      pricing_guard_enabled boolean NOT NULL DEFAULT false,
      instrumentation_started_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO workspace_insights_runtime(id) VALUES(1);
    ALTER TABLE support_tool_executions ADD COLUMN insights_conversation_kind varchar(30), ADD COLUMN insights_conversation_id integer;
    INSERT INTO business_scope_accounts(table_name) VALUES('workspace_insights_runtime') ON CONFLICT DO NOTHING;
    GRANT SELECT,UPDATE ON workspace_insights_runtime TO salesmarketing_business_runtime;

    CREATE FUNCTION insights_positive_int(value text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN value ~ '^[1-9][0-9]{0,9}$' THEN CASE WHEN value::bigint<=2147483647 THEN value::integer END END
    $$;
    CREATE FUNCTION insights_number(value text) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN value ~ '^-?[0-9]{1,20}([.][0-9]{1,12})?$' THEN value::numeric END
    $$;
    CREATE FUNCTION insights_process(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE
        WHEN value ~* 'follow.?up' THEN 'follow_up'
        WHEN value ~* 'intent|classif|routing' THEN 'routing'
        WHEN value ~* 'compaction|summari' THEN 'conversation_compaction'
        WHEN value ~* 'embed|knowledge' THEN 'knowledge'
        WHEN value ~* 'image|video|media' THEN 'media'
        WHEN value ~* 'lead|icp|enrich|scrap|validation|fit_score' THEN 'leads'
        WHEN value ~* 'visibility|audit|observation' THEN 'ai_visibility'
        WHEN value ~* 'support|reply|outreach|nlu|response' THEN 'customer_chat'
        WHEN value ~* 'content|campaign|ad_|marketing|proposal' THEN 'content'
        ELSE 'general_chat' END
    $$;
    CREATE FUNCTION insights_channel(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN value IN ('whatsapp','instagram','facebook','email','sms','widget','workspace','unattributed') THEN value
        WHEN value='gmail' THEN 'email' WHEN value='messenger' THEN 'facebook'
        ELSE 'unattributed' END
    $$;

    CREATE FUNCTION insights_project_usage(source_name text, p jsonb) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE c jsonb:=COALESCE(p->'metadata'->'_insights','{}'::jsonb); m jsonb:=COALESCE(p->'metadata','{}'::jsonb);
      owner_id integer:=insights_positive_int(p->>'user_id'); usage_business_id integer:=insights_positive_int(p->>'business_profile_id');
      event_kind text; state text; platform text; conv_kind text; conv_id integer; channel_name text;
      event_at timestamptz; elapsed integer; attempt text; source_identifier text;
    BEGIN
      IF owner_id IS NULL OR usage_business_id IS NULL THEN RETURN; END IF;
      -- This was a second, manual log of an already-metered provider request.
      IF source_name='openai_usages' AND p->>'service'='ConversationCompactionService'
        AND p->>'purpose'='conversation_compaction' AND EXISTS (
          SELECT 1 FROM openai_usages original WHERE original.user_id=owner_id AND original.business_profile_id=usage_business_id
            AND original.service='ConversationCompactionService' AND original.purpose<>'conversation_compaction'
            AND original.thread_id IS NOT DISTINCT FROM insights_positive_int(p->>'thread_id')
            AND original.model=p->>'model' AND original.prompt_tokens IS NOT DISTINCT FROM insights_positive_int(p->>'prompt_tokens')
            AND original.completion_tokens IS NOT DISTINCT FROM insights_positive_int(p->>'completion_tokens')
            AND abs(extract(epoch FROM (original.created_at-(p->>'created_at')::timestamp)))<=10
        ) THEN RETURN; END IF;
      event_kind:=CASE source_name WHEN 'embedding_usages' THEN 'embedding' WHEN 'support_tool_executions' THEN 'tool'
        WHEN 'apify_usages' THEN 'service' WHEN 'zerobounce_usages' THEN 'service'
        WHEN 'gemini_usages' THEN CASE p->>'operation_type' WHEN 'image_generation' THEN 'image' WHEN 'video_generation' THEN 'video' ELSE 'text' END
        ELSE CASE WHEN COALESCE(p->>'purpose','') ~* 'audio|transcri|speech' THEN 'audio' ELSE 'text' END END;
      platform:=CASE source_name WHEN 'gemini_usages' THEN COALESCE(m->>'provider','gemini')
        WHEN 'support_tool_executions' THEN NULL WHEN 'apify_usages' THEN 'apify' WHEN 'zerobounce_usages' THEN 'zerobounce'
        ELSE COALESCE(p->>'provider','openai') END;
      state:=CASE WHEN source_name='support_tool_executions' THEN
          CASE WHEN p->>'status' IN ('success','completed','succeeded') THEN 'success'
            WHEN p->>'status' IN ('running','pending','awaiting_approval','awaiting_confirmation','approval_pending') THEN 'pending' ELSE 'failure' END
        WHEN p->>'response_success'='0' OR p->>'status' IN ('failed','failure','error') THEN 'failure'
        WHEN p->>'status'='partial' THEN 'partial' ELSE 'success' END;
      conv_kind:=c->'conversation'->>'kind'; conv_id:=insights_positive_int(c->'conversation'->>'id');
      IF source_name='support_tool_executions' AND conv_id IS NULL THEN
        conv_kind:=p->>'insights_conversation_kind';
        conv_id:=insights_positive_int(p->>'insights_conversation_id');
      END IF;
      IF conv_id IS NULL AND insights_positive_int(p->>'thread_id') IS NOT NULL THEN
        conv_kind:='workspace'; conv_id:=insights_positive_int(p->>'thread_id');
      END IF;
      IF conv_kind NOT IN ('outreach','widget','workspace') THEN conv_kind:=NULL; conv_id:=NULL; END IF;
      -- Validate every polymorphic reference in the source business.
      IF conv_kind='outreach' AND NOT EXISTS(SELECT 1 FROM outreach_conversations WHERE id=conv_id AND business_profile_id=usage_business_id AND user_id=owner_id) THEN conv_kind:=NULL; conv_id:=NULL; END IF;
      IF conv_kind='widget' AND NOT EXISTS(SELECT 1 FROM support_chat_sessions WHERE id=conv_id AND business_profile_id=usage_business_id) THEN conv_kind:=NULL; conv_id:=NULL; END IF;
      IF conv_kind='workspace' AND NOT EXISTS(SELECT 1 FROM chat_threads WHERE id=conv_id AND business_profile_id=usage_business_id AND user_id=owner_id) THEN conv_kind:=NULL; conv_id:=NULL; END IF;
      channel_name:=insights_channel(COALESCE(c->>'channel',m->>'channel'));
      IF conv_kind='widget' THEN channel_name:='widget';
      ELSIF conv_kind='workspace' THEN channel_name:='workspace';
      ELSIF conv_kind='outreach' THEN SELECT insights_channel(channel) INTO channel_name FROM outreach_conversations WHERE id=conv_id AND business_profile_id=usage_business_id;
      END IF;
      event_at:=COALESCE(CASE WHEN source_name='support_tool_executions' THEN (p->>'last_attempt_at')::timestamp AT TIME ZONE 'UTC' END,
        (p->>'created_at')::timestamp AT TIME ZONE 'UTC',now());
      elapsed:=CASE WHEN source_name='support_tool_executions' AND p->>'completed_at' IS NOT NULL
          THEN GREATEST(0,extract(epoch FROM ((p->>'completed_at')::timestamp-COALESCE((p->>'last_attempt_at')::timestamp,(p->>'started_at')::timestamp)))*1000)::integer
        ELSE GREATEST(0,COALESCE(insights_number(p->>'duration_ms'),0))::integer END;
      source_identifier:=p->>'id';
      IF source_name='support_tool_executions' THEN source_identifier:=source_identifier||':'||COALESCE(p->>'attempt_count','1'); END IF;
      attempt:=left(COALESCE(c->>'attemptId',source_name||':'||source_identifier),160);
      INSERT INTO ai_usage_events(business_profile_id,user_id,actor_user_id,organization_id,source_table,source_id,attempt_id,operation_id,
        kind,process,provider,model,channel,conversation_kind,conversation_id,contact_id,agent,input_tokens,output_tokens,total_tokens,
        cached_tokens,reasoning_tokens,units,unit,status,duration_ms,provider_cost_usd,pricing_snapshot,started_at,completed_at,occurred_at)
      VALUES(usage_business_id,owner_id,COALESCE(insights_positive_int(c->>'actorUserId'),owner_id),insights_positive_int(c->>'organizationId'),
        source_name,source_identifier,attempt,left(COALESCE(c->>'operationId',p->>'idempotency_key',p->>'workflow_id',attempt),160),event_kind,
        COALESCE(c->>'process',insights_process(COALESCE(p->>'purpose',p->>'operation_type',p->>'tool_name',''))),platform,
        COALESCE(p->>'model',CASE WHEN event_kind='tool' THEN p->>'tool_name' END),channel_name,conv_kind,conv_id,
        COALESCE(insights_positive_int(c->>'contactId'),CASE WHEN conv_kind='outreach' THEN
          (SELECT crm_contact_id FROM outreach_conversations WHERE id=conv_id AND business_profile_id=usage_business_id) END),left(c->>'agent',150),
        COALESCE(insights_number(p->>'prompt_tokens'),insights_number(p->>'input_tokens'))::integer,
        COALESCE(insights_number(p->>'completion_tokens'),insights_number(p->>'output_tokens'))::integer,
        COALESCE(insights_number(p->>'total_tokens'),COALESCE(insights_number(p->>'input_tokens'),0)+COALESCE(insights_number(p->>'output_tokens'),0))::integer,
        insights_number(c->>'cachedTokens')::integer,insights_number(c->>'reasoningTokens')::integer,
        CASE event_kind WHEN 'image' THEN COALESCE(insights_number(p->>'images_generated'),0)
          WHEN 'video' THEN COALESCE(insights_number(p->>'videos_generated'),0)
          WHEN 'embedding' THEN COALESCE(insights_number(p->>'texts_count'),1)
          ELSE CASE source_name WHEN 'apify_usages' THEN COALESCE(insights_number(p->>'items_scraped'),0)
            WHEN 'zerobounce_usages' THEN COALESCE(insights_number(p->>'emails_validated'),0) ELSE 1 END END,
        CASE event_kind WHEN 'image' THEN 'image' WHEN 'video' THEN 'video' WHEN 'embedding' THEN 'text'
          ELSE CASE source_name WHEN 'apify_usages' THEN 'item' WHEN 'zerobounce_usages' THEN 'email' ELSE 'request' END END,
        state,CASE WHEN elapsed>0 OR p->>'duration_ms'='0' THEN elapsed END,
        COALESCE(insights_number(c->'pricing'->>'providerCostUsd'),insights_number(p->>'original_cost_cents')/100,
          insights_number(m->>'originalCostCents')/100,insights_number(p->>'estimated_cost_cents')/100,insights_number(p->>'cost_cents')/100),
        c->'pricing',CASE WHEN source_name='support_tool_executions' THEN event_at ELSE event_at-(elapsed*interval '1 millisecond') END,
        CASE WHEN state<>'pending' THEN COALESCE((p->>'completed_at')::timestamp AT TIME ZONE 'UTC',event_at) END,event_at)
      ON CONFLICT DO NOTHING;
      UPDATE ai_usage_events SET status=state,duration_ms=CASE WHEN elapsed>0 THEN elapsed ELSE duration_ms END,
        completed_at=CASE WHEN state<>'pending' THEN COALESCE((p->>'completed_at')::timestamp AT TIME ZONE 'UTC',event_at) END
        WHERE business_profile_id=usage_business_id AND source_table=source_name AND source_id=source_identifier;
    END $$;
    CREATE FUNCTION insights_usage_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM insights_project_usage(TG_TABLE_NAME,to_jsonb(NEW)); RETURN NEW; END $$;

    CREATE FUNCTION insights_project_activity(p jsonb) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE contact crm_contacts%ROWTYPE; conv outreach_conversations%ROWTYPE; business_id integer:=insights_positive_int(p->>'business_profile_id');
    BEGIN
      IF p->>'type'<>'pipeline_change' OR NOT(COALESCE(p->'metadata'->>'stageType','')='won'
        OR (p->'metadata'->>'stageType' IS NULL AND p->'metadata'->>'newStatus'='won')) THEN RETURN; END IF;
      SELECT * INTO contact FROM crm_contacts WHERE id=insights_positive_int(p->>'contact_id') AND business_profile_id=business_id;
      IF contact.id IS NULL THEN RETURN; END IF;
      SELECT * INTO conv FROM outreach_conversations WHERE id=COALESCE(insights_positive_int(p->>'outreach_conversation_id'),
        CASE WHEN p->'metadata'->'insightsConversation'->>'kind'='outreach'
          THEN insights_positive_int(p->'metadata'->'insightsConversation'->>'id') END)
        AND business_profile_id=business_id AND user_id=contact.user_id;
      INSERT INTO sales_outcome_events(business_profile_id,user_id,actor_user_id,source_key,kind,contact_id,conversation_kind,conversation_id,
        channel,amount,currency,evidence,verified,occurred_at)
      VALUES(business_id,contact.user_id,COALESCE(insights_positive_int(p->'metadata'->>'actorUserId'),contact.user_id),
        'crm_activity:'||(p->>'id'),'contact_won',contact.id,CASE WHEN conv.id IS NOT NULL THEN 'outreach'
          WHEN p->'metadata'->'insightsConversation'->>'kind'='widget' AND EXISTS(SELECT 1 FROM support_chat_sessions
            WHERE id=insights_positive_int(p->'metadata'->'insightsConversation'->>'id') AND business_profile_id=business_id) THEN 'widget' END,
        COALESCE(conv.id,CASE WHEN p->'metadata'->'insightsConversation'->>'kind'='widget' AND EXISTS(SELECT 1 FROM support_chat_sessions
          WHERE id=insights_positive_int(p->'metadata'->'insightsConversation'->>'id') AND business_profile_id=business_id)
          THEN insights_positive_int(p->'metadata'->'insightsConversation'->>'id') END),
        CASE WHEN conv.id IS NOT NULL THEN insights_channel(conv.channel) WHEN p->'metadata'->'insightsConversation'->>'kind'='widget' THEN 'widget' ELSE 'unattributed' END,
        CASE WHEN p->'metadata' ? 'dealValueSnapshot' THEN insights_number(p->'metadata'->>'dealValueSnapshot') END,
        COALESCE(p->'metadata'->>'currencySnapshot',contact.currency),
        CASE WHEN p->'metadata' ? 'dealValueSnapshot' THEN 'crm' ELSE 'legacy' END,true,
        (p->>'created_at')::timestamp AT TIME ZONE 'UTC') ON CONFLICT DO NOTHING;
    END $$;
    CREATE FUNCTION insights_activity_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM insights_project_activity(to_jsonb(NEW)); RETURN NEW; END $$;
    CREATE FUNCTION insights_contact_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO sales_outcome_events(business_profile_id,user_id,actor_user_id,source_key,kind,contact_id,evidence,verified,occurred_at)
      VALUES(NEW.business_profile_id,NEW.user_id,COALESCE(insights_positive_int(current_setting('app.business_actor_user_id',true)),NEW.user_id),
        'crm_contact:'||NEW.id,'contact_created',NEW.id,'crm',true,NEW.created_at AT TIME ZONE 'UTC') ON CONFLICT DO NOTHING;
      RETURN NEW;
    END $$;
    CREATE FUNCTION insights_project_booking(p jsonb) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE conv outreach_conversations%ROWTYPE; event_kind text; event_time timestamptz;
    BEGIN
      IF p->>'status' NOT IN ('confirmed','cancelled','expired') THEN RETURN; END IF;
      event_kind:=CASE WHEN p->>'status'='confirmed' THEN 'booking_confirmed' ELSE 'booking_cancelled' END;
      event_time:=COALESCE(CASE WHEN event_kind='booking_confirmed' THEN (p->>'confirmed_at')::timestamptz ELSE (p->>'cancelled_at')::timestamptz END,
        (p->>'updated_at')::timestamp AT TIME ZONE 'UTC');
      SELECT * INTO conv FROM outreach_conversations WHERE id=insights_positive_int(p->>'outreach_conversation_id') AND business_profile_id=insights_positive_int(p->>'business_profile_id');
      INSERT INTO sales_outcome_events(business_profile_id,user_id,actor_user_id,source_key,kind,contact_id,booking_id,conversation_kind,
        conversation_id,channel,amount,currency,evidence,verified,occurred_at)
      VALUES((p->>'business_profile_id')::integer,(p->>'user_id')::integer,COALESCE(insights_positive_int(current_setting('app.business_actor_user_id',true)),(p->>'user_id')::integer),
        'booking:'||(p->>'id')||':'||event_kind,event_kind,conv.crm_contact_id,(p->>'id')::integer,
        CASE WHEN conv.id IS NOT NULL THEN 'outreach' END,conv.id,insights_channel(conv.channel),insights_number(p->>'total_price'),p->>'currency','booking',true,event_time)
        ON CONFLICT DO NOTHING;
      -- payment_status is intentionally ignored: confirmation is not payment evidence.
    END $$;
    CREATE FUNCTION insights_booking_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM insights_project_booking(to_jsonb(NEW)); RETURN NEW; END $$;
    CREATE FUNCTION insights_billing_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE c jsonb:=NEW.metadata->'_insights';
    BEGIN
      IF NEW.type='deduction' AND c IS NOT NULL THEN
        UPDATE ai_usage_events SET billing_transaction_id=NEW.id,organization_id=NEW.organization_id
          WHERE business_profile_id=NEW.billing_business_profile_id AND user_id=NEW.user_id
            AND (attempt_id=c->>'attemptId' OR (source_table=c->'usageSource'->>'table' AND source_id=c->'usageSource'->>'id'))
            AND billing_transaction_id IS NULL;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER insights_capture_activity AFTER INSERT ON crm_activities FOR EACH ROW EXECUTE FUNCTION insights_activity_trigger();
    CREATE TRIGGER insights_capture_contact AFTER INSERT ON crm_contacts FOR EACH ROW EXECUTE FUNCTION insights_contact_trigger();
    CREATE TRIGGER insights_capture_booking AFTER INSERT OR UPDATE OF status ON bookings FOR EACH ROW EXECUTE FUNCTION insights_booking_trigger();
    CREATE TRIGGER insights_capture_billing AFTER INSERT ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION insights_billing_trigger();
  `);
  for (const table of usageSources) {
    await client.query(`CREATE TRIGGER insights_capture_usage AFTER INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION insights_usage_trigger()`);
    // The projection contains only identifiers, quantities, timings, and prices.
    await client.query(`SELECT insights_project_usage($1,to_jsonb(source)) FROM ${table} source`, [table]);
  }
  await client.query(`
    SELECT insights_project_activity(to_jsonb(activity)) FROM crm_activities activity WHERE type='pipeline_change';
    SELECT insights_project_booking(to_jsonb(booking)) FROM bookings booking WHERE status IN ('confirmed','cancelled','expired');
    INSERT INTO sales_outcome_events(business_profile_id,user_id,actor_user_id,source_key,kind,contact_id,evidence,verified,occurred_at)
      SELECT business_profile_id,user_id,user_id,'crm_contact:'||id,'contact_created',id,'legacy',true,created_at AT TIME ZONE 'UTC'
      FROM crm_contacts ON CONFLICT DO NOTHING;
    ALTER TABLE openai_usages ALTER COLUMN estimated_cost_cents TYPE numeric(20,8);
    ALTER TABLE embedding_usages ALTER COLUMN estimated_cost_cents TYPE numeric(20,8), ALTER COLUMN original_cost_cents TYPE numeric(20,8);
    ALTER TABLE apify_usages ALTER COLUMN estimated_cost_cents TYPE numeric(20,8);
    ALTER TABLE gemini_usages ALTER COLUMN cost_cents TYPE numeric(20,8);
    ALTER TABLE zerobounce_usages ALTER COLUMN cost_cents TYPE numeric(20,8);
    ALTER TABLE credit_event_logs ALTER COLUMN api_cost_cents TYPE numeric(20,8);
  `);
  for (const table of ['ai_usage_events', 'sales_outcome_events']) {
    const spec = { table_name: table, owner_column: 'user_id', global_read: false, parent_links: [], legacy_business_column: null };
    await client.query('INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links) VALUES($1,$2,false,$3::jsonb)', [table, 'user_id', '[]']);
    const literal = JSON.stringify(spec).replaceAll("'", "''");
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY business_isolation ON ${table} FOR ALL
        USING(app_business_system() OR (business_profile_id=app_business_profile_id() AND
          EXISTS(SELECT 1 FROM company_settings b WHERE b.id=business_profile_id AND b.user_id=app_business_user_id())))
        WITH CHECK(app_business_system() OR (business_profile_id=app_business_profile_id() AND
          EXISTS(SELECT 1 FROM company_settings b WHERE b.id=business_profile_id AND b.user_id=app_business_user_id())));
      CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON ${table} NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO salesmarketing_business_runtime;
      GRANT USAGE,SELECT ON SEQUENCE ${table}_id_seq TO salesmarketing_business_runtime;`);
  }
}

export async function down(client) {
  for (const table of usageSources) await client.query(`DROP TRIGGER IF EXISTS insights_capture_usage ON ${table}`);
  await client.query(`
    DROP TRIGGER IF EXISTS insights_capture_activity ON crm_activities;
    DROP TRIGGER IF EXISTS insights_capture_contact ON crm_contacts;
    DROP TRIGGER IF EXISTS insights_capture_booking ON bookings;
    DROP TRIGGER IF EXISTS insights_capture_billing ON wallet_transactions;
    UPDATE workspace_insights_runtime SET enabled=false,pricing_guard_enabled=false,updated_at=now();
  `);
  // Preserve financial evidence and fractional-cent precision during a code rollback.
}
