import { beforeAll, beforeEach, afterAll, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { semanticIntent } from './helpers/supportSemanticFixture.js';

const url = process.env.PROPOSAL_QA_DATABASE_URL;
const local = url ? describe : describe.skip;
let database: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, { get: (_target, key) => {
  const value = Reflect.get(database, key);
  return typeof value === 'function' ? value.bind(database) : value;
} }) }));
const { supportPlaybooksTable, supportPlaybookVersionsTable, supportPlaybookRunsTable, supportPlaybookAssignmentsTable } =
  await import('../models/supportOrchestration/schema.js');
const { playbookEngine } = await import('../services/agents/orchestration/PlaybookEngine.js');
const { createProposalSupportPlaybooks } = await import('../services/agents/orchestration/ProposalSupportConfiguration.js');
const { initializeJourneyState } = await import('../services/agents/orchestration/SupportJourneyRuntime.js');
const proposalGraph = createProposalSupportPlaybooks(['hotel_sales'])[0].graph;
const oldGraph = { schemaVersion: 2 as const, entryNodeId: 'collect', fields: [
  { key: 'room.adults', type: 'integer' as const, required: true, pii: 'none' as const, prompt: 'How many adults?' },
  { key: 'corporate.attendees', type: 'integer' as const, required: true, pii: 'none' as const, prompt: 'How many attendees?' },
  { key: 'contact.name', type: 'text' as const, required: true, pii: 'contact' as const, prompt: 'Your name?' },
], nodes: [{ id: 'collect', type: 'collect' as const, data: { fieldKeys: ['contact.name'] } },
  { id: 'document', type: 'capability' as const, data: { capabilityName: 'asset.deliver', args: { service: { source: 'constant', value: 'stay' } } } }],
edges: [{ source: 'collect', target: 'document', condition: { operator: 'all_required_fields_present' as const } }] };

