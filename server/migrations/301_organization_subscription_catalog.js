/** Preserve every existing money record; organization IDs add billing ownership. */
export async function up(db) {
  await db.query(`
    CREATE TABLE subscription_catalogs (
      version integer PRIMARY KEY, status text NOT NULL CHECK(status IN('draft','published','retired')),
      created_by integer REFERENCES admins(id), created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
    );
    INSERT INTO subscription_catalogs(version,status,published_at) VALUES(1,'published',now()),(2,'draft',NULL);
    ALTER TABLE subscription_settings ADD COLUMN published_catalog_version integer NOT NULL DEFAULT 1 REFERENCES subscription_catalogs(version),
      ADD COLUMN capacity_enforced boolean NOT NULL DEFAULT false;
    ALTER TABLE subscription_plans ADD COLUMN description text NOT NULL DEFAULT '',
      ADD COLUMN limits jsonb NOT NULL DEFAULT '{}', ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
      ADD COLUMN featured boolean NOT NULL DEFAULT false, ADD COLUMN finder_min_score integer NOT NULL DEFAULT 0,
      ADD COLUMN finder_max_score integer;
    UPDATE subscription_plans SET description='Your original credit plan.',
      sort_order=CASE slug WHEN 'starter' THEN 0 WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 WHEN 'popular' THEN 3 WHEN 'pro' THEN 4 ELSE 5 END,
      finder_min_score=CASE slug WHEN 'starter' THEN 0 WHEN 'basic' THEN 3 WHEN 'standard' THEN 5 WHEN 'popular' THEN 7 WHEN 'pro' THEN 10 ELSE 13 END,
      finder_max_score=CASE slug WHEN 'starter' THEN 2 WHEN 'basic' THEN 4 WHEN 'standard' THEN 6 WHEN 'popular' THEN 9 WHEN 'pro' THEN 12 ELSE NULL END,
      featured=(slug='popular');
  `);
  const limitKeys=['businessProfiles','workspaces','contacts','storageBytes','channelAccounts','aiAssistants','members','supportAgents','supportTeams','automations','knowledgeSources'];
  const plans=[
    ['starter','Starter','One business. A focused start for your team.',50000,480000,5000,[1,1,5000,2e9,3,1,2,2,1,5,20],0,false,0,6],
    ['growth','Growth','Room for growing businesses and a busy pipeline.',150000,1440000,15000,[5,5,30000,10e9,10,5,5,10,5,25,100],1,true,7,10],
    ['scale','Scale','Shared capacity for a larger portfolio of businesses.',500000,4800000,50000,[20,20,100000,50e9,30,20,20,25,15,100,500],2,false,11,null],
  ];
  for(const [slug,name,description,monthly,yearly,credits,limits,sort,featured,min,max] of plans) {
    await db.query(`INSERT INTO subscription_plans(version,slug,name,description,monthly_amount_paise,yearly_amount_paise,monthly_credits,limits,sort_order,featured,finder_min_score,finder_max_score)
      VALUES(2,$1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`,[slug,name,description,monthly,yearly,credits,JSON.stringify(Object.fromEntries(limitKeys.map((key,i)=>[key,limits[i]]))),sort,featured,min,max]);
  }
  const ledgerTables=['wallets','wallet_transactions','wallet_recharge_claims','subscription_accounts','billing_subscriptions','subscription_charges','subscription_credit_grants','subscription_audit','credit_event_logs'];
  for(const table of ledgerTables) {
    // Legacy deployments may have immutability triggers. Metadata-only backfill is transactional.
    await db.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await db.query(`ALTER TABLE ${table} ADD COLUMN organization_id integer REFERENCES billing_organizations(id)`);
    await db.query(`UPDATE ${table} t SET organization_id=o.id FROM billing_organizations o WHERE o.default_for_user_id=t.user_id`);
    if(table!=='subscription_audit') await db.query(`ALTER TABLE ${table} ALTER COLUMN organization_id SET NOT NULL`);
    await db.query(`CREATE INDEX ${table}_organization_idx ON ${table}(organization_id)`);
    await db.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
  await db.query(`
    ALTER TABLE billing_subscriptions ADD COLUMN organization_bound boolean NOT NULL DEFAULT false;
    ALTER TABLE wallet_transactions ADD COLUMN actor_user_id integer REFERENCES users(id), ADD COLUMN billing_business_profile_id integer REFERENCES company_settings(id);
    UPDATE wallet_transactions SET actor_user_id=user_id;
    ALTER TABLE subscription_accounts DROP CONSTRAINT subscription_accounts_pkey;
    ALTER TABLE subscription_accounts ADD PRIMARY KEY(organization_id);
  `);
  const constraints=await db.query(`SELECT conname FROM pg_constraint WHERE conrelid='wallets'::regclass AND contype='u' AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='wallets'::regclass AND attname='user_id')]::smallint[]`);
  for(const {conname} of constraints.rows) await db.query(`ALTER TABLE wallets DROP CONSTRAINT "${conname.replaceAll('"','""')}"`);
  await db.query(`CREATE UNIQUE INDEX wallets_organization_uq ON wallets(organization_id)`);
  // Compatibility for inserts outside CreditService: each business owns a fixed payer.
  await db.query(`CREATE FUNCTION billing_ledger_organization() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE profile_id integer; resolved_org integer;
    BEGIN
      IF NEW.organization_id IS NULL THEN
        profile_id=CASE WHEN TG_TABLE_NAME='credit_event_logs' THEN (to_jsonb(NEW)->>'business_profile_id')::integer ELSE app_business_profile_id() END;
        IF profile_id IS NOT NULL THEN SELECT billing_organization_id INTO resolved_org FROM company_settings WHERE id=profile_id AND user_id=NEW.user_id; END IF;
        NEW.organization_id=COALESCE(resolved_org,app_billing_organization_id(),billing_default_organization(NEW.user_id));
      END IF;
      IF TG_TABLE_NAME='wallet_transactions' THEN
        NEW.actor_user_id=COALESCE(NEW.actor_user_id,app_billing_actor_user_id(),NEW.user_id);
        NEW.billing_business_profile_id=COALESCE(NEW.billing_business_profile_id,app_business_profile_id());
      END IF;
      RETURN NEW;
    END $$;
  `);
  for(const table of ledgerTables.filter(t=>t!=='subscription_audit')) await db.query(`CREATE TRIGGER billing_ledger_organization BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION billing_ledger_organization()`);
  await db.query(`
    INSERT INTO business_scope_accounts(table_name) VALUES('subscription_catalogs') ON CONFLICT DO NOTHING;
    GRANT SELECT,INSERT,UPDATE,DELETE ON subscription_catalogs TO salesmarketing_business_runtime;
    CREATE FUNCTION billing_catalog_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM subscription_catalogs WHERE version=OLD.version AND status<>'draft'))
        OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM subscription_catalogs WHERE version=NEW.version AND status<>'draft')) THEN
        RAISE EXCEPTION 'Published catalog versions are immutable' USING ERRCODE='23514';
      END IF;
      RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
    END $$;
    CREATE TRIGGER billing_catalog_immutable BEFORE INSERT OR UPDATE OR DELETE ON subscription_plans FOR EACH ROW EXECUTE FUNCTION billing_catalog_immutable();
  `);
}
export async function down() { throw new Error('Organization billing stores financial history; restore a reviewed backup instead of dropping it.'); }

// Preflight must refuse this batch before any down SQL executes.
export const irreversible = true;
