/**
 * Organization ownership for all business data. This migration is transactional.
 * Account/auth/billing registries remain account scoped. Missing legacy ownership
 * is quarantined for review; it never becomes shared business data.
 */
const ACCOUNT_TABLES = new Set(`
  users admins company_settings account_deletion_requests user_consents user_preferences
  wallets wallet_transactions wallet_recharge_claims storage_plans storage_pricing storage_quotas
  subscription_plans subscription_settings subscription_provider_plans billing_subscriptions
  subscription_accounts subscription_charges subscription_credit_grants subscription_webhook_events subscription_audit
  admin_api_credentials admin_credential_audit admin_notifications api_pricing credit_pricing pricing_change_audit
  system_integrations system_logs platform_settings platform_modules user_module_access platform_access_audit
  policy_pages intent_classifier_credentials intent_classifier_credential_audit embedding_settings
  knowledge_index_versions knowledge_runtime_settings knowledge_migration_reconciliations
  support_agent_templates support_playbook_templates business_profile_categories business_profile_subcategories
  ai_visibility_organizations ai_visibility_workspaces ai_visibility_workspace_memberships
  failed_jobs js_migrations checkpoint_migrations __drizzle_migrations conversation_migration_156_ownership conversation_migration_157_ownership
  migration_146_super_admin_repair migration_168_instagram_oauth_credential_repair
  business_scope_tables business_scope_accounts business_scope_migration_issues proposal_template_audit
`.trim().split(/\s+/));
const IMPLICIT_LINKS = {
  content_assets: [['thread_id', 'chat_threads']],
  pixel_events: [['lead_id', 'leads']],
  apify_usages: [['thread_id', 'chat_threads']], openai_usages: [['thread_id', 'chat_threads']],
  gemini_usages: [['thread_id', 'chat_threads']], tool_approvals: [['thread_id', 'chat_threads']],
  sequence_executions: [['sequence_id', 'message_sequences'], ['lead_id', 'leads']],
  conversation_threads: [['lead_id', 'leads']], email_senders: [['credential_id', 'channel_credentials'], ['resend_domain_id', 'resend_domains']],
  paid_ad_accounts: [['credential_id', 'meta_page_connections', { credential_source: ['meta_page'] }]], youtube_analytics_snapshots: [['credential_id', 'channel_credentials']],
  conversation_requests: [
    ['conversation_id', 'chat_threads', { kind: ['campaign', 'campaign_init'] }, true],
    ['conversation_id', 'support_chat_sessions', { kind: ['support_advisory'] }, true],
  ],
  workflow_executions: [['workflow_id', 'workflows']], performance_metrics: [['campaign_id', 'performance_ad_campaigns']],
  system_alerts: [['ticket_id', 'support_tickets']], ai_visibility_reports: [['storage_file_id', 'storage_files']],
  ai_visibility_commerce_snapshots: [['storage_file_id', 'storage_files']],
  chat_summaries: [['from_message_id', 'chat_messages'], ['to_message_id', 'chat_messages']],
  connection_mappings: [['workflow_id','workflows']], db_save_mappings: [['workflow_id','workflows']],
  field_mappings: [['connection_mapping_id','connection_mappings']],
  array_iteration_configs: [['connection_mapping_id','connection_mappings']],
  checkpoints: [['thread_id','chat_threads']], checkpoint_blobs: [['thread_id','chat_threads']], checkpoint_writes: [['thread_id','chat_threads']],
};
const SPECIAL_TABLES = new Set(`lead_gen_campaigns connection_mappings field_mappings array_iteration_configs
  db_save_mappings checkpoints checkpoint_blobs checkpoint_writes conversation_request_scopes proposal_template_audit`.split(/\s+/));