local('automatic document and proposal routing on real isolated PostgreSQL', () => {
  let admin: Pool; let fixture: Pool;
  const schema = `support_auto_docs_${randomBytes(8).toString('hex')}`;
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname)) throw new Error('Local QA database required.');
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    fixture = new Pool({ connectionString: url, max: 4, options: `-c search_path=${schema},pg_catalog` });
    database = drizzle(fixture);
    for (const table of [supportPlaybooksTable, supportPlaybookVersionsTable, supportPlaybookRunsTable, supportPlaybookAssignmentsTable]) {
      const config = getTableConfig(table);
      await fixture.query(`CREATE TABLE "${config.name}" (${config.columns.map(column =>
        `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`).join(',')})`);
    }
    await fixture.query(`CREATE UNIQUE INDEX active_run ON support_playbook_runs(user_id,conversation_id) WHERE status='active';
      CREATE UNIQUE INDEX run_sequence ON support_playbook_runs(user_id,conversation_id,playbook_id,run_sequence);
      CREATE TABLE ai_agent_configs(user_id integer,agent_type text,enabled boolean,channel_scope jsonb);`);
  });
  afterAll(async () => {
    await fixture?.end();
    if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
  });
  beforeEach(async () => {
    await fixture.query('TRUNCATE support_playbook_runs,support_playbook_assignments,support_playbooks,support_playbook_versions,ai_agent_configs RESTART IDENTITY');
    await fixture.query(`INSERT INTO ai_agent_configs VALUES(9,'hotel_sales',true,'["web","whatsapp"]');
      INSERT INTO support_playbooks(id,user_id,agent_type,status,enabled,active_version) VALUES
        (1,9,'hotel_sales','published',true,1),(2,9,'hotel_sales','published',true,1);
      INSERT INTO support_playbook_assignments(user_id,playbook_id,agent_type,intent,enabled,traffic_percent,priority)
        VALUES(9,2,'hotel_sales','proposal_request',true,100,90)`);
    await fixture.query('INSERT INTO support_playbook_versions(playbook_id,version,graph) VALUES(1,1,$1),(2,1,$2)',
      [JSON.stringify(oldGraph), JSON.stringify(proposalGraph)]);
    const state = initializeJourneyState(oldGraph);
    state.fields['room.adults'] = { value: 2, status: 'collected', source: 'customer' };
    state.fields['corporate.attendees'] = { value: 35, status: 'collected', source: 'customer' };
    await fixture.query(`INSERT INTO support_playbook_runs(user_id,conversation_id,playbook_id,playbook_version,run_sequence,
      current_node_id,status,state) VALUES(9,-700,1,1,1,'document','active',$1)`,
    [JSON.stringify({ ...state, agentType: 'hotel_sales' })]);
  });
  const request = () => ({ userId: 9, conversationId: -700, channel: 'web', agentType: 'hotel_sales',
    intent: 'booking_request', inboundText: 'Please prepare a custom written offer for the deluxe room.', eventKey: 'proposal-turn',
    semanticRequest: semanticIntent('proposal_create', 'stay'),
    entities: { proposalTitle: 'Deluxe room offer', proposalContext: 'A custom offer for a deluxe room' } });

  it('leaves the document step, retains prior facts, and executes the proposal capability instead of attaching a brochure', async () => {
    const result = await playbookEngine.resolve(request());
    expect(result?.playbookId).toBe(2);
    expect(result?.requiredAction).toBe('create_conversation_proposal_draft');
    expect(result?.actionArgs?.context).toContain('"room.adults":2');
    expect(result?.actionArgs?.context).not.toContain('contact.name');
    expect(result?.actionArgs?.context).not.toContain('corporate.attendees');
    expect(result?.documentService).toBeUndefined();
    const runs = (await fixture.query('SELECT * FROM support_playbook_runs ORDER BY id')).rows;
    expect(runs).toHaveLength(2);
    expect(runs[0].status).toBe('superseded');
    expect(runs[0].current_node_id).toBe('document');
    expect(runs[0].state.fields['room.adults'].value).toBe(2);
    expect(runs[1].status).toBe('active');
    const replay = await playbookEngine.resolve(request());
    expect(replay?.runId).toBe(result?.runId);
    expect(replay?.actionArgs).toEqual(result?.actionArgs);
    expect((await fixture.query('SELECT count(*)::int AS n FROM support_playbook_runs')).rows[0].n).toBe(2);
    await playbookEngine.commitProposedTransition(9,result!.runId,{ capabilityName: 'proposal.request', capabilityStatus: 'success', deliveryStatus: 'sent' });
    expect((await fixture.query('SELECT status FROM support_playbook_runs WHERE id=$1',[result!.runId])).rows[0].status).toBe('completed');
  });

  it('serializes concurrent copies of the same proposal request into one new run', async () => {
    const results = await Promise.all([playbookEngine.resolve(request()), playbookEngine.resolve(request())]);
    expect(results[0]?.runId).toBe(results[1]?.runId);
    expect((await fixture.query("SELECT count(*)::int AS n FROM support_playbook_runs WHERE status='active'")).rows[0].n).toBe(1);
  });

  it('does not supersede intake for a disabled proposal assignment', async () => {
    await fixture.query('UPDATE support_playbook_assignments SET enabled=false');
    const result = await playbookEngine.resolve(request());
    expect(result?.requiredAction).not.toBe('create_conversation_proposal_draft');
    expect((await fixture.query("SELECT count(*)::int AS n FROM support_playbook_runs WHERE status='superseded'")).rows[0].n).toBe(0);
  });

  it('finds the document information lane without any linked playbook or customer run', async () => {
    const result = await playbookEngine.resolve({ ...request(), conversationId: -701,
      intent: 'faq', semanticRequest: semanticIntent('document', 'day_outing'),
      inboundText: 'Could you share the day visit brochure?', entities: {} });
    expect(result).toMatchObject({ runId: 0, playbookId: 0, readOnlyInformation: true });
    expect((await fixture.query('SELECT count(*)::int AS n FROM support_playbook_runs WHERE conversation_id=-701')).rows[0].n).toBe(0);
  });
});
