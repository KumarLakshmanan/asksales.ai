import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool, defaults as pgDefaults, types as pgTypes } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { DEFAULT_CRM_CONFIGURATION, type CrmConfiguration } from '../../shared/crmConfiguration.js';
import { and, eq, isNull } from 'drizzle-orm';
import { crmContactsTable } from '../models/crmContacts/schema.js';

// Opt-in local QA creates and drops only its own randomly named schema.
const localPostgres = process.env.CRM_CONFIG_LOCAL_QA === '1' ? describe : describe.skip;
let database: NodePgDatabase;
const proxy = new Proxy({} as NodePgDatabase, {
  get(_target, key) {
    const value = database[key as keyof NodePgDatabase];
    return typeof value === 'function' ? value.bind(database) : value;
  },
});
jest.unstable_mockModule('../models/db.js', () => ({ db: proxy }));
jest.unstable_mockModule('../services/SentimentAnalysisService', () => ({ sentimentAnalysisService: {} }));
const fireEvent = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../services/AlertService', () => ({ alertService: { fireEvent } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
const { getCrmConfiguration, saveCrmConfiguration } = await import('../services/CRMConfigurationService.js');
const { crmService } = await import('../services/CRMService.js');
// @ts-expect-error JavaScript migration modules are executed by the custom runner.
const migration = await import('../migrations/312_crm_configuration.js');
const inProfile = <T>(profile: number, work: () => T) => withBusinessScope({ userId: 9, businessProfileId: profile }, work);