const GLOBAL_READ_TABLES = new Set(['proposal_templates', 'content_templates', 'content_template_versions']);
// In these tables user_id is an approver/member, not the business owner.
const ACTOR_TABLES = new Set(['content_approval_stage_approvers']);
const q = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const linkPredicate = link => [
  ...Object.entries(link.when || {}).map(([column, values]) => `c.${q(column)}::text IN (${values.map(literal).join(',')})`),
  ...(link.positive ? [`c.${q(link.child_columns[0])}>0`] : []),
].map(clause => ` AND ${clause}`).join('');

export async function up(client) {
  // Previously created lazily by the ingestion service. Create it before the
  // ownership inventory so even the first event uses the same isolation rules.
  await client.query(`CREATE TABLE IF NOT EXISTS pixel_events (
    id SERIAL PRIMARY KEY, event_type VARCHAR(50) NOT NULL, event_name VARCHAR(100),
    user_id INTEGER, session_id VARCHAR(255), lead_id INTEGER, campaign_id INTEGER,
    ad_id VARCHAR(255), url TEXT, referrer TEXT, utm_source VARCHAR(100), utm_medium VARCHAR(100),
    utm_campaign VARCHAR(100), utm_content VARCHAR(100), utm_term VARCHAR(100),
    ip_address VARCHAR(50), user_agent TEXT, device_type VARCHAR(20), browser VARCHAR(50), os VARCHAR(50),
    properties JSONB, value NUMERIC(10,2), currency VARCHAR(3), timestamp TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  const { rows: tables } = await client.query(`SELECT c.relname AS name,
    ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'`);
  const byName = new Map(tables.map(table => [table.name, table]));
  const { rows: relations } = await client.query(`SELECT c.conname, c.conrelid::regclass::text AS child,
    c.confrelid::regclass::text AS parent,
    ARRAY(SELECT attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY ord) AS child_columns,
    ARRAY(SELECT attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY ord) AS parent_columns
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.contype='f' AND n.nspname='public'`);
  const scoped = new Set(tables.filter(t => !ACCOUNT_TABLES.has(t.name)
    && (SPECIAL_TABLES.has(t.name) || t.columns.some(c => ['user_id','owner_user_id','business_profile_id'].includes(c)))).map(t => t.name));
  let changed = true;
  while (changed) {
    changed = false;
    for (const rel of relations) if (!ACCOUNT_TABLES.has(rel.child) && scoped.has(rel.parent) && !scoped.has(rel.child)) {
      scoped.add(rel.child); changed = true;
    }
  }
  const unclassified = tables.filter(t => !ACCOUNT_TABLES.has(t.name) && !scoped.has(t.name));
  if (unclassified.length) throw new Error(`Classify database ownership before migrating: ${unclassified.map(t => t.name).join(', ')}`);

  await client.query(`CREATE TABLE business_scope_tables (
    table_name TEXT PRIMARY KEY, owner_column TEXT, global_read BOOLEAN NOT NULL DEFAULT FALSE,
    parent_links JSONB NOT NULL DEFAULT '[]', legacy_business_column TEXT
  ); CREATE TABLE business_scope_accounts(table_name TEXT PRIMARY KEY);
  CREATE TABLE business_scope_migration_issues (
    table_name TEXT PRIMARY KEY, unassigned_count BIGINT NOT NULL, reason TEXT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  for (const table of ACCOUNT_TABLES) await client.query('INSERT INTO business_scope_accounts(table_name) VALUES($1)', [table]);
  await client.query(`CREATE OR REPLACE FUNCTION app_business_profile_id() RETURNS INTEGER LANGUAGE sql STABLE AS
    $$ SELECT NULLIF(current_setting('app.business_profile_id', true), '')::integer $$;
    CREATE OR REPLACE FUNCTION app_business_system() RETURNS BOOLEAN LANGUAGE sql STABLE AS
    $$ SELECT COALESCE(current_setting('app.business_system', true) = 'on', false) $$;
    CREATE OR REPLACE FUNCTION app_business_user_id() RETURNS INTEGER LANGUAGE sql STABLE AS
    $$ SELECT NULLIF(current_setting('app.current_user_id', true), '')::integer $$`);

  // Lock the full graph before filling ownership. Audit immutability triggers
  // are suspended only for this transactional metadata backfill.
  for (const name of [...scoped].sort()) {
    await client.query(`LOCK TABLE ${q(name)} IN ACCESS EXCLUSIVE MODE`);
    await client.query(`ALTER TABLE ${q(name)} DISABLE TRIGGER USER`);
    await client.query(`ALTER TABLE ${q(name)} ADD COLUMN IF NOT EXISTS business_profile_id INTEGER`);
  }
  await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS legacy_webhook_profile BOOLEAN NOT NULL DEFAULT FALSE`);
  await client.query(`UPDATE company_settings SET legacy_webhook_profile=TRUE WHERE id IN
    (SELECT DISTINCT ON(user_id) id FROM company_settings ORDER BY user_id,is_default DESC,id)`);
  // A deterministic legacy workspace also handles old accounts without setup.
  await client.query(`INSERT INTO company_settings(user_id,name,company_name,is_default)
    SELECT u.id,'My business','My business',TRUE FROM users u
    WHERE NOT EXISTS(SELECT 1 FROM company_settings p WHERE p.user_id=u.id)`);
  await client.query(`UPDATE company_settings SET legacy_webhook_profile=TRUE WHERE id IN
    (SELECT DISTINCT ON(user_id) id FROM company_settings ORDER BY user_id,is_default DESC,id)
    AND NOT EXISTS(SELECT 1 FROM company_settings old WHERE old.user_id=company_settings.user_id AND old.legacy_webhook_profile)`);

  // Historical research projects belong to their account's legacy business.
  // Preserve them as archived when an explicitly bound active project already
  // occupies that business's single active-project slot. IDs and reports survive.
  await client.query(`UPDATE ai_visibility_projects project SET status='archived'
    FROM company_settings profile WHERE profile.legacy_webhook_profile
      AND profile.user_id=project.user_id AND project.business_profile_id IS NULL
      AND project.status='active' AND EXISTS (
        SELECT 1 FROM ai_visibility_projects active WHERE active.user_id=project.user_id
          AND active.business_profile_id=profile.id AND active.status='active')`);
  // Provider actor IDs are evidence of ownership only when exactly one
  // account owns the matching connection. Ambiguous/unmatched diagnostics stay private.
  for (const table of ['instagram_webhook_events','webhook_events']) {
    await client.query(`UPDATE ${q(table)} event SET user_id=owner.user_id FROM (
      SELECT event.id,MIN(connection.user_id) AS user_id FROM ${q(table)} event
      JOIN meta_page_connections connection ON event.page_id=connection.page_id
        OR event.page_id=connection.instagram_account_id
      WHERE event.user_id IS NULL
      GROUP BY event.id HAVING COUNT(DISTINCT connection.user_id)=1
    ) owner WHERE event.id=owner.id AND event.user_id IS NULL`);
  }

  for (const name of scoped) {
    const table = byName.get(name);
    const owner = ACTOR_TABLES.has(name) ? null : table.columns.includes('user_id') ? 'user_id' : table.columns.includes('owner_user_id') ? 'owner_user_id' : null;
    const links = relations.filter(r => r.child === name && scoped.has(r.parent) );
    // Parent table IDs that predate declared FKs.
    for (const [column, parent, when, positive] of IMPLICIT_LINKS[name] || []) {
      if (table.columns.includes(column) && scoped.has(parent)
        && !links.some(link => link.parent===parent && link.child_columns.length===1 && link.child_columns[0]===column)) {
        links.push({ child:name, parent, child_columns:[column], parent_columns:['id'], when, positive });
      }
    }
    await client.query(`INSERT INTO business_scope_tables VALUES($1,$2,$3,$4::jsonb,$5)`, [name, owner,
      GLOBAL_READ_TABLES.has(name), JSON.stringify(links), table.columns.includes('business_id') && ['chat_threads','icp_profiles'].includes(name) ? 'business_id' : null]);
    if (table.columns.includes('business_id') && ['chat_threads','icp_profiles'].includes(name)) {
      await client.query(`UPDATE ${q(name)} SET business_profile_id=business_id WHERE business_profile_id IS NULL AND business_id IS NOT NULL`);
    }
    if (name === 'company_profiles') {
      await client.query(`UPDATE company_profiles c SET business_profile_id=p.id FROM company_settings p
        WHERE p.legacy_company_profile_id=c.id AND p.user_id=c.user_id AND c.business_profile_id IS NULL`);
    }
  }
  // Resolve the graph to a fixed point before falling back to an account's old
  // default. This preserves non-default businesses already attached to threads.
  // A child row whose account owner contradicts its parent is left unassigned
  // for admin review instead of being moved across accounts.
  async function propagate() {
    let total;
    do {
      total = 0;
      const { rows: manifest } = await client.query('SELECT * FROM business_scope_tables ORDER BY table_name');
      for (const t of manifest) for (const link of t.parent_links) {
        const match = link.child_columns.map((col,i) => `c.${q(col)}::text=p.${q(link.parent_columns[i])}::text`).join(' AND ');
        const ownerMatch = t.owner_column
          ? `AND (c.${q(t.owner_column)} IS NULL OR EXISTS(
              SELECT 1 FROM company_settings profile_owner
              WHERE profile_owner.id=p.business_profile_id
                AND profile_owner.user_id=c.${q(t.owner_column)}
            ))`
          : '';
        const result = await client.query(`UPDATE ${q(t.table_name)} c SET business_profile_id=p.business_profile_id
          FROM ${q(link.parent)} p WHERE ${match}${linkPredicate(link)} AND c.business_profile_id IS NULL
            AND p.business_profile_id IS NOT NULL ${ownerMatch}`);
        total += result.rowCount;
      }
    } while (total > 0);
  }
  await propagate();
  const { rows: manifest } = await client.query('SELECT * FROM business_scope_tables ORDER BY table_name');
  // Roots first, then descendants. Filling every child directly from user_id
  // would sever a non-default parent's ownership.
  for (let pass = 0; pass < 2; pass++) {
    for (const t of manifest) if (t.owner_column && (pass === 1 || t.parent_links.length === 0)) {
      const legacyProjectGuard = t.table_name === 'ai_visibility_projects'
        ? `AND (c.status <> 'active' OR NOT EXISTS (
            SELECT 1 FROM ai_visibility_projects existing
            WHERE existing.user_id=c.user_id AND existing.business_profile_id=p.id
              AND existing.status='active' AND existing.id<>c.id
          ))`
        : '';
      const parentOwnershipGuard = t.parent_links.map(link => {
        const match = link.child_columns.map((col,i) => `c.${q(col)}::text=parent_row.${q(link.parent_columns[i])}::text`).join(' AND ');
        return `AND NOT EXISTS (
          SELECT 1 FROM ${q(link.parent)} parent_row
          JOIN company_settings profile_owner ON profile_owner.id=parent_row.business_profile_id
          WHERE ${match}${linkPredicate(link)} AND parent_row.business_profile_id IS NOT NULL
            AND c.${q(t.owner_column)} IS NOT NULL
            AND profile_owner.user_id<>c.${q(t.owner_column)}
        )`;
      }).join(' ');
      await client.query(`UPDATE ${q(t.table_name)} c SET business_profile_id=p.id FROM
        (SELECT DISTINCT ON(user_id) id,user_id FROM company_settings ORDER BY user_id,is_default DESC,id) p
        WHERE c.${q(t.owner_column)}=p.user_id AND c.business_profile_id IS NULL
          ${legacyProjectGuard} ${parentOwnershipGuard}`);
    }
    await propagate();
  }
  if (scoped.has('conversation_request_scopes')) {
    await client.query(`UPDATE conversation_request_scopes s SET business_profile_id=r.business_profile_id
      FROM conversation_requests r WHERE r.scope_key=s.scope_key AND r.business_profile_id IS NOT NULL AND s.business_profile_id IS NULL`);
  }
  // Old lease keys contain the owner as their first numeric component.
  if (scoped.has('conversation_request_scopes')) await client.query(`UPDATE conversation_request_scopes c SET business_profile_id=p.id FROM
    (SELECT DISTINCT ON(user_id) id,user_id FROM company_settings ORDER BY user_id,is_default DESC,id) p
    WHERE split_part(c.scope_key,':',1)=p.user_id::text AND c.business_profile_id IS NULL`);
  await propagate();

  // Retain completed responses and uncertain request receipts under the new
  // business-qualified key. Renaming only one side would lose retry recovery.
  if (scoped.has('conversation_request_scopes')) {
    const { rows: leaseForeignKeys } = await client.query(`SELECT conrelid::regclass::text AS table_name,
      conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE contype='f' AND confrelid='conversation_request_scopes'::regclass`);
    for (const fk of leaseForeignKeys) await client.query(`ALTER TABLE ${q(fk.table_name)} DROP CONSTRAINT ${q(fk.conname)}`);
    for (const table of ['conversation_requests', 'conversation_request_scopes']) {
      await client.query(`UPDATE ${q(table)} SET scope_key=regexp_replace(scope_key, '^([0-9]+):', E'\\\\1:'||business_profile_id::text||':')
        WHERE business_profile_id IS NOT NULL AND split_part(scope_key,':',2) !~ '^[0-9]+$'`);
    }
    for (const fk of leaseForeignKeys) await client.query(`ALTER TABLE ${q(fk.table_name)} ADD CONSTRAINT ${q(fk.conname)} ${fk.definition}`);
  }

  for (const t of manifest) {
    const name = t.table_name;
    // Reject contradictory existing ownership instead of moving live data.
    if (t.owner_column) {
      const invalid = await client.query(`SELECT 1 FROM ${q(name)} c LEFT JOIN company_settings p ON p.id=c.business_profile_id
        WHERE c.business_profile_id IS NOT NULL AND (p.id IS NULL OR (c.${q(t.owner_column)} IS NOT NULL AND c.${q(t.owner_column)}<>p.user_id)) LIMIT 1`);
      if (invalid.rowCount) throw new Error(`Business ownership conflict in ${name}; reconcile before migration`);
    }
    for (const link of t.parent_links) {
      const match = link.child_columns.map((col,i) => `c.${q(col)}::text=p.${q(link.parent_columns[i])}::text`).join(' AND ');
      const conflict = await client.query(`SELECT 1 FROM ${q(name)} c JOIN ${q(link.parent)} p ON ${match}
        WHERE c.business_profile_id IS NOT NULL AND p.business_profile_id IS NOT NULL AND c.business_profile_id<>p.business_profile_id${linkPredicate(link)} LIMIT 1`);
      if (conflict.rowCount) throw new Error(`Conflicting business ownership: ${name} -> ${link.parent}; reconcile before migration`);
    }
    const unassigned = await client.query(`SELECT count(*)::integer AS count FROM ${q(name)} WHERE business_profile_id IS NULL
      ${t.global_read ? 'AND user_id IS NOT NULL' : ''}`);
    if (unassigned.rows[0].count) await client.query(`INSERT INTO business_scope_migration_issues VALUES($1,$2,$3,NOW())`, [name, unassigned.rows[0].count, 'Legacy ownership could not be established; rows are visible only to system administrators.']);
    await client.query(`ALTER TABLE ${q(name)} ALTER COLUMN business_profile_id SET DEFAULT app_business_profile_id()`);
    // Keep NULL only for quarantined legacy data and explicitly global templates.
    // The trigger below forbids new unowned business records.
    for (const rel of relations.filter(r => r.child===name && r.parent==='company_settings' && r.child_columns.some(c => ['business_profile_id','business_id'].includes(c)))) {
      await client.query(`ALTER TABLE ${q(name)} DROP CONSTRAINT ${q(rel.conname)}`);
    }
    await client.query(`ALTER TABLE ${q(name)} ADD CONSTRAINT ${q(name.slice(0,39)+'_business_owner_fk')}
      FOREIGN KEY(business_profile_id) REFERENCES company_settings(id) ON DELETE RESTRICT`);
    await client.query(`CREATE INDEX ${q(name.slice(0,40)+'_business_scope_idx')} ON ${q(name)}(business_profile_id)`);

    // User-keyed settings, defaults, names and idempotency keys are per business.
    // Preserve the old uniqueness only when another FK references that index.
    const { rows: indexes } = await client.query(`SELECT i.indexrelid,ci.relname AS name,pg_get_indexdef(i.indexrelid) AS definition,
      con.conname,con.contype,EXISTS(SELECT 1 FROM pg_constraint f WHERE f.contype='f' AND f.conindid=i.indexrelid) AS referenced
      FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid LEFT JOIN pg_constraint con ON con.conindid=i.indexrelid AND con.contype IN('p','u')
      WHERE i.indrelid=$1::regclass AND i.indisunique AND EXISTS(SELECT 1 FROM pg_attribute a
        WHERE a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) AND a.attname IN('user_id','owner_user_id'))
      AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) AND a.attname IN('id','business_profile_id'))`, [name]);
    for (const index of indexes) {
      const suffix = index.definition.slice(index.definition.indexOf(' USING ')).replace(/(USING \w+ \()/, '$1business_profile_id, ');
      if (!index.referenced) {
        if (index.conname) await client.query(`ALTER TABLE ${q(name)} DROP CONSTRAINT ${q(index.conname)}`);
        else await client.query(`DROP INDEX ${q(index.name)}`);
      }
      const indexName = index.referenced ? index.name.slice(0,49)+'_business_uq' : index.name;
      await client.query(`CREATE UNIQUE INDEX ${q(indexName)} ON ${q(name)}${suffix}`);
      if (index.contype === 'p' && !index.referenced) await client.query(`ALTER TABLE ${q(name)} ADD PRIMARY KEY USING INDEX ${q(indexName)}`);
    }
  }

  const { rows: routines } = await client.query(`SELECT p.oid, pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'`);
  for (const routine of routines) {
    let definition = routine.definition;
    const mentionsBusiness = [...scoped].some(name => new RegExp('\\b'+name+'\\b').test(definition));
    if (!mentionsBusiness) continue;
    definition = definition.replace(/SECURITY DEFINER/gi, 'SECURITY INVOKER');
    definition = definition.replace(/ON\s+CONFLICT\s*\(([^)]+)\)/gi, (whole, columns, offset) => {
      if (!/\b(user_id|owner_user_id)\b/.test(columns) || /\bbusiness_profile_id\b/.test(columns)) return whole;
      const inserts = [...definition.slice(0,offset).matchAll(/INSERT\s+INTO\s+(?:public\.)?([a-z_]+)/gi)];
      return inserts.length && scoped.has(inserts.at(-1)[1]) ? `ON CONFLICT (business_profile_id, ${columns})` : whole;
    });
    if (definition !== routine.definition) await client.query(definition);
  }

  // Validate foreign references under RLS, including raw SQL inserts. A normal
  // FK alone bypasses RLS and would accept another business's numeric ID.
  await client.query(`CREATE OR REPLACE FUNCTION enforce_business_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE spec jsonb := TG_ARGV[0]::jsonb; row_data jsonb := to_jsonb(NEW); old_data jsonb;
    parent_profile integer; parent_row jsonb; link jsonb; match_sql text; owner_id integer; idx integer;
    condition_key text; condition_values jsonb; applies boolean;
  BEGIN
    IF TG_OP='INSERT' THEN NEW.business_profile_id:=COALESCE(NEW.business_profile_id,app_business_profile_id()); END IF;
    IF TG_OP='UPDATE' THEN
      old_data:=to_jsonb(OLD);
      IF (old_data->>'business_profile_id')::integer IS DISTINCT FROM NEW.business_profile_id THEN
        RAISE EXCEPTION 'Business ownership cannot be changed' USING ERRCODE='23514';
      END IF;
    END IF;
    IF spec->>'legacy_business_column' IS NOT NULL THEN
      parent_profile:=NULLIF(row_data->>(spec->>'legacy_business_column'),'')::integer;
      IF parent_profile IS NOT NULL AND NEW.business_profile_id IS NOT NULL AND parent_profile<>NEW.business_profile_id THEN
        RAISE EXCEPTION 'Business profile does not match the selected business' USING ERRCODE='23514';
      END IF;
      NEW.business_profile_id:=COALESCE(NEW.business_profile_id,parent_profile);
    END IF;
    FOR link IN SELECT * FROM jsonb_array_elements(spec->'parent_links') LOOP
      applies:=TRUE;
      FOR condition_key,condition_values IN SELECT * FROM jsonb_each(COALESCE(link->'when','{}'::jsonb)) LOOP
        IF NOT COALESCE(condition_values ? (row_data->>condition_key),FALSE) THEN applies:=FALSE; END IF;
      END LOOP;
      IF COALESCE((link->>'positive')::boolean,FALSE) AND COALESCE((row_data->>(link->'child_columns'->>0))::bigint,0)<=0 THEN applies:=FALSE; END IF;
      IF NOT applies THEN CONTINUE; END IF;
      match_sql:='';
      FOR idx IN 0..jsonb_array_length(link->'child_columns')-1 LOOP
        IF row_data->>(link->'child_columns'->>idx) IS NULL THEN match_sql:=''; EXIT; END IF;
        IF idx>0 THEN match_sql:=match_sql||' AND '; END IF;
        match_sql:=match_sql||format('%I::text=%L',link->'parent_columns'->>idx,row_data->>(link->'child_columns'->>idx));
      END LOOP;
      IF match_sql<>'' THEN
        EXECUTE format('SELECT to_jsonb(p) FROM %I p WHERE %s',link->>'parent',match_sql) INTO parent_row;
        IF parent_row IS NULL THEN RAISE EXCEPTION 'Related record is not available in this business' USING ERRCODE='23503'; END IF;
        parent_profile:=(parent_row->>'business_profile_id')::integer;
        IF parent_profile IS NOT NULL AND NEW.business_profile_id IS NOT NULL AND parent_profile<>NEW.business_profile_id THEN
          RAISE EXCEPTION 'Related records must belong to the same business' USING ERRCODE='23514';
        END IF;
        NEW.business_profile_id:=COALESCE(NEW.business_profile_id,parent_profile);
      END IF;
    END LOOP;
    IF NEW.business_profile_id IS NULL THEN
      IF app_business_system() AND (spec->>'global_read')::boolean AND row_data->>'user_id' IS NULL THEN RETURN NEW; END IF;
      -- Unverified/unroutable callbacks are administrative telemetry only.
      -- They have no tenant owner and the business RLS policy never exposes them.
      IF app_business_system() AND TG_TABLE_NAME='webhook_events' AND row_data->>'user_id' IS NULL THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'A business profile is required' USING ERRCODE='23514';
    END IF;
    SELECT user_id INTO owner_id FROM company_settings WHERE id=NEW.business_profile_id;
    IF owner_id IS NULL THEN RAISE EXCEPTION 'Business profile not found' USING ERRCODE='23503'; END IF;
    IF spec->>'owner_column' IS NOT NULL AND row_data->>(spec->>'owner_column') IS NOT NULL
      AND (row_data->>(spec->>'owner_column'))::integer<>owner_id THEN
      RAISE EXCEPTION 'Business profile belongs to a different account' USING ERRCODE='23514';
    END IF;
    IF NOT app_business_system() AND (NEW.business_profile_id IS DISTINCT FROM app_business_profile_id() OR owner_id IS DISTINCT FROM app_business_user_id()) THEN
      RAISE EXCEPTION 'Business profile access denied' USING ERRCODE='42501';
    END IF;
    IF spec->>'legacy_business_column' IS NOT NULL THEN
      NEW:=jsonb_populate_record(NEW,jsonb_build_object(spec->>'legacy_business_column',NEW.business_profile_id));
    END IF;
    RETURN NEW;
  END $$`);

  for (const t of manifest) {
    const name = t.table_name;
    await client.query(`CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${q(name)}
      FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership(${"'"+JSON.stringify(t).replaceAll("'","''")+"'"})`);
    await client.query(`CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON ${q(name)}
      NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership(${"'"+JSON.stringify(t).replaceAll("'","''")+"'"})`);
    await client.query(`ALTER TABLE ${q(name)} ENABLE TRIGGER USER`);
    const { rows: policies } = await client.query('SELECT policyname FROM pg_policies WHERE schemaname=\'public\' AND tablename=$1', [name]);
    for (const policy of policies) await client.query(`DROP POLICY ${q(policy.policyname)} ON ${q(name)}`);
    await client.query(`ALTER TABLE ${q(name)} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${q(name)} FORCE ROW LEVEL SECURITY`);
    const access = `(app_business_system() OR (business_profile_id=app_business_profile_id() AND
      EXISTS(SELECT 1 FROM company_settings b WHERE b.id=business_profile_id AND b.user_id=app_business_user_id())))`;
    await client.query(`CREATE POLICY business_isolation ON ${q(name)} FOR ALL USING ${access} WITH CHECK ${access}`);
    if (t.global_read) {
      const published = name === 'content_templates' ? ' AND is_predefined=TRUE AND is_approved=TRUE'
        : name === 'content_template_versions' ? ` AND snapshot->>'isApproved'='true' AND EXISTS(
          SELECT 1 FROM content_templates p WHERE p.id=template_id AND p.user_id IS NULL AND p.business_profile_id IS NULL AND p.is_predefined=TRUE AND p.is_approved=TRUE)` : '';
      await client.query(`CREATE POLICY global_template_read ON ${q(name)} FOR SELECT USING (business_profile_id IS NULL AND user_id IS NULL${published})`);
    }
  }
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='salesmarketing_business_runtime') THEN
      CREATE ROLE salesmarketing_business_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='salesmarketing_business_runtime' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
      RAISE EXCEPTION 'Business runtime role must be NOLOGIN, NOSUPERUSER and NOBYPASSRLS';
    END IF;
  END $$`);
  await client.query('GRANT salesmarketing_business_runtime TO CURRENT_USER');
  const runtimeUser = process.env.DB_RUNTIME_USER || process.env.DB_USER;
  if (runtimeUser) await client.query(`GRANT salesmarketing_business_runtime TO ${q(runtimeUser)}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO salesmarketing_business_runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO salesmarketing_business_runtime;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO salesmarketing_business_runtime;
    REVOKE INSERT,UPDATE,DELETE ON business_scope_tables,business_scope_accounts,business_scope_migration_issues FROM salesmarketing_business_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM salesmarketing_business_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM salesmarketing_business_runtime`);
}
export async function down() {
  throw new Error('Business ownership cannot be safely removed. Restore the pre-migration backup or use a reviewed forward migration.');
}

// Preflight must refuse this batch before any down SQL executes.
export const irreversible = true;
