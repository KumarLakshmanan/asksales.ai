import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { Pool, defaults as pgDefaults, types as pgTypes } from 'pg';
import { getTableName, type SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { leadsTable } from '../models/leads/schema.js';
import { crmContactsTable } from '../models/crmContacts/schema.js';
import { crmActivitiesTable } from '../models/crmActivities/schema.js';
import { outreachConversationsTable, outreachMessagesTable } from '../models/outreachConversations/schema.js';
import { sentMessagesTable } from '../models/sentMessages/schema.js';
import { supportTicketsTable } from '../models/supportTickets/schema.js';
import { supportTicketMessagesTable } from '../models/supportTicketMessages/schema.js';
import { crmActivityRemindersTable } from '../models/crmActivityReminders/schema.js';
import { teamMembersTable } from '../models/teamMembers/schema.js';
import { supportTeamsTable } from '../models/supportTeams/schema.js';
import { proposalRemindersTable } from '../models/proposalReminders/schema.js';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { DEFAULT_CRM_CONFIGURATION } from '../../shared/crmConfiguration.js';
import { crmContactsQuerySchema, crmHistoryQuerySchema, crmWorkQuerySchema } from '../utils/crmWorkspaceValidation.js';

const localPostgres = process.env.CRM_WORKSPACE_LOCAL_QA === '1' ? describe : describe.skip;
let database: NodePgDatabase;
const proxy = new Proxy({} as NodePgDatabase,{ get(_target,key) {
  const value = database[key as keyof NodePgDatabase];
  return typeof value === 'function' ? value.bind(database) : value;
} });
jest.unstable_mockModule('../models/db.js',()=>({ db: proxy }));
jest.unstable_mockModule('../services/SentimentAnalysisService',()=>({ sentimentAnalysisService: {} }));
const fireEvent = jest.fn<any>().mockResolvedValue(undefined);
const sendAdminEmail = jest.fn<any>().mockResolvedValue({ success: true });
const publishEvent = jest.fn<any>().mockResolvedValue(undefined);
jest.unstable_mockModule('../services/AlertService',()=>({ alertService: { fireEvent } }));
jest.unstable_mockModule('../utils/logger.js',()=>({ logger: { error: jest.fn(),warn: jest.fn(),info: jest.fn() } }));
jest.unstable_mockModule('../services/adminEmailService',()=>({ sendAdminEmail }));
jest.unstable_mockModule('../events/EventBus.js',()=>({ eventBus: { publish: publishEvent } }));
jest.unstable_mockModule('../utils/emailTemplates',()=>({ renderAdminEmail: jest.fn(),renderBrandedEmail: jest.fn(),getBrandInfo: jest.fn() }));
const { crmService } = await import('../services/CRMService.js');
const { crmWorkspaceService } = await import('../services/CRMWorkspaceService.js');
const { reminderService } = await import('../services/ReminderService.js');
const { getCrmAssignees } = await import('../services/CRMAssigneeService.js');
const inProfile = <T>(profile: number, work: () => T) => withBusinessScope({ userId: 9,businessProfileId: profile,actorUserId: 29 },work);
const history = (query: Record<string,unknown> = {}) => crmHistoryQuerySchema.parse(query);

localPostgres('CRM workspace transactions, pagination and RLS in isolated local PostgreSQL',()=>{
  let admin: Pool; let fixtures: Pool; let runtime: Pool; let schema: string;
  const originalUtcInput = pgDefaults.parseInputDatesAsUTC;
  const originalTimestampParser = pgTypes.getTypeParser(1114);
  const manualScopedTables = ['crm_automation_runs','followup_sequences','sequence_executions','crm_contact_channel_identities',
    'chat_threads','campaign_crm_contacts','icp_profiles'];
  const scopedTables = ['leads','crm_contacts','crm_activities','outreach_conversations','outreach_messages','sent_messages',
    'crm_activity_reminders','support_tickets','support_ticket_messages','team_members','support_teams','proposal_reminders',...manualScopedTables];

  beforeAll(async()=>{
    pgDefaults.parseInputDatesAsUTC = true;
    pgTypes.setTypeParser(1114,value=>new Date(`${value.replace(' ','T')}Z`));
    dotenv.config({ path: fileURLToPath(new URL('../.env.development',import.meta.url)),override: true,quiet: true });
    dotenv.config({ path: fileURLToPath(new URL('../.env',import.meta.url)),override: true,quiet: true });
    if (!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST || '')) throw new Error('CRM workspace QA requires local PostgreSQL.');
    const connection = { host: process.env.DB_HOST,port: Number(process.env.DB_PORT || 5432),database: process.env.DB_NAME || process.env.DB_DATABASE,
      user: process.env.DB_USER,password: process.env.DB_PASSWORD || '',connectionTimeoutMillis: 5000 };
    schema = `crm_workspace_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...connection,max: 1,options: '-c timezone=UTC -c search_path=pg_catalog' });
    await admin.query(`CREATE SCHEMA ${schema}`);
    fixtures = new Pool({ ...connection,max: 1,options: `-c timezone=UTC -c search_path=${schema},pg_catalog` });
    runtime = createBusinessScopedPool(new Pool({ ...connection,max: 3,options: `-c timezone=UTC -c search_path=${schema},pg_catalog` }));
    database = drizzle(runtime);
    await fixtures.query(`CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,crm_configuration jsonb,updated_at timestamptz DEFAULT now());
      CREATE TABLE users(id integer PRIMARY KEY,name text,email text,deleted_at timestamp);
      CREATE TABLE business_profile_memberships(id serial PRIMARY KEY,business_profile_id integer,user_id integer,email text,role text,status text);
      CREATE TABLE crm_automation_runs(id serial PRIMARY KEY,user_id integer,business_profile_id integer,automation_id integer,automation_name text,
        revision integer,event_type text,contact_id integer,status text,created_at timestamptz DEFAULT now());
      CREATE TABLE followup_sequences(id serial PRIMARY KEY,user_id integer,business_profile_id integer,lead_id integer,completed boolean DEFAULT false,replied_at timestamptz,updated_at timestamptz DEFAULT now());
      CREATE TABLE sequence_executions(id serial PRIMARY KEY,user_id integer,business_profile_id integer,lead_id integer,status text DEFAULT 'active',updated_at timestamptz DEFAULT now());
      CREATE TABLE crm_contact_channel_identities(id serial PRIMARY KEY,user_id integer,business_profile_id integer,contact_id integer,identifier_type text,identifier_fingerprint text,verification_level text);
      CREATE TABLE chat_threads(id integer PRIMARY KEY,user_id integer,business_profile_id integer,deleted_at timestamp);
      CREATE TABLE campaign_crm_contacts(id serial PRIMARY KEY,user_id integer,business_profile_id integer,contact_id integer,thread_id integer);
      CREATE TABLE icp_profiles(id integer PRIMARY KEY,user_id integer,business_profile_id integer,thread_id integer);`);
    for (const table of scopedTables.filter(table=>!manualScopedTables.includes(table))) {
      await fixtures.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS);
        ALTER TABLE ${table} ADD PRIMARY KEY(id);
        ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS business_profile_id integer;
        ALTER TABLE ${table} ALTER COLUMN business_profile_id SET DEFAULT NULLIF(current_setting('app.business_profile_id',true),'')::integer;
        CREATE SEQUENCE ${table}_fixture_seq START 1000 OWNED BY ${table}.id;
        ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${table}_fixture_seq');`);
    }
    // The local application database may lag schema-only migrations. Add the
    // model columns to this disposable fixture; never change the public schema.
    for (const table of [leadsTable,crmContactsTable,crmActivitiesTable,outreachConversationsTable,outreachMessagesTable,
      sentMessagesTable,supportTicketsTable,supportTicketMessagesTable,crmActivityRemindersTable,teamMembersTable,supportTeamsTable,proposalRemindersTable]) {
      const name = getTableName(table);
      await fixtures.query(getTableConfig(table).columns.map(column=>`ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS "${column.name}" ${column.getSQLType().replace(/^serial$/,'integer')};`).join('\n'));
    }
    await fixtures.query(`ALTER TABLE leads ALTER COLUMN uuid SET DEFAULT gen_random_uuid();
      ALTER TABLE leads ALTER COLUMN source SET DEFAULT 'fixture';
      ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS merged_into_contact_id integer;
      ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS idempotency_key text;
      ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS redacted_content text;
      GRANT USAGE ON SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO salesmarketing_business_runtime;`);
    for (const table of [...scopedTables,'company_settings','business_profile_memberships']) {
      const profile = table==='company_settings' ? 'id' : 'business_profile_id';
      const owner = table==='business_profile_memberships' ? '' : 'AND user_id=NULLIF(current_setting(\'app.current_user_id\',true),\'\')::integer';
      await fixtures.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY workspace_profile_isolation ON ${table} FOR ALL USING (current_user<>'salesmarketing_business_runtime' OR (
          ${profile}=NULLIF(current_setting('app.business_profile_id',true),'')::integer ${owner}))
        WITH CHECK(current_user<>'salesmarketing_business_runtime' OR (${profile}=NULLIF(current_setting('app.business_profile_id',true),'')::integer ${owner}));`);
    }
  },30_000);

  afterAll(async()=>{
    await runtime?.end(); await fixtures?.end();
    if(admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
    pgDefaults.parseInputDatesAsUTC = originalUtcInput;
    pgTypes.setTypeParser(1114,originalTimestampParser);
  });

  beforeEach(async()=>{
    fireEvent.mockClear();
    sendAdminEmail.mockReset().mockResolvedValue({ success: true });
    publishEvent.mockClear();
    await fixtures.query(`ALTER TABLE followup_sequences DROP CONSTRAINT IF EXISTS test_pause_failure;
      TRUNCATE company_settings,users,business_profile_memberships,${scopedTables.join(',')} RESTART IDENTITY;
      INSERT INTO users(id,name,email) VALUES(9,'Owner','owner@test.example'),(29,'Member','member@test.example'),(19,'Outside','outside@test.example');
      INSERT INTO company_settings(id,user_id,crm_configuration) VALUES(101,9,'${JSON.stringify(DEFAULT_CRM_CONFIGURATION)}'),(102,9,'${JSON.stringify(DEFAULT_CRM_CONFIGURATION)}');
      INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status) VALUES(101,29,'member@test.example','member','active'),(102,19,'outside@test.example','member','active');
      INSERT INTO leads(id,user_id,business_profile_id,first_name,email,status,created_at,updated_at) VALUES
        (11,9,101,'Ada','ada@test.example','new',now()-interval '20 days',now()-interval '10 days'),
        (12,9,101,'Channel alias','alias@test.example','new',now()-interval '18 days',now()-interval '10 days'),
        (22,9,101,'Ben','ben@test.example','new',now()-interval '5 days',now()-interval '5 days'),
        (30,9,101,'Virtual','virtual@test.example','new',now()-interval '15 days',now()-interval '9 days');
      INSERT INTO crm_contacts(id,user_id,business_profile_id,lead_id,first_name,email,pipeline_status,priority,tags,assigned_to,deal_value,currency,created_at,updated_at) VALUES
        (1,9,101,11,'Ada','ada@test.example','new','high','["VIP"]',29,120,'USD',now()-interval '20 days',now()-interval '10 days'),
        (2,9,101,22,'Ben','ben@test.example','new','low','[]',NULL,70,'INR',now()-interval '5 days',now()-interval '5 days'),
        (4,9,102,NULL,'Other profile','foreign@test.example','new','high','["VIP"]',19,900,'USD',now(),now());
      INSERT INTO outreach_conversations(id,user_id,business_profile_id,lead_id,crm_contact_id,channel,subject,total_messages,unread_count,last_message_at,last_message_by) VALUES
        (1,9,101,11,1,'email','Proposal discussion',25,3,now(),'lead'),
        (2,9,101,12,1,'whatsapp','WhatsApp follow-up',1,1,now()-interval '1 hour','lead'),
        (3,9,102,11,4,'email','Private other profile',1,4,now(),'lead');
      INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,direction,content,redacted_content,html_content,status,created_at)
        SELECT number,9,101,1,CASE WHEN number%2=0 THEN 'inbound' ELSE 'outbound' END,'Private raw content','Safe message '||number,'<b>Private raw content</b>','delivered',now()-number*interval '1 minute' FROM generate_series(1,25) number;
      INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,direction,content,redacted_content,status) VALUES(26,9,101,2,'outbound','Private WhatsApp','Safe WhatsApp','sent'),(27,9,102,3,'inbound','Secret','Secret','received');
      INSERT INTO sent_messages(id,user_id,business_profile_id,lead_id,lead_name,channel,message,status,sent_at,outreach_message_id) VALUES
        (1,9,101,11,'Ada','email','Private raw content','sent',now(),1),(2,9,101,12,'Ada','whatsapp','Private WhatsApp','sent',now(),26),
        (3,9,101,11,'Ada','email','Legacy sent','sent',now(),NULL),(4,9,102,11,'Other','email','Secret','sent',now(),27);
      INSERT INTO crm_activities(id,user_id,business_profile_id,contact_id,type,subject,body,metadata,created_at) VALUES
        (1,9,101,1,'note','Meeting notes','Discussed proposal','{"actorUserId":29}',now()-interval '4 days'),
        (2,9,101,1,'call','Customer call','Follow up tomorrow','{"actorUserId":29}',now()-interval '3 days'),
        (3,9,101,1,'pipeline_change','New to Contacted',NULL,'{"oldStatus":"new","newStatus":"contacted","actorUserId":29}',now()-interval '15 days'),
        (4,9,101,1,'note','Historical note','Old entry','{"actorUserId":19}',now()-interval '2 days'),
        (5,9,102,4,'note','Private other profile','Secret','{}',now());
      INSERT INTO support_teams(id,user_id,business_profile_id,name) VALUES(1,9,101,'Support');
      INSERT INTO team_members(id,team_id,user_id,business_profile_id,name,email) VALUES(77,1,9,101,'Support agent','agent@test.example');
      INSERT INTO support_tickets(id,user_id,business_profile_id,contact_id,ticket_number,subject,status,sla_deadline,assigned_member_id,unread_count) VALUES
        (1,9,101,1,'T-1','Help with proposal','open',now()+interval '3 hours',77,1),
        (2,9,101,1,'T-2','Resolved request','resolved',now()+interval '3 hours',NULL,0),
        (3,9,102,4,'T-3','Foreign ticket','open',now()-interval '1 day',NULL,1),
        (4,9,101,NULL,'T-4','Unlinked unread ticket','open',NULL,NULL,1);
      INSERT INTO support_ticket_messages(id,ticket_id,user_id,business_profile_id,direction,content,is_internal) VALUES
        (1,1,9,101,'inbound','Please help',false),(2,1,9,101,'outbound','Internal investigation',true),(3,3,9,102,'inbound','Secret',false);
      INSERT INTO crm_automation_runs(id,user_id,business_profile_id,automation_id,automation_name,revision,event_type,contact_id,status) VALUES
        (1,9,101,10,'Follow-up rule',1,'contact.created',1,'completed'),(2,9,102,10,'Private rule',1,'contact.created',4,'completed');
      INSERT INTO followup_sequences(user_id,business_profile_id,lead_id) VALUES(9,101,11),(9,101,30);
      INSERT INTO sequence_executions(user_id,business_profile_id,lead_id) VALUES(9,101,11),(9,101,30);`);
  });

  it('saves fields and configured stage effects together, including lead lifecycle and follow-up pausing',async()=>{
    const before = await inProfile(101,()=>crmService.getContactById(9,1));
    const updated = await inProfile(101,()=>crmService.updateContact(9,1,{ company: 'Updated company',pipelineStatus: 'won',dealValue: '350.00',currency: 'INR',assignedTo: 29,expectedUpdatedAt: before!.updatedAt! }));
    expect(updated).toMatchObject({ company: 'Updated company',pipelineStatus: 'won',status: 'won',currency: 'INR',assignedTo: 29 });
    const result = await fixtures.query('SELECT l.status,s.completed,e.status AS execution_status FROM leads l JOIN followup_sequences s ON s.lead_id=l.id JOIN sequence_executions e ON e.lead_id=l.id WHERE l.id=11');
    expect(result.rows[0]).toEqual({ status: 'converted',completed: true,execution_status: 'paused' });
    const activity = await fixtures.query("SELECT metadata FROM crm_activities WHERE contact_id=1 AND type='pipeline_change' ORDER BY id DESC LIMIT 1");
    expect(activity.rows[0].metadata).toMatchObject({ newStatus: 'won',actorUserId: 29,dealValueSnapshot: '350.00',currencySnapshot: 'INR' });
  });

  it('rolls ordinary fields, stage, lead and activities back if a linked effect fails',async()=>{
    await fixtures.query('ALTER TABLE followup_sequences ADD CONSTRAINT test_pause_failure CHECK(completed=false)');
    await expect(inProfile(101,()=>crmService.updateContact(9,1,{ company: 'Must roll back',pipelineStatus: 'won' }))).rejects.toThrow();
    expect((await fixtures.query('SELECT company,pipeline_status FROM crm_contacts WHERE id=1')).rows[0]).toEqual({ company: null,pipeline_status: 'new' });
    expect((await fixtures.query('SELECT status FROM leads WHERE id=11')).rows[0].status).toBe('new');
    expect((await fixtures.query("SELECT count(*)::int FROM crm_activities WHERE type='contact_updated'")).rows[0].count).toBe(0);
    expect(fireEvent).not.toHaveBeenCalled();
  });

  it('preserves virtual timestamps while materializing atomically, and rejects stale saves and outside owners',async()=>{
    const virtual = await inProfile(101,()=>crmService.getContactById(9,-30));
    const updated = await inProfile(101,()=>crmService.updateContact(9,-30,{ notes: 'Virtual edit',pipelineStatus: 'won',expectedUpdatedAt: virtual!.updatedAt! }));
    expect(updated!.id).toBeGreaterThan(0);
    expect(updated).toMatchObject({ leadId: 30,notes: 'Virtual edit',pipelineStatus: 'won' });
    await expect(inProfile(101,()=>crmService.updateContact(9,updated!.id,{ notes: 'Stale',expectedUpdatedAt: virtual!.updatedAt! }))).rejects.toMatchObject({ status: 409 });
    await expect(inProfile(101,()=>crmService.updateContact(9,1,{ assignedTo: 19 }))).rejects.toMatchObject({ status: 400 });
    expect((await inProfile(101,()=>getCrmAssignees(9))).map(user=>user.id).sort((a,b)=>a-b)).toEqual([9,29]);
    expect(await inProfile(101,()=>crmService.getContactById(9,4))).toBeNull();
  });

  it('performs all-or-nothing bulk actions across virtual and physical records with configured stages',async()=>{
    await expect(inProfile(101,()=>crmService.bulkUpdateContacts(9,{ contactIds: [1,-30,99999],addTags: ['Reviewed'],assignedTo: 29 }))).rejects.toMatchObject({ status: 404 });
    expect((await fixtures.query('SELECT tags FROM crm_contacts WHERE id=1')).rows[0].tags).toEqual(['VIP']);
    expect((await fixtures.query('SELECT count(*)::int FROM crm_contacts WHERE lead_id=30')).rows[0].count).toBe(0);
    const result = await inProfile(101,()=>crmService.bulkUpdateContacts(9,{ contactIds: [1,-30],addTags: ['Reviewed'],pipelineStatus: 'demo',assignedTo: 29 }));
    expect(result.updatedCount).toBe(2);
    expect(result.contacts.every(contact=>contact.pipelineStatus==='demo' && contact.tags.includes('Reviewed'))).toBe(true);
  });

  it('allows editing a contact in an unchanged legacy stage while refusing new unknown stages',async()=>{
    await fixtures.query("UPDATE crm_contacts SET pipeline_status='legacy_qualification' WHERE id=2");
    expect(await inProfile(101,()=>crmService.updateContact(9,2,{ company: 'Edited safely',pipelineStatus: 'legacy_qualification' })))
      .toMatchObject({ company: 'Edited safely',pipelineStatus: 'legacy_qualification' });
    await expect(inProfile(101,()=>crmService.updateContact(9,2,{ pipelineStatus: 'unknown_stage' }))).rejects.toMatchObject({ status: 400 });
  });

  it('filters and sorts full collections, counts currencies and excludes aliases and other profiles',async()=>{
    const all = await inProfile(101,()=>crmService.getContacts(9,{ limit: 1,sortBy: 'name',sortOrder: 'asc' }));
    expect(all.total).toBe(3); expect(all.contacts).toHaveLength(1); expect(all.dealValueByCurrency).toEqual({ INR: '70.00',USD: '120.00' });
    expect(all.stages.find(stage=>stage.key==='new')?.count).toBe(3);
    const filtered = await inProfile(101,()=>crmService.getContacts(9,{ priority: 'high',tag: 'VIP',assignedTo: 29 }));
    expect(filtered.contacts.map(contact=>contact.id)).toEqual([1]);
    expect((await inProfile(101,()=>crmService.getContacts(9,{ assignedTo: 'unassigned' }))).total).toBe(2);
    expect((await inProfile(101,()=>crmService.getContacts(9,{ platforms: ['email','whatsapp'] }))).total).toBe(1);
  });

  it('keeps overview counts consistent with canonical collections and converted virtual contacts',async()=>{
    await fixtures.query("UPDATE leads SET status='converted' WHERE id=30");
    const overview = await inProfile(101,()=>crmService.getAnalytics(9));
    const contacts = await inProfile(101,()=>crmService.getContacts(9));
    expect(overview.totalContacts).toBe(contacts.total);
    expect(overview).toMatchObject({ totalContacts: 3,statusDistribution: { contacted: 2,won: 1 },winRate: 100,
      pipelineValueByCurrency: { INR: '70.00',USD: '120.00' } });
    expect(await inProfile(101,()=>crmService.getContactCount(9))).toBe(3);
  });

  it('pages histories, bounds messages, preserves canonical aliases and never returns private raw content',async()=>{
    const conversations = await inProfile(101,()=>crmWorkspaceService.conversations(9,1,history({ page: 1,limit: 1,messageLimit: 5,sentLimit: 2 })));
    expect(conversations.pagination.total).toBe(2); expect(conversations.sentPagination.total).toBe(3);
    expect(conversations.conversations[0].messages).toHaveLength(5); expect(conversations.conversations[0].messagesHasMore).toBe(true);
    expect(conversations.totalUnread).toBe(4);
    expect(JSON.stringify(conversations)).not.toContain('Private raw content');
    expect(conversations.conversations[0].messages[0].htmlContent).toBeNull();
    const older = await inProfile(101,()=>crmWorkspaceService.conversationMessages(9,1,1,history({ page: 2,limit: 5 })));
    expect(older.pagination.total).toBe(25); expect(older.data).toHaveLength(5);
    await expect(inProfile(101,()=>crmWorkspaceService.conversationMessages(9,1,3,history()))).rejects.toMatchObject({ status: 404 });
    const activities = await inProfile(101,()=>crmWorkspaceService.activities(9,-11,history({ type: 'note',limit: 1 })));
    expect(activities.pagination.total).toBe(2); expect(activities.data).toHaveLength(1);
    const tickets = await inProfile(101,()=>crmWorkspaceService.tickets(9,1,history({ status: 'open',limit: 1 })));
    expect(tickets.pagination.total).toBe(1); expect(tickets.tickets[0].assignee.name).toBe('Support agent');
    expect(tickets.tickets[0].slaStatus).toBe('at_risk'); expect(tickets.tickets[0].latestReply.content).toBe('Internal investigation');
    expect(tickets.tickets[0].latestReply.createdAt).toMatch(/Z$/);
  });

  it('synchronizes next follow-up through assignment, snooze, completion and deletion',async()=>{
    const due = new Date(Date.now()+86_400_000);
    const reminder = await inProfile(101,()=>reminderService.createActivityReminder(9,{ contactId: 1,title: 'Call Ada',reminderDueAt: due,metadata: { assignedTo: 29,priority: 'high',notifyContact: false } }));
    const list = await inProfile(101,()=>reminderService.getActivityRemindersWithContacts(9,{ contactId: 1 }));
    expect(list[0]).toMatchObject({ assignedTo: 29,assignedName: 'Member' });
    expect((await inProfile(101,()=>crmService.getContactById(9,1)))!.nextFollowUpAt!.getTime()).toBe(due.getTime());
    const snooze = new Date(Date.now()+2*86_400_000);
    const snoozed = await inProfile(101,()=>reminderService.updateActivityReminder(9,reminder.id,{ snoozedUntil: snooze }));
    expect(snoozed).toMatchObject({ status: 'snoozed',snoozedUntil: snooze,reminderDueAt: snooze });
    expect((await inProfile(101,()=>crmService.getContactById(9,1)))!.nextFollowUpAt!.getTime()).toBe(snooze.getTime());
    await inProfile(101,()=>reminderService.updateActivityReminder(9,reminder.id,{ status: 'completed' }));
    expect((await inProfile(101,()=>crmService.getContactById(9,1)))!.nextFollowUpAt).toBeNull();
    await inProfile(101,()=>reminderService.deleteActivityReminder(9,reminder.id));
    await expect(inProfile(101,()=>reminderService.createActivityReminder(9,{ contactId: 1,title: 'Invalid member',reminderDueAt: due,metadata: { assignedTo: 19 } }))).rejects.toMatchObject({ status: 400 });
  });

  it('keeps older-message cursors stable when new messages arrive and rejects another conversation cursor',async()=>{
    const first = await inProfile(101,()=>crmWorkspaceService.conversationMessages(9,1,1,history({ limit: 5 })));
    const cursor = first.nextBeforeMessageId!;
    await fixtures.query("INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,direction,content,redacted_content,status,created_at) VALUES(999,9,101,1,'inbound','New raw','New safe','received',now()+interval '1 minute')");
    const older = await inProfile(101,()=>crmWorkspaceService.conversationMessages(9,1,1,history({ limit: 5,beforeMessageId: cursor })));
    expect(older.data.map(message=>message.id)).toEqual([10,9,8,7,6]);
    expect(older.data.every(message=>!first.data.some(initial=>initial.id===message.id))).toBe(true);
    expect(older.pagination.hasMore).toBe(true);
    await expect(inProfile(101,()=>crmWorkspaceService.conversationMessages(9,1,1,history({ beforeMessageId: 26 })))).rejects.toMatchObject({ status: 400 });
  });

  it('notifies the responsible active member internally without sending to the customer',async()=>{
    const reminder = await inProfile(101,()=>reminderService.createActivityReminder(9,{ contactId: 1,title: 'Member follow-up',reminderDueAt: new Date(Date.now()+86_400_000),metadata: { assignedTo: 29,notifyContact: false } }));
    await fixtures.query('UPDATE crm_activity_reminders SET reminder_due_at=now()-interval \'1 minute\' WHERE id=$1',[reminder.id]);
    expect(await inProfile(101,()=>reminderService.processAndSendDueReminders())).toEqual({ processed: 1,errors: 0 });
    expect(sendAdminEmail).toHaveBeenCalledTimes(1);
    expect(sendAdminEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'member@test.example' }));
    const notified = (await inProfile(101,()=>reminderService.getActivityReminders(9,{ contactId: 1 })))[0];
    expect(notified.status).toBe('sent');
    expect((await inProfile(101,()=>crmService.getContactById(9,1)))!.nextFollowUpAt!.getTime()).toBe(notified.reminderDueAt.getTime());
  });

  it('moves contact follow-up to the retry date and retains the action after permanent notification failure',async()=>{
    const reminder = await inProfile(101,()=>reminderService.createActivityReminder(9,{ contactId: 1,title: 'Retry member follow-up',
      reminderDueAt: new Date(Date.now()+86_400_000),metadata: { assignedTo: 29,notifyContact: false } }));
    await fixtures.query("UPDATE crm_activity_reminders SET reminder_due_at=now()-interval '1 minute' WHERE id=$1",[reminder.id]);
    // A confirmed provider rejection is retryable; an unspecified outcome is not.
    sendAdminEmail.mockResolvedValue({ success: false,outcomeUncertain: false,error: 'Fixture delivery failure' });
    expect(await inProfile(101,()=>reminderService.processAndSendDueReminders())).toEqual({ processed: 0,errors: 1 });
    const retry = (await inProfile(101,()=>reminderService.getActivityReminders(9,{ contactId: 1 })))[0];
    expect(retry).toMatchObject({ status: 'pending',metadata: { retry_count: 1 },snoozedUntil: null,lastSentAt: null });
    expect(retry.metadata).toMatchObject({ notificationDeliveries: { initial: { internal: { state: 'failed' } } } });
    expect(retry.reminderDueAt.getTime()).toBeGreaterThan(Date.now());
    expect((await inProfile(101,()=>crmService.getContactById(9,1)))!.nextFollowUpAt!.getTime()).toBe(retry.reminderDueAt.getTime());
    await fixtures.query("UPDATE crm_activity_reminders SET reminder_due_at=now()-interval '1 minute',metadata=metadata||'{\"retry_count\":2}'::jsonb WHERE id=$1",[reminder.id]);
    expect(await inProfile(101,()=>reminderService.processAndSendDueReminders())).toEqual({ processed: 0,errors: 1 });
    const failed = (await inProfile(101,()=>reminderService.getActivityReminders(9,{ contactId: 1 })))[0];
    expect(failed.status).toBe('failed');
    expect((await inProfile(101,()=>crmService.getContactById(9,1)))!.nextFollowUpAt!.getTime()).toBe(failed.reminderDueAt.getTime());
    expect(publishEvent).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'reminder_delivery_failed',reminderId: reminder.id }) }));
  });

  it('retains an uncertain notification receipt without automatically retrying or moving the contact action',async()=>{
    const reminder = await inProfile(101,()=>reminderService.createActivityReminder(9,{ contactId: 1,title: 'Uncertain member follow-up',
      reminderDueAt: new Date(Date.now()+86_400_000),metadata: { assignedTo: 29,notifyContact: false } }));
    await fixtures.query("UPDATE crm_activity_reminders SET reminder_due_at=now()-interval '1 minute' WHERE id=$1",[reminder.id]);
    sendAdminEmail.mockResolvedValue({ success: false,error: 'Fixture transport lost after provider start' });
    expect(await inProfile(101,()=>reminderService.processAndSendDueReminders())).toEqual({ processed: 0,errors: 1 });
    const held = (await inProfile(101,()=>reminderService.getActivityReminders(9,{ contactId: 1 })))[0];
    expect(held).toMatchObject({ status: 'failed',snoozedUntil: null,metadata: { retry_count: 1,
      notificationDeliveries: { initial: { internal: { state: 'unknown' } } } } });
    expect(held.lastSentAt).toBeInstanceOf(Date);
    expect(held.sentAt).toBeNull();
    expect(held.reminderDueAt.getTime()).toBeLessThan(Date.now());
    expect((await inProfile(101,()=>crmService.getContactById(9,1)))!.nextFollowUpAt!.getTime()).toBe(held.reminderDueAt.getTime());
    expect(await inProfile(101,()=>reminderService.processAndSendDueReminders())).toEqual({ processed: 0,errors: 0 });
    expect(sendAdminEmail).toHaveBeenCalledTimes(1);
    const after = (await fixtures.query('SELECT metadata,last_sent_at FROM crm_activity_reminders WHERE id=$1',[reminder.id])).rows[0];
    expect(after.metadata.notificationDeliveries.initial.internal.state).toBe('unknown');
    expect(after.last_sent_at.getTime()).toBe(held.lastSentAt!.getTime());
  });

  it('uses inclusive UTC custom-report dates and excludes the first instant after the end date',async()=>{
    await fixtures.query("INSERT INTO crm_contacts(id,user_id,business_profile_id,first_name,created_at) VALUES(10,9,101,'Start boundary','2020-03-01 00:00:00'),(11,9,101,'End boundary','2020-03-03 23:59:59'),(12,9,101,'Outside boundary','2020-03-04 00:00:00')");
    const report = await inProfile(101,()=>crmWorkspaceService.reports(9,{ dateRange: 'custom',dateStart: '2020-03-01',dateEnd: '2020-03-03' }));
    expect(report.totalContacts).toBe(2);
    expect((await inProfile(101,()=>crmService.getContacts(9,{ dateRange: 'custom',dateStart: '2020-03-01',dateEnd: '2020-03-03' }))).total).toBe(2);
  });

  it('returns scoped summary, actor-aware combined timeline and actionable work totals',async()=>{
    await inProfile(101,()=>reminderService.createActivityReminder(9,{ contactId: 1,title: 'Call Ada',reminderDueAt: new Date(Date.now()+86_400_000),metadata: { assignedTo: 29 } }));
    const summary = await inProfile(101,()=>crmWorkspaceService.summary(9,-11));
    expect(summary.counts).toMatchObject({ conversations: 2,sentMessages: 3,activities: 4,tickets: 2,openTickets: 1,unreadConversations: 2,unreadMessages: 4 });
    expect(summary.owner?.id).toBe(29); expect(summary.nextReminder.title).toBe('Call Ada');
    const timeline = await inProfile(101,()=>crmWorkspaceService.timeline(9,1,history({ limit: 100 })));
    expect(new Set(timeline.data.map(item=>item.kind))).toEqual(new Set(['activity','conversation','ticket','reminder','automation']));
    expect(timeline.data.find(item=>item.id==='activity:1').actor.name).toBe('Member');
    expect(timeline.data.find(item=>item.id==='activity:4').actor).toBeNull();
    expect(JSON.stringify(timeline)).not.toContain('Private other profile');
    const work = await inProfile(101,()=>crmWorkspaceService.work(9,crmWorkQuerySchema.parse({ limit: 1 })));
    expect(work.items).toHaveLength(1); expect(work.total).toBeGreaterThan(1); expect(work.counts).toMatchObject({ reminder: 1,conversation: 2,ticket: 2 });
    const tickets = await inProfile(101,()=>crmWorkspaceService.work(9,crmWorkQuerySchema.parse({ type: 'ticket' })));
    expect(tickets.items.find(item=>item.entityId===4)).toMatchObject({ dueAt: null,overdue: false });
    expect(tickets.counts.conversation).toBe(2);
  });

  async function seedWorkFollowups() {
    await fixtures.query(`INSERT INTO crm_activity_reminders
      (id,user_id,business_profile_id,contact_id,title,reminder_type,status,reminder_due_at,snoozed_until,metadata) VALUES
      (201,9,101,1,'Legacy owner follow-up','followup','pending',now()-interval '120 days',NULL,'{}'),
      (202,9,101,1,'Explicit owner follow-up','followup','pending',now()-interval '2 days',NULL,'{"assignedTo":null}'),
      (203,9,101,2,'Member follow-up','followup','pending',now()-interval '1 day',NULL,'{"assignedTo":29,"priority":"high"}'),
      (204,9,101,1,'Upcoming follow-up','followup','pending',now()+interval '2 days',NULL,'{"assignedTo":9}'),
      (205,9,101,1,'Later follow-up','followup','pending',now()+interval '10 days',NULL,'{"assignedTo":29}'),
      (206,9,101,1,'Completed follow-up','followup','completed',now()-interval '1 day',NULL,'{}'),
      (207,9,101,1,'Cancelled follow-up','followup','cancelled',now()-interval '1 day',NULL,'{}'),
      (208,9,101,2,'Snoozed follow-up','followup','snoozed',now()-interval '1 day',now()+interval '3 days','{"assignedTo":29}'),
      (209,9,101,1,'Notified owner follow-up','followup','sent',now()-interval '3 days',NULL,'{}'),
      (210,9,101,2,'Failed notification follow-up','followup','failed',now()-interval '4 days',NULL,'{"assignedTo":29,"priority":"high"}'),
      (211,9,102,4,'Foreign business follow-up','followup','pending',now()-interval '200 days',NULL,'{"assignedTo":19}');`);
  }

  it('AS014 derives overdue eligibility and displayed dates from legacy open reminders without writing snapshots',async()=>{
    await fixtures.query(`INSERT INTO crm_activity_reminders
      (id,user_id,business_profile_id,contact_id,status,reminder_due_at,metadata) VALUES
      (201,9,101,1,'sent','2026-07-03 00:00:00','{}'),
      (202,9,101,1,'pending','2026-07-04 00:00:00','{"assignedTo":29}'),
      (203,9,101,2,'failed','2026-07-05 00:00:00','{}');
      UPDATE crm_contacts SET next_follow_up_at='2099-01-01' WHERE id=2;`);
    const before = (await fixtures.query('SELECT * FROM crm_contacts ORDER BY id')).rows;
    const reminderBefore = (await fixtures.query('SELECT * FROM crm_activity_reminders ORDER BY id')).rows;
    const overdue = await inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue',sortBy: 'nextFollowUpAt',sortOrder: 'asc' }));
    expect(overdue.total).toBe(2); expect(overdue.contacts.map(contact=>contact.id)).toEqual([1,2]);
    expect(overdue.contacts.map(contact=>contact.nextFollowUpAt)).toEqual(['2026-07-03T00:00:00.000Z','2026-07-05T00:00:00.000Z']);
    const work = await inProfile(101,()=>crmWorkspaceService.work(9,crmWorkQuerySchema.parse({ type: 'reminder' })));
    expect(new Set(work.items.map(item=>item.contactId))).toEqual(new Set([1,2]));
    for (const contactId of [1,2]) {
      const reminders = await inProfile(101,()=>reminderService.getActivityRemindersWithContacts(9,{ contactId }));
      const detail = await inProfile(101,()=>crmWorkspaceService.summary(9,contactId));
      expect(detail.nextReminder!.id).toBe(reminders[0].id);
      expect(detail.nextReminder!.dueDate).toBe(overdue.contacts.find(contact=>contact.id===contactId)!.nextFollowUpAt);
    }
    expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'none' }))).contacts.map(contact=>contact.id)).toEqual([-30]);
    expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'none',search: 'Ada' }))).total).toBe(0);
    expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue',search: 'Ada' }))).total).toBe(1);
    expect((await fixtures.query('SELECT * FROM crm_contacts ORDER BY id')).rows).toEqual(before);
    expect((await fixtures.query('SELECT * FROM crm_activity_reminders ORDER BY id')).rows).toEqual(reminderBefore);
    expect(sendAdminEmail).not.toHaveBeenCalled(); expect(publishEvent).not.toHaveBeenCalled(); expect(fireEvent).not.toHaveBeenCalled();
    // Optional browser handoff contains only synthetic rows from this schema.
    const browserFixture = process.env.AS014_BROWSER_FIXTURE;
    if (browserFixture) {
      if (!browserFixture.startsWith('/tmp/')) throw new Error('AS014 browser fixtures must be written under /tmp.');
      const collections: Record<string,unknown> = {};
      for (const followup of ['all','overdue','none','upcoming'] as const) {
        for (const search of ['', 'Ada']) {
          collections[`${followup}:${search}`] = await inProfile(101,()=>crmService.getContacts(9,{ followup: followup==='all' ? undefined : followup,search }));
        }
      }
      collections['overdue:Ada:high'] = await inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue',search: 'Ada',priority: 'high',ownerUserId: 29,pipelineStatus: 'new' }));
      writeFileSync(browserFixture,JSON.stringify({ collections,work,
        reminders: await inProfile(101,()=>reminderService.getActivityRemindersWithContacts(9)),
        contact: await inProfile(101,()=>crmService.getContactById(9,1)),
        summary: await inProfile(101,()=>crmWorkspaceService.summary(9,1)),
      }),{ mode: 0o600 });
    }
  });

  it('AS014 reconciles null, stale and correct snapshots on every read, including the inverse filter',async()=>{
    await fixtures.query(`INSERT INTO crm_contacts(id,user_id,business_profile_id,first_name,next_follow_up_at) VALUES
      (5,9,101,'No reminders','2020-01-01'),(6,9,101,'Closed reminders','2020-01-01'),
      (7,9,101,'Correct snapshot','2099-01-01');
      INSERT INTO crm_activity_reminders(id,user_id,business_profile_id,contact_id,status,reminder_due_at) VALUES
      (201,9,101,1,'sent','2020-01-01'),(202,9,101,2,'failed','2099-01-01'),
      (203,9,101,6,'completed','2020-01-01'),(204,9,101,6,'cancelled','2020-01-01'),
      (205,9,101,7,'pending','2099-01-01');`);
    for (let repeat=0;repeat<2;repeat++) {
      const all = await inProfile(101,()=>crmService.getContacts(9,{ sortBy: 'name',sortOrder: 'asc' }));
      const none = await inProfile(101,()=>crmService.getContacts(9,{ followup: 'none' }));
      expect(new Set(none.contacts.map(contact=>contact.id))).toEqual(new Set([-30,5,6]));
      expect(all.contacts.filter(contact=>[5,6,-30].includes(Number(contact.id))).every(contact=>contact.nextFollowUpAt===null)).toBe(true);
      expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'upcoming' }))).contacts.map(contact=>contact.id).sort()).toEqual([2,7]);
      expect((await inProfile(101,()=>crmService.getContacts(9,{ needsFollowUp: true }))).contacts.map(contact=>contact.id)).toEqual([1]);
    }
  });

  it('AS014 preserves contact counts, pagination, independent filters and stable ordering with many reminders',async()=>{
    await seedWorkFollowups();
    const pages = await Promise.all([1,2].map(page=>inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue',page,limit: 1,sortBy: 'name',sortOrder: 'asc' }))));
    expect(pages.flatMap(result=>result.contacts.map(contact=>contact.id))).toEqual([1,2]);
    for (const result of pages) { expect(result.total).toBe(2); expect(result.totalPages).toBe(2); expect(result.stages[0].count).toBe(2); }
    expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue',search: 'Ada',priority: 'high',pipelineStatus: 'new',ownerUserId: 29,tag: 'VIP',platforms: ['email'] }))).contacts.map(contact=>contact.id)).toEqual([1]);
    expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue',ownerUserId: 'unassigned' }))).contacts.map(contact=>contact.id)).toEqual([2]);
    expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue',search: 'Missing' }))).total).toBe(0);
    expect((await inProfile(101,()=>crmService.getContacts(9,{}))).total).toBe(3);
  });

  it('AS014 uses effective snooze dates, UTC instants and the exact overdue/upcoming boundary',async()=>{
    const boundary = '2030-01-01T00:00:00.000Z';
    await fixtures.query(`INSERT INTO crm_activity_reminders(id,user_id,business_profile_id,contact_id,status,reminder_due_at,snoozed_until,timezone) VALUES
      (201,9,101,1,'snoozed','2020-01-01','2030-01-02','Asia/Kolkata'),
      (202,9,101,2,'pending','2030-01-01',NULL,'America/New_York');`);
    jest.useFakeTimers({ doNotFake: ['nextTick','setImmediate','setTimeout','clearTimeout'] });
    jest.setSystemTime(new Date(boundary));
    try {
      const upcoming = await inProfile(101,()=>crmService.getContacts(9,{ followup: 'upcoming',sortBy: 'nextFollowUpAt',sortOrder: 'asc' }));
      expect(upcoming.contacts.map(contact=>contact.id)).toEqual([2,1]);
      expect(upcoming.contacts[0].nextFollowUpAt).toBe(boundary);
      expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue' }))).total).toBe(0);
      jest.setSystemTime(new Date('2030-01-03T00:00:00.000Z'));
      expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue' }))).total).toBe(2);
    } finally { jest.useRealTimers(); }
  });

  it('AS014 keeps notification, completion, cancellation and deletion transitions consistent with collection reads',async()=>{
    const soon = new Date(Date.now()-86_400_000), later = new Date(Date.now()+2*86_400_000);
    const first = await inProfile(101,()=>reminderService.createActivityReminder(9,{ contactId: 1,reminderDueAt: soon }));
    const second = await inProfile(101,()=>reminderService.createActivityReminder(9,{ contactId: 1,reminderDueAt: later }));
    const date = async()=>{
      const contact = (await inProfile(101,()=>crmService.getContacts(9,{ search: 'Ada' }))).contacts[0];
      expect(contact.nextFollowUpAt).toBe((await inProfile(101,()=>crmService.getContactById(9,1)))!.nextFollowUpAt?.toISOString() ?? null);
      return contact.nextFollowUpAt;
    };
    await inProfile(101,()=>reminderService.markReminderSent('activity',first.id)); expect(await date()).toBe(soon.toISOString());
    await inProfile(101,()=>reminderService.updateActivityReminder(9,first.id,{ status: 'failed' })); expect(await date()).toBe(soon.toISOString());
    expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue' }))).total).toBe(1);
    await inProfile(101,()=>reminderService.updateActivityReminder(9,first.id,{ snoozedUntil: later })); expect(await date()).toBe(later.toISOString());
    expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue' }))).total).toBe(0);
    await inProfile(101,()=>reminderService.updateActivityReminder(9,first.id,{ snoozedUntil: soon })); expect(await date()).toBe(soon.toISOString());
    expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue' }))).total).toBe(1);
    await inProfile(101,()=>reminderService.updateActivityReminder(9,first.id,{ status: 'completed' })); expect(await date()).toBe(later.toISOString());
    await inProfile(101,()=>reminderService.updateActivityReminder(9,second.id,{ status: 'cancelled' })); expect(await date()).toBeNull();
    const third = await inProfile(101,()=>reminderService.createActivityReminder(9,{ contactId: 1,reminderDueAt: later }));
    expect(await date()).toBe(later.toISOString());
    await inProfile(101,()=>reminderService.deleteActivityReminder(9,third.id)); expect(await date()).toBeNull();
    expect(sendAdminEmail).not.toHaveBeenCalled();
  });

  it('AS014 excludes foreign businesses/users and missing/deleted relationships without changing assignment scope',async()=>{
    await fixtures.query(`INSERT INTO crm_contacts(id,user_id,business_profile_id,first_name,deleted_at) VALUES(5,9,101,'Deleted',now());
      INSERT INTO crm_activity_reminders(id,user_id,business_profile_id,contact_id,status,reminder_due_at,metadata) VALUES
      (201,9,102,1,'sent','2020-01-01','{}'),(202,19,101,1,'failed','2020-01-01','{}'),
      (203,9,101,5,'pending','2020-01-01','{}'),(204,9,101,999,'pending','2020-01-01','{}'),
      (205,9,101,NULL,'pending','2020-01-01','{}'),(206,9,102,4,'sent','2020-01-01','{}');`);
    expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue' }))).total).toBe(0);
    expect((await inProfile(101,()=>crmService.getContacts(9,{ followup: 'none' }))).total).toBe(3);
    expect((await inProfile(102,()=>crmService.getContacts(9,{ followup: 'overdue' }))).contacts.map(contact=>contact.id)).toEqual([4]);
    await expect(inProfile(102,()=>reminderService.updateActivityReminder(9,206,{ status: 'completed' }))).resolves.toMatchObject({ status: 'completed' });
    await expect(inProfile(101,()=>reminderService.updateActivityReminder(9,206,{ status: 'pending' }))).resolves.toBeNull();
    expect((await fixtures.query('SELECT next_follow_up_at FROM crm_contacts WHERE id=1')).rows[0].next_follow_up_at).toBeNull();
  });

  it('AS014 reads a realistic synthetic collection with a constant query count and one row per contact',async()=>{
    await fixtures.query(`INSERT INTO crm_contacts(id,user_id,business_profile_id,first_name,priority,pipeline_status,last_activity_at)
      SELECT id,9,101,'Volume '||id,'high','new','2026-01-01' FROM generate_series(20000,24999) id;
      INSERT INTO crm_activity_reminders(id,user_id,business_profile_id,contact_id,status,reminder_due_at)
      SELECT 30000+row_number() OVER (),9,101,id,CASE WHEN copy=1 THEN 'sent' WHEN copy=2 THEN 'failed' ELSE 'pending' END,'2020-01-01'
      FROM generate_series(20000,24999) id CROSS JOIN generate_series(1,3) copy;
      ANALYZE crm_contacts; ANALYZE crm_activity_reminders;`);
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const dialect = new PgDialect();
    const executor = { execute: (query: SQL) => {
      queries.push(dialect.sqlToQuery(query));
      return database.execute(query);
    } };
    const start = performance.now();
    const result = await inProfile(101,()=>crmService.getContacts(9,{ followup: 'overdue',limit: 25,sortBy: 'nextFollowUpAt',sortOrder: 'asc' },executor));
    const elapsedMs = performance.now()-start;
    expect(queries).toHaveLength(3); // configuration + list + aggregate totals; independent of contact count.
    expect(result.total).toBe(5000); expect(result.totalPages).toBe(200);
    expect(result.contacts.map(contact=>contact.id)).toEqual(Array.from({ length: 25 },(_,index)=>20000+index));
    const plans = await inProfile(101,()=>Promise.all(queries.slice(1).map(query=>runtime.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query.sql}`,query.params))));
    const aggregates: Array<Record<string,unknown>> = [];
    const inspect = (node: Record<string,unknown>) => {
      if (node['Node Type']==='Aggregate' && node['Subplan Name']==='CTE followups') aggregates.push(node);
      for (const child of (node.Plans || []) as Array<Record<string,unknown>>) inspect(child);
    };
    for (const plan of plans) inspect(plan.rows[0]['QUERY PLAN'][0].Plan);
    expect(aggregates).toHaveLength(2);
    expect(aggregates.every(node=>node['Actual Loops']===1 && node['Actual Rows']===5000)).toBe(true);
    console.info('AS014 synthetic volume',JSON.stringify({ contacts: 5000,reminders: 15000,queries: queries.length,elapsedMs,
      executionMs: plans.map(plan=>plan.rows[0]['QUERY PLAN'][0]['Execution Time']),aggregateLoops: aggregates.map(node=>node['Actual Loops']),
    }));
  });

  it('AS002 includes old pending follow-ups and unfinished notified follow-ups across matching views',async()=>{
    await seedWorkFollowups();
    const work = await inProfile(101,()=>crmWorkspaceService.work(9,crmWorkQuerySchema.parse({ type: 'reminder',search: '' })));
    // Notification delivery is separate from the user's Mark complete action.
    expect(work.counts.reminder).toBe(7);
    expect(work.total).toBe(7);
    expect(work.items.map(item=>item.entityId)).toEqual([210,203,201,209,202,204,208]);
    const reminders = await inProfile(101,()=>reminderService.getActivityRemindersWithContacts(9));
    const horizon = Date.now()+7*86_400_000;
    const eligible = reminders.filter(item=>!['completed','cancelled'].includes(item.status) && new Date(item.dueDate).getTime()<horizon);
    expect(new Set(work.items.map(item=>item.entityId))).toEqual(new Set(eligible.map(item=>item.id)));
    for (const contactId of [1,2]) {
      const detail = await inProfile(101,()=>reminderService.getActivityRemindersWithContacts(9,{ contactId }));
      const detailEligible = detail.filter(item=>!['completed','cancelled'].includes(item.status) && new Date(item.dueDate).getTime()<horizon);
      expect(new Set(work.items.filter(item=>item.contactId===contactId).map(item=>item.entityId)))
        .toEqual(new Set(detailEligible.map(item=>item.id)));
    }
    const summary = await inProfile(101,()=>crmWorkspaceService.summary(9,1));
    expect(summary.upcomingReminders.map(item=>item.id)).toEqual([201,209,202,204,205]);
    const foreign = await inProfile(102,()=>crmWorkspaceService.work(9,crmWorkQuerySchema.parse({ type: 'reminder' })));
    expect(foreign.total).toBe(1);
    expect(foreign.items.map(item=>item.entityId)).toEqual([211]);
  });

  it('AS002 keeps workspace-owner assignment, search, category counts and pagination consistent',async()=>{
    await seedWorkFollowups();
    const query = (input: Record<string,unknown>)=>inProfile(101,()=>crmWorkspaceService.work(9,crmWorkQuerySchema.parse({ type: 'reminder',...input })));
    const owner = await query({ ownerUserId: 9 });
    // Legacy/missing and explicit-null assignments mean Workspace owner, even
    // when the contact itself is assigned to an individual team member.
    expect(owner.items.map(item=>item.entityId)).toEqual([201,209,202,204]);
    expect(owner.counts.reminder).toBe(4); expect(owner.total).toBe(4);
    const member = await query({ ownerUserId: 29 });
    expect(member.items.map(item=>item.entityId)).toEqual([210,203,208]);
    expect((await query({ ownerUserId: 'unassigned' })).total).toBe(0);
    const searched = await query({ search: 'Notified' });
    expect(searched.counts.reminder).toBe(1); expect(searched.items.map(item=>item.entityId)).toEqual([209]);
    const byContact = await query({ search: 'Ada' });
    expect(byContact.counts.reminder).toBe(4); expect(byContact.items).toHaveLength(4);
    const empty = await query({ search: 'No matching contact' });
    expect(empty.counts.reminder).toBe(0); expect(empty.items).toEqual([]);
    const pages = await Promise.all([1,2,3,4].map(page=>query({ page,limit: 2 })));
    expect(pages.flatMap(page=>page.items.map(item=>item.entityId))).toEqual([210,203,201,209,202,204,208]);
    for (const page of pages) { expect(page.total).toBe(7); expect(page.totalPages).toBe(4); expect(page.counts.reminder).toBe(7); }
    const all = await query({ type: 'all' });
    expect(all.counts.reminder).toBe(7);
    expect(all.items.filter(item=>item.type==='reminder')).toHaveLength(7);
  });

  it('AS002 retains an actionable contact follow-up after its notification is sent',async()=>{
    const due = new Date(Date.now()+86_400_000);
    const reminder = await inProfile(101,()=>reminderService.createActivityReminder(9,{ contactId: 1,title: 'Notify then act',reminderDueAt: due }));
    await inProfile(101,()=>reminderService.markReminderSent('activity',reminder.id));
    const contact = await inProfile(101,()=>crmService.getContactById(9,1));
    expect(contact!.nextFollowUpAt!.getTime()).toBe(due.getTime());
    const work = await inProfile(101,()=>crmWorkspaceService.work(9,crmWorkQuerySchema.parse({ type: 'reminder' })));
    expect(work.items).toHaveLength(1); expect(work.items[0].status).toBe('sent');
    await inProfile(101,()=>reminderService.updateActivityReminder(9,reminder.id,{ status: 'completed' }));
    expect((await inProfile(101,()=>crmService.getContactById(9,1)))!.nextFollowUpAt).toBeNull();
    expect((await inProfile(101,()=>crmWorkspaceService.work(9,crmWorkQuerySchema.parse({ type: 'reminder' })))).total).toBe(0);
  });

  it('executes custom date reports and matching drilldowns without double-counting multi-channel contacts',async()=>{
    const dateStart = new Date(Date.now()-30*86_400_000).toISOString().slice(0,10);
    const dateEnd = new Date().toISOString().slice(0,10);
    const report = await inProfile(101,()=>crmWorkspaceService.reports(9,{ platforms: ['email','whatsapp'],dateRange: 'custom',dateStart,dateEnd }));
    expect(report.totalContacts).toBe(1); expect(report.channels.map(row=>row.channel).sort()).toEqual(['email','whatsapp']);
    expect(report.channels.every(row=>row.contacts===1)).toBe(true);
    expect(report.stageDurations).not.toHaveLength(0);
    const drilldown = await inProfile(101,()=>crmService.getContacts(9,{ platforms: ['email','whatsapp'],dateRange: 'custom',dateStart,dateEnd }));
    expect(drilldown.total).toBe(report.totalContacts);
    const beyond = await inProfile(101,()=>crmWorkspaceService.reports(9,{ dateRange: 'custom',from: '2020-01-01',to: '2020-01-31' }));
    expect(beyond.totalContacts).toBe(0);
  });

  it('keeps Gmail report rows, contact drilldowns and CSV distinct from Email and scoped to the same creation cohort', async () => {
    await fixtures.query(`INSERT INTO crm_contacts(id,user_id,business_profile_id,first_name,email,pipeline_status,created_at,updated_at) VALUES
      (5,9,101,'Old Gmail','old-gmail@example.test','new',now()-interval '45 days',now()),
      (6,19,101,'Foreign owner Gmail','foreign-owner-gmail@example.test','new',now(),now());
      INSERT INTO outreach_conversations(id,user_id,business_profile_id,crm_contact_id,channel,total_messages,unread_count,last_message_at) VALUES
      (4,9,101,2,'gmail',3,1,now()),(5,9,101,2,'gmail',4,0,now()),
      (6,9,102,4,'gmail',8,0,now()),(7,19,101,6,'gmail',8,0,now()),(8,9,101,5,'gmail',8,0,now());`);
    const report = await inProfile(101, () => crmWorkspaceService.reports(9, { platforms: ['all'], dateRange: '30d' }));
    const gmail = report.channels.find(row => row.channel === 'gmail')!;
    expect(gmail).toMatchObject({ contacts: 1, conversations: 2, messages: 7 });
    expect(report.channels.find(row => row.channel === 'email')).toMatchObject({ contacts: 1 });
    const gmailFilters = crmContactsQuerySchema.parse({ platforms: 'gmail', dateRange: '30d' });
    const contacts = await inProfile(101, () => crmService.getContacts(9, gmailFilters));
    expect(contacts.total).toBe(gmail.contacts);
    expect(contacts.contacts.map(contact => contact.id)).toEqual([2]);
    const email = await inProfile(101, () => crmService.getContacts(9, { platforms: ['email'], dateRange: '30d' }));
    expect(email.contacts.map(contact => contact.id)).toEqual([1]);
    const scopedReport = await inProfile(101, () => crmWorkspaceService.reports(9, gmailFilters));
    expect(scopedReport.totalContacts).toBe(1);
    expect(scopedReport.channels.map(row => row.channel)).toEqual(['gmail']);
    const exported = await inProfile(101, () => crmWorkspaceService.exportContacts(9, gmailFilters));
    expect(exported.exported).toBe(gmail.contacts);
    expect(exported.csv).toContain('ben@test.example');
    for (const excluded of ['ada@test.example', 'foreign@test.example', 'old-gmail@example.test', 'foreign-owner-gmail@example.test']) expect(exported.csv).not.toContain(excluded);
  });

  it('exports the entire filtered result with formula-safe cells and excludes the sibling profile',async()=>{
    await fixtures.query("UPDATE crm_contacts SET first_name='=DANGEROUS()' WHERE id=1");
    const exported = await inProfile(101,()=>crmWorkspaceService.exportContacts(9,{ priority: 'high',sortBy: 'name' }));
    expect(exported).toMatchObject({ total: 1,exported: 1,truncated: false });
    expect(exported.csv).toContain('"\'=DANGEROUS()"'); expect(exported.csv).not.toContain('Other profile');
  });

  it('keeps campaign ownership and explicit associations in exports and filtered board totals',async()=>{
    await fixtures.query(`INSERT INTO chat_threads(id,user_id,business_profile_id) VALUES(81,9,101),(82,9,102);
      INSERT INTO campaign_crm_contacts(user_id,business_profile_id,contact_id,thread_id) VALUES(9,101,1,81),(9,102,4,82);`);
    const collection = await inProfile(101,()=>crmService.getContacts(9,{ threadId: 81 }));
    expect(collection.total).toBe(1); expect(collection.contacts.map(contact=>contact.id)).toEqual([1]);
    const exported = await inProfile(101,()=>crmWorkspaceService.exportContacts(9,{ threadId: 81 }));
    expect(exported).toMatchObject({ total: 1,exported: 1,truncated: false });
    expect(exported.csv).toContain('ada@test.example'); expect(exported.csv).not.toContain('ben@test.example');
    await expect(inProfile(101,()=>crmWorkspaceService.exportContacts(9,{ threadId: 82 }))).rejects.toMatchObject({ status: 404 });
  });
});