localPostgres('CRM configuration and analytics in isolated local PostgreSQL', () => {
  let admin: Pool;
  let fixturePool: Pool;
  let runtimePool: Pool;
  let schema: string;
  const originalUtcInput = pgDefaults.parseInputDatesAsUTC;
  const originalTimestampParser = pgTypes.getTypeParser(1114);

  beforeAll(async () => {
    // The db mock skips the production UTC driver setup; mirror that convention.
    pgDefaults.parseInputDatesAsUTC = true;
    pgTypes.setTypeParser(1114, (value: string) => new Date(`${value}Z`));
    dotenv.config({ path: resolve(process.cwd(), '.env.development'), override: true, quiet: true });
    dotenv.config({ path: resolve(process.cwd(), '.env'), override: true, quiet: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('CRM configuration QA requires local PostgreSQL.');
    const connection = {
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME || process.env.DB_DATABASE,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000,
    };
    schema = `crm_configuration_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...connection, max: 1, options: '-c search_path=pg_catalog -c timezone=UTC' });
    await admin.query(`CREATE SCHEMA ${schema}`);
    fixturePool = new Pool({ ...connection, max: 1, options: `-c search_path=${schema},pg_catalog -c timezone=UTC` });
    runtimePool = createBusinessScopedPool(new Pool({ ...connection, max: 2, options: `-c search_path=${schema},pg_catalog -c timezone=UTC` }));
    database = drizzle(runtimePool);
    await fixturePool.query(`
      CREATE TABLE company_settings (id integer PRIMARY KEY, user_id integer NOT NULL, updated_at timestamptz DEFAULT now());
      CREATE TABLE leads (LIKE public.leads INCLUDING DEFAULTS INCLUDING GENERATED);
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS business_profile_id integer;
      ALTER TABLE leads ALTER COLUMN uuid SET DEFAULT gen_random_uuid();
      ALTER TABLE leads ALTER COLUMN source SET DEFAULT 'fixture';
      CREATE SEQUENCE leads_fixture_seq OWNED BY leads.id;
      ALTER TABLE leads ALTER COLUMN id SET DEFAULT nextval('leads_fixture_seq');
      CREATE TABLE crm_contacts (LIKE public.crm_contacts INCLUDING DEFAULTS INCLUDING GENERATED);
      ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS business_profile_id integer;
      -- LIKE omits the production ownership trigger; mirror its scoped insert default.
      ALTER TABLE crm_contacts ALTER COLUMN business_profile_id
        SET DEFAULT NULLIF(current_setting('app.business_profile_id', true), '')::integer;
      ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS merged_into_contact_id integer;
      CREATE SEQUENCE crm_contacts_fixture_seq OWNED BY crm_contacts.id;
      ALTER TABLE crm_contacts ALTER COLUMN id SET DEFAULT nextval('crm_contacts_fixture_seq');
      CREATE TABLE outreach_conversations (id integer PRIMARY KEY, user_id integer, business_profile_id integer, lead_id integer, crm_contact_id integer, channel text);
      CREATE TABLE crm_activity_reminders (LIKE public.crm_activity_reminders INCLUDING DEFAULTS);
      ALTER TABLE crm_activity_reminders ADD COLUMN IF NOT EXISTS business_profile_id integer;
      CREATE TABLE crm_activities (LIKE public.crm_activities INCLUDING DEFAULTS);
      ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS business_profile_id integer;
      CREATE SEQUENCE crm_activities_fixture_seq OWNED BY crm_activities.id;
      ALTER TABLE crm_activities ALTER COLUMN id SET DEFAULT nextval('crm_activities_fixture_seq');
      CREATE TABLE followup_sequences (id integer PRIMARY KEY, user_id integer, business_profile_id integer, lead_id integer,
        completed boolean DEFAULT false, replied_at timestamptz, updated_at timestamptz DEFAULT now());
      CREATE TABLE sequence_executions (id integer PRIMARY KEY, user_id integer, business_profile_id integer, lead_id integer,
        status text DEFAULT 'active', updated_at timestamptz DEFAULT now());
      CREATE TABLE crm_pipeline_automations (id integer PRIMARY KEY, user_id integer, business_profile_id integer, trigger_config jsonb, action_config jsonb, condition jsonb, definition jsonb, deleted_at timestamp);
      CREATE TABLE crm_alerts (id integer PRIMARY KEY, user_id integer, business_profile_id integer, conditions jsonb);
      GRANT USAGE ON SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO salesmarketing_business_runtime;
    `);
    await migration.up(fixturePool);
    for (const table of ['company_settings', 'leads', 'crm_contacts', 'outreach_conversations', 'crm_activity_reminders', 'crm_activities', 'crm_pipeline_automations', 'crm_alerts', 'followup_sequences', 'sequence_executions']) {
      const profileColumn = table === 'company_settings' ? 'id' : 'business_profile_id';
      await fixturePool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY fixture_business_isolation ON ${table} FOR ALL
        USING (current_user <> 'salesmarketing_business_runtime' OR (
          ${profileColumn} = NULLIF(current_setting('app.business_profile_id', true), '')::integer
          AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::integer))
        WITH CHECK (current_user <> 'salesmarketing_business_runtime' OR (
          ${profileColumn} = NULLIF(current_setting('app.business_profile_id', true), '')::integer
          AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::integer));`);
    }
  });

  afterAll(async () => {
    await runtimePool?.end();
    await fixturePool?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
    pgDefaults.parseInputDatesAsUTC = originalUtcInput;
    pgTypes.setTypeParser(1114, originalTimestampParser);
  });

  beforeEach(async () => {
    fireEvent.mockClear();
    await fixturePool.query('TRUNCATE company_settings, leads, crm_contacts, outreach_conversations, crm_activity_reminders, crm_activities, crm_pipeline_automations, crm_alerts, followup_sequences, sequence_executions RESTART IDENTITY');
    await fixturePool.query('INSERT INTO company_settings(id, user_id) VALUES(101,9),(102,9),(201,19)');
  });

  it('persists configurations independently for two business profiles and rejects another owner’s profile', async () => {
    const configuration = structuredClone(DEFAULT_CRM_CONFIGURATION);
    configuration.preferences.topFlows = 8;
    configuration.stages[1].label = 'In Progress';
    await inProfile(101, () => saveCrmConfiguration(9, configuration));
    expect(await inProfile(101, () => getCrmConfiguration(9))).toMatchObject({ ...configuration });
    expect(await inProfile(102, () => getCrmConfiguration(9))).toMatchObject({ ...DEFAULT_CRM_CONFIGURATION });
    await expect(inProfile(201, () => getCrmConfiguration(9))).rejects.toMatchObject({ status: 404 });
    const original = await fixturePool.query('SELECT crm_configuration FROM company_settings WHERE id=201');
    expect(original.rows[0].crm_configuration).toBeNull();
  });

  it('executes contact and CRM rule checks before deleting a stage', async () => {
    await fixturePool.query("INSERT INTO crm_contacts(id,user_id,business_profile_id,pipeline_status) VALUES(1,9,101,'demo')");
    const configuration = structuredClone(DEFAULT_CRM_CONFIGURATION);
    configuration.stages = configuration.stages.filter(stage => stage.key !== 'demo');
    await expect(inProfile(101, () => saveCrmConfiguration(9, configuration))).rejects.toMatchObject({ status: 409 });
    await fixturePool.query('DELETE FROM crm_contacts');
    await fixturePool.query("INSERT INTO crm_pipeline_automations(id,user_id,business_profile_id,action_config) VALUES(1,9,101,'{\"pipelineStatus\":\"demo\"}')");
    await expect(inProfile(101, () => saveCrmConfiguration(9, configuration))).rejects.toMatchObject({ status: 409 });
    await fixturePool.query('DELETE FROM crm_pipeline_automations');
    await inProfile(101, () => saveCrmConfiguration(9, configuration));
    expect((await inProfile(101, () => getCrmConfiguration(9))).stages.some(stage => stage.key === 'demo')).toBe(false);
  });

  it('keeps saved revisions stable across JSONB round trips and rejects a stale editor', async () => {
    const first = await inProfile(101, () => getCrmConfiguration(9));
    const stale = structuredClone(first);
    first.preferences.topFlows = 8;
    const saved = await inProfile(101, () => saveCrmConfiguration(9, first));
    const reloaded = await inProfile(101, () => getCrmConfiguration(9));
    expect(reloaded.revision).toBe(saved.revision);
    stale.preferences.topFlows = 12;
    await expect(inProfile(101, () => saveCrmConfiguration(9, stale))).rejects.toMatchObject({ status: 409 });
    expect((await inProfile(101, () => getCrmConfiguration(9))).preferences.topFlows).toBe(8);
  });

  it('includes both custom UTC boundary dates and excludes contacts outside the interval', async () => {
    await fixturePool.query(`INSERT INTO crm_contacts(id,user_id,business_profile_id,pipeline_status,created_at,deal_value,currency) VALUES
      (1,9,101,'new','2026-09-01T00:00:00Z',10,'USD'),
      (2,9,101,'new','2026-09-30T23:59:59.999Z',20,'USD'),
      (3,9,101,'new','2026-10-01T00:00:00Z',30,'USD'),
      (4,9,101,'new','2026-08-31T23:59:59.999Z',40,'USD')`);
    const configuration = structuredClone(DEFAULT_CRM_CONFIGURATION);
    configuration.preferences = { ...configuration.preferences, dateRange: 'custom', dateStart: '2026-09-01', dateEnd: '2026-09-30' };
    const saved = await inProfile(101, () => saveCrmConfiguration(9, configuration));
    expect(saved.preferences).toMatchObject({ ...configuration.preferences });
    const analytics = await inProfile(101, () => crmService.getPipelineAnalytics(9, saved));
    expect(analytics.stages.find(stage => stage.key === 'new')?.count).toBe(2);
    expect(analytics.totalPipelineValueByCurrency).toEqual({ USD: '30' });
  });

  it('applies stage types, date/platform filters, stuck thresholds and flow limits to real analytics queries', async () => {
    const configuration: CrmConfiguration = {
      stages: [DEFAULT_CRM_CONFIGURATION.stages[0], DEFAULT_CRM_CONFIGURATION.stages[1],
        { key: 'approved', label: 'Approved', type: 'won', color: '#10b981', inFlow: true }, DEFAULT_CRM_CONFIGURATION.stages[9]],
      preferences: { dateRange: '30d', platform: 'email', stuckThreshold: 7, topFlows: 2, minFlowCount: 2 },
    };
    await fixturePool.query(`INSERT INTO crm_contacts(id,user_id,business_profile_id,pipeline_status,deal_value,created_at) VALUES
      (1,9,101,'new',0,now()-interval '10 days'),(2,9,101,'approved',200,now()-interval '3 days'),
      (3,9,101,'lost',100,now()-interval '2 days'),(4,9,101,'approved',50,now()-interval '90 days'),
      (5,9,101,'approved',60,now()-interval '5 days'),(6,9,102,'approved',900,now());
      INSERT INTO outreach_conversations(id,user_id,business_profile_id,crm_contact_id,channel) VALUES
      (1,9,101,1,'email'),(2,9,101,2,'email'),(3,9,101,3,'email'),(4,9,101,4,'email'),(5,9,101,5,'whatsapp'),(6,9,102,6,'email');
      INSERT INTO crm_activities(id,user_id,business_profile_id,contact_id,type,metadata)
        SELECT id,9,101,2,'pipeline_change',CASE WHEN id<=3 THEN '{"oldStatus":"new","newStatus":"contacted"}'::jsonb
          WHEN id<=5 THEN '{"oldStatus":"contacted","newStatus":"approved"}'::jsonb
          ELSE '{"oldStatus":"contacted","newStatus":"lost"}'::jsonb END FROM generate_series(1,6) id;
    `);
    const analytics = await inProfile(101, () => crmService.getPipelineAnalytics(9, configuration));
    expect(analytics.winRate).toBe(50);
    expect(analytics.stuckContacts).toBe(1);
    expect(analytics.totalPipelineValueByCurrency).toEqual({ USD: '300' });
    expect(analytics.stages.find(stage => stage.key === 'approved')).toMatchObject({ label: 'Approved', type: 'won', count: 1 });
    expect(analytics.flows).toEqual([{ from: 'new', to: 'contacted', count: 3 }, { from: 'contacted', to: 'approved', count: 2 }]);
    configuration.stages[2] = { ...configuration.stages[2], inFlow: false };
    const hidden = await inProfile(101, () => crmService.getPipelineAnalytics(9, configuration));
    expect(hidden.flows).toEqual([{ from: 'new', to: 'contacted', count: 3 }]);
    configuration.preferences.minFlowCount = 4;
    expect((await inProfile(101, () => crmService.getPipelineAnalytics(9, configuration))).flows).toEqual([]);
  });

  it('reports the union of selected platforms without double counting contacts or flows', async () => {
    const configuration = structuredClone(DEFAULT_CRM_CONFIGURATION);
    configuration.preferences = { ...configuration.preferences, dateRange: 'all', platform: ['email', 'whatsapp'], minFlowCount: 1, topFlows: 20 };
    await inProfile(101, () => saveCrmConfiguration(9, configuration));
    const saved = await inProfile(101, () => getCrmConfiguration(9));
    expect(saved.preferences.platform).toEqual(['email', 'whatsapp']);
    await fixturePool.query(`INSERT INTO crm_contacts(id,user_id,business_profile_id,pipeline_status,deal_value) VALUES
      (1,9,101,'won',100),(2,9,101,'contacted',200),(3,9,101,'lost',400),(4,9,102,'won',900);
      INSERT INTO leads(id,user_id,business_profile_id,status) VALUES(7,9,101,'new');
      INSERT INTO outreach_conversations(id,user_id,business_profile_id,crm_contact_id,lead_id,channel) VALUES
        (1,9,101,1,NULL,'email'),(2,9,101,1,NULL,'whatsapp'),(3,9,101,2,NULL,'whatsapp'),
        (4,9,101,3,NULL,'sms'),(5,9,102,4,NULL,'whatsapp'),(6,9,101,NULL,7,'email');
      INSERT INTO crm_activities(id,user_id,business_profile_id,contact_id,type,metadata) VALUES
        (1,9,101,1,'pipeline_change','{"oldStatus":"new","newStatus":"won"}'),
        (2,9,101,1,'pipeline_change','{"oldStatus":"contacted","newStatus":"won"}'),
        (3,9,101,2,'pipeline_change','{"oldStatus":"new","newStatus":"contacted"}'),
        (4,9,101,3,'pipeline_change','{"oldStatus":"new","newStatus":"lost"}'),
        (5,9,102,4,'pipeline_change','{"oldStatus":"new","newStatus":"won"}');`);
    const analytics = await inProfile(101, () => crmService.getPipelineAnalytics(9, saved));
    expect(analytics.stages.reduce((sum, stage) => sum + stage.count, 0)).toBe(3);
    expect(analytics.stages.find(stage => stage.key === 'won')?.count).toBe(1);
    expect(analytics.stages.find(stage => stage.key === 'contacted')?.count).toBe(2);
    expect(analytics.totalPipelineValueByCurrency).toEqual({ USD: '300' });
    expect(analytics.winRate).toBe(100);
    expect(analytics.flows).toEqual([
      { from: 'contacted', to: 'won', count: 1 }, { from: 'new', to: 'contacted', count: 1 }, { from: 'new', to: 'won', count: 1 },
    ]);
    saved.preferences.platform = 'email';
    const legacy = await inProfile(101, () => crmService.getPipelineAnalytics(9, saved));
    expect(legacy.stages.reduce((sum, stage) => sum + stage.count, 0)).toBe(2);
    expect(legacy.preferences.platform).toEqual(['email']);
    saved.preferences.platform = ['all'];
    const all = await inProfile(101, () => crmService.getPipelineAnalytics(9, saved));
    expect(all.stages.reduce((sum, stage) => sum + stage.count, 0)).toBe(4);
    expect(all.totalPipelineValueByCurrency).toEqual({ USD: '700' });
    expect(all.flows).toContainEqual({ from: 'new', to: 'lost', count: 1 });
  });

  it('supports rolling back and reapplying the migration within the isolated schema', async () => {
    await migration.down(fixturePool);
    const removed = await fixturePool.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3', [schema, 'company_settings', 'crm_configuration']);
    expect(removed.rows).toEqual([]);
    await migration.up(fixturePool);
    expect(await inProfile(101, () => getCrmConfiguration(9))).toMatchObject({ ...DEFAULT_CRM_CONFIGURATION });
  });

  it('reports virtual lead outcomes in the saved custom stages before materialization', async () => {
    const configuration: CrmConfiguration = {
      stages: [DEFAULT_CRM_CONFIGURATION.stages[0],
        { key: 'working', label: 'Working', type: 'active', color: '#8b5cf6', inFlow: true },
        { key: 'accepted', label: 'Accepted', type: 'won', color: '#10b981', inFlow: true },
        { key: 'declined', label: 'Declined', type: 'lost', color: '#f59e0b', inFlow: true }],
      preferences: DEFAULT_CRM_CONFIGURATION.preferences,
    };
    await inProfile(101, () => saveCrmConfiguration(9, configuration));
    await fixturePool.query(`INSERT INTO leads(id,user_id,business_profile_id,status) VALUES
      (1,9,101,'converted'),(2,9,101,'lost'),(3,9,101,'new'),(4,9,101,'new');
      INSERT INTO outreach_conversations(id,user_id,business_profile_id,lead_id,channel) VALUES(1,9,101,3,'email');`);
    const analytics = await inProfile(101, () => crmService.getPipelineAnalytics(9, configuration));
    expect(analytics.stages.map(stage => [stage.key, stage.count])).toEqual([
      ['new', 1], ['working', 1], ['accepted', 1], ['declined', 1],
    ]);
    expect(analytics.winRate).toBe(50);

    const listed = await inProfile(101, () => crmService.getContacts(9));
    expect(listed.total).toBe(4);
    for (const [id, pipelineStatus, status] of [
      [-1, 'accepted', 'won'], [-2, 'declined', 'lost'], [-3, 'working', 'contacted'], [-4, 'new', 'new'],
    ] as const) {
      expect(listed.contacts.find((contact: { id: number }) => contact.id === id)).toMatchObject({ pipelineStatus, status });
      expect(await inProfile(101, () => crmService.getContactById(9, id))).toMatchObject({ id, pipelineStatus, status });
      const filtered = await inProfile(101, () => crmService.getContacts(9, { pipelineStatus }));
      expect(filtered.total).toBe(1);
      expect(filtered.contacts).toHaveLength(1);
      expect(filtered.contacts[0].id).toBe(id);
    }

    const withoutWorking = { ...configuration, stages: configuration.stages.filter(stage => stage.key !== 'working') };
    await expect(inProfile(101, () => saveCrmConfiguration(9, withoutWorking))).rejects.toMatchObject({ status: 409 });

    for (const [leadId, pipelineStatus, status] of [
      [1, 'accepted', 'won'], [2, 'declined', 'lost'], [3, 'working', 'contacted'], [4, 'new', 'new'],
    ] as const) {
      const persisted = await inProfile(101, () => crmService.materializeContactReference(9, -leadId));
      expect(persisted).toMatchObject({ leadId, pipelineStatus, status });
      expect(persisted?.id).toBeGreaterThan(0);
      expect(await inProfile(101, () => crmService.getContactById(9, -leadId))).toMatchObject({ id: persisted?.id, pipelineStatus, status });
    }
    expect((await inProfile(101, () => crmService.getPipelineAnalytics(9, configuration))).stages.map(stage => [stage.key, stage.count]))
      .toEqual(analytics.stages.map(stage => [stage.key, stage.count]));
  });

  it('protects a configured Won stage assigned to an unmaterialized converted lead', async () => {
    const config = structuredClone(DEFAULT_CRM_CONFIGURATION);
    config.stages = config.stages.filter(stage => stage.type !== 'won');
    config.stages.push({ key: 'accepted', label: 'Offer accepted', type: 'won', color: '#10b981', inFlow: true });
    await inProfile(101, () => saveCrmConfiguration(9, config));
    await fixturePool.query("INSERT INTO leads(id,user_id,business_profile_id,status) VALUES(7,9,101,'converted')");
    config.stages = config.stages.filter(stage => stage.key !== 'accepted');
    await expect(inProfile(101, () => saveCrmConfiguration(9, config))).rejects.toMatchObject({ status: 409 });
    expect((await inProfile(101, () => getCrmConfiguration(9))).stages.some(stage => stage.key === 'accepted')).toBe(true);
  });

  it('commits custom Won/Lost outcomes, labeled activities, alerts and paused follow-ups together', async () => {
    const configuration: CrmConfiguration = {
      stages: [DEFAULT_CRM_CONFIGURATION.stages[0], DEFAULT_CRM_CONFIGURATION.stages[1],
        { key: 'contract_signed', label: 'Contract signed', type: 'won', color: '#10b981', inFlow: false },
        { key: 'offer_declined', label: 'Offer declined', type: 'lost', color: '#f59e0b', inFlow: true }],
      preferences: DEFAULT_CRM_CONFIGURATION.preferences,
    };
    await inProfile(101, () => saveCrmConfiguration(9, configuration));
    await fixturePool.query(`
      INSERT INTO leads(id,user_id,business_profile_id,status) VALUES(7,9,101,'interested'),(8,9,102,'interested');
      INSERT INTO crm_contacts(id,user_id,business_profile_id,lead_id,status,pipeline_status) VALUES
        (1,9,101,7,'interested','contacted'),(2,9,102,8,'interested','contacted');
      INSERT INTO followup_sequences(id,user_id,business_profile_id,lead_id) VALUES(1,9,101,7),(2,9,102,8);
      INSERT INTO sequence_executions(id,user_id,business_profile_id,lead_id) VALUES(1,9,101,7),(2,9,102,8);
    `);
    const materialize = jest.spyOn(crmService, 'materializeContactReference').mockImplementation(async (owner, id) => {
      const [row] = await database.select().from(crmContactsTable).where(and(
        eq(crmContactsTable.userId, owner), eq(crmContactsTable.id, id), isNull(crmContactsTable.deletedAt),
      )).limit(1);
      return row || null;
    });
    try {
      const won = await inProfile(101, () => crmService.updatePipelineStatus(9, 1, 'Contract signed', { automatic: true, expectedStageType: 'won' }));
      expect(won).toMatchObject({ pipelineStatus: 'contract_signed', status: 'won' });
      expect((await fixturePool.query('SELECT status FROM leads WHERE id=7')).rows[0].status).toBe('converted');
      expect((await fixturePool.query('SELECT completed FROM followup_sequences WHERE id=1')).rows[0].completed).toBe(true);
      expect((await fixturePool.query('SELECT status FROM sequence_executions WHERE id=1')).rows[0].status).toBe('paused');
      expect(fireEvent).toHaveBeenCalledWith(9, 'deal_won', expect.objectContaining({ newStatus: 'contract_signed' }));
      await inProfile(101, () => crmService.updatePipelineStatus(9, 1, 'contract_signed'));
      expect(fireEvent).toHaveBeenCalledTimes(3);
      await inProfile(101, () => crmService.updatePipelineStatus(9, 1, 'offer_declined'));
      expect((await fixturePool.query('SELECT status FROM leads WHERE id=7')).rows[0].status).toBe('lost');
      expect(fireEvent).toHaveBeenCalledWith(9, 'deal_lost', expect.objectContaining({ newStatus: 'offer_declined' }));
      const history = await fixturePool.query('SELECT subject, metadata FROM crm_activities ORDER BY id');
      expect(history.rows).toHaveLength(2);
      expect(history.rows[0]).toMatchObject({ subject: 'Pipeline: Ongoing → Contract signed', metadata: {
        oldStatus: 'contacted', newStatus: 'contract_signed', stageType: 'won', source: 'support_agent',
      } });
      expect((await fixturePool.query('SELECT status FROM leads WHERE id=8')).rows[0].status).toBe('interested');
      expect((await fixturePool.query('SELECT status FROM sequence_executions WHERE id=2')).rows[0].status).toBe('active');
      expect(await inProfile(101, () => crmService.updatePipelineStatus(9, 2, 'contract_signed'))).toBeNull();
      await expect(inProfile(101, () => crmService.updatePipelineStatus(9, 1, 'invented'))).rejects.toMatchObject({ status: 400 });
      const guarded = await inProfile(101, () => crmService.updatePipelineStatus(9, 1, 'contacted', { automatic: true, expectedStageType: 'active' }));
      expect(guarded?.pipelineStatus).toBe('offer_declined');
      const reopened = await inProfile(101, () => crmService.updatePipelineStatus(9, 1, 'contacted'));
      expect(reopened?.status).toBe('contacted');
      expect((await fixturePool.query('SELECT status FROM leads WHERE id=7')).rows[0].status).toBe('contacted');
    } finally { materialize.mockRestore(); }
  });

  it('rolls back the contact and activity when linked-lead synchronization fails', async () => {
    await fixturePool.query(`INSERT INTO leads(id,user_id,business_profile_id,status) VALUES(7,9,101,'interested');
      INSERT INTO crm_contacts(id,user_id,business_profile_id,lead_id,status,pipeline_status) VALUES(1,9,101,7,'interested','contacted');
      ALTER TABLE leads ADD CONSTRAINT fixture_reject_lost CHECK (status <> 'lost');`);
    const materialize = jest.spyOn(crmService, 'materializeContactReference').mockImplementation(async () =>
      (await database.select().from(crmContactsTable).limit(1))[0]);
    try {
      await expect(inProfile(101, () => crmService.updatePipelineStatus(9, 1, 'lost'))).rejects.toThrow();
      expect((await fixturePool.query('SELECT status,pipeline_status FROM crm_contacts WHERE id=1')).rows[0])
        .toEqual({ status: 'interested', pipeline_status: 'contacted' });
      expect((await fixturePool.query('SELECT status FROM leads WHERE id=7')).rows[0].status).toBe('interested');
      expect((await fixturePool.query('SELECT * FROM crm_activities')).rows).toHaveLength(0);
      expect(fireEvent).not.toHaveBeenCalled();
    } finally {
      materialize.mockRestore();
      await fixturePool.query('ALTER TABLE leads DROP CONSTRAINT fixture_reject_lost');
    }
  });
});
