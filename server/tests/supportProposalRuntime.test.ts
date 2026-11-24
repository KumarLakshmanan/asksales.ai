import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SubAgentContext, SubAgentResult } from '../services/agents/subagents/SubAgentBase.js';
import type { ProposalDocumentMetadata } from '../../shared/proposals.js';

const dialect = new PgDialect();
const predicates: Array<{ table: string; sql: string; params: unknown[] }> = [];
const statements: Array<{ sql: string; params: unknown[] }> = [];
const executions: Array<Record<string, any>> = [];
let records: Record<string, unknown>[] = [];
let items: Record<string, unknown>[] = [];
let conversationAvailable = true;
let originalStillCurrent = true;
const createProposal = jest.fn<(...args: any[]) => Promise<any>>();
const approvals = { findByThread: jest.fn(), create: jest.fn() };
const select = jest.fn(() => ({ from: (table: any) => {
  const tableName = getTableName(table);
  let params: unknown[] = [];
  const rows = () => tableName === 'outreach_conversations' ? (conversationAvailable ? [{ id: 7 }] : [])
    : tableName === 'proposals' ? records
      : tableName === 'proposal_line_items' ? items
        : tableName === 'support_tool_executions' ? executions.filter(row => row.userId === params[0] && row.idempotencyKey === params[1]) : [];
  const chain: any = {
    where: (where: any) => { const query = dialect.sqlToQuery(where); params = query.params; predicates.push({ table: tableName, ...query }); return chain; },
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: any, reject: any) => Promise.resolve(rows()).then(resolve, reject),
  };
  return chain;
} }));
const insert = jest.fn((table: any) => ({ values: (values: Record<string, unknown>) => ({
  onConflictDoNothing: () => ({ returning: async () => {
    expect(getTableName(table)).toBe('support_tool_executions');
    if (executions.some(row => row.idempotencyKey === values.idempotencyKey)) return [];
    const row = { id: executions.length + 1, ...values };
    executions.push(row);
    return [row];
  } }),
}) }));
const update = jest.fn((table: any) => ({ set: (values: Record<string, unknown>) => ({ where: async (where: any) => {
  expect(getTableName(table)).toBe('support_tool_executions');
  const id = dialect.sqlToQuery(where).params[0];
  const existing = executions.find(row => row.id === id);
  if (existing) Object.assign(existing, values);
  return existing ? [existing] : [];
} }) }));
const execute = jest.fn(async (statement: any) => {
  const query = dialect.sqlToQuery(statement);
  statements.push(query);
  if (query.sql.includes('SELECT id FROM proposals')) return { rows: originalStillCurrent ? [{ id: 41 }] : [] };
  if (query.sql.includes('INSERT INTO proposal_feedback')) return { rows: [{ id: 71 }] };
  return { rows: [] };
});
const mockDb: any = { select, insert, update, execute, transaction: async (callback: any) => callback(mockDb) };
jest.unstable_mockModule('../models/db.js', () => ({ db: mockDb }));
jest.unstable_mockModule('../models/toolApprovals/functions.js', () => ({ ToolApprovalModel: approvals }));
jest.unstable_mockModule('../services/ProposalService.js', () => ({ proposalService: { createProposal } }));
const widgetIdentity = jest.fn<any>(async () => ({conversationId:7,leadId:31}));
jest.unstable_mockModule('../services/agents/orchestration/SupportWidgetProposalIdentity.js', () => ({ resolveWidgetProposalIdentity:widgetIdentity }));

const { proposalSubAgent, customerProposalSummary, revisionDocumentMetadata } = await import('../services/agents/subagents/ProposalSubAgent.js');
const { safeToolExecutor, supportToolRisk, supportToolIdempotencyKey, SUPPORT_TOOL_NAMES } = await import('../services/agents/orchestration/SafeToolExecutor.js');
const { supportAgentRuntime } = await import('../services/agents/orchestration/SupportAgentRuntime.js');
const { validateSupportToolArgs } = await import('../services/agents/orchestration/SupportToolSchemas.js');
const { PROPOSAL_SUPPORT_TOOLS } = await import('../services/agents/orchestration/ProposalSupportConfiguration.js');
const priorKey = process.env.SUPPORT_PII_ENCRYPTION_KEY;
process.env.SUPPORT_PII_ENCRYPTION_KEY = 'isolated-proposal-support-fixture-key-32-characters';
afterAll(() => {
  if (priorKey === undefined) delete process.env.SUPPORT_PII_ENCRYPTION_KEY;
  else process.env.SUPPORT_PII_ENCRYPTION_KEY = priorKey;
});

const context = (overrides: Partial<SubAgentContext> = {}): SubAgentContext => ({
  userId: 9, conversationId: 7, channel: 'whatsapp', inboundText: 'Please send a proposal for website design',
  rawMessageId: 'provider-inbound-1', messageId: 12,
  nlu: { intent: 'proposal_request' }, slots: {}, memory: {}, intel: {},
  lead: { id: 31, name: 'Fixture Customer' },
  agentConfig: { agentType: 'general_service', toolsEnabled: [...PROPOSAL_SUPPORT_TOOLS] },
  history: [], executionMode: 'customer', ...overrides,
} as SubAgentContext);
const source = (overrides: Record<string, unknown> = {}) => ({
  id: 41, userId: 9, leadId: 31, outreachConversationId: 7, proposalNumber: 'PROP-2030-9-001-ABCD',
  title: 'Website design', status: 'sent', sentAt: new Date('2030-01-01'), validUntil: new Date('2030-12-31'),
  subtotal: '1000.00', discountType: 'percentage', discountValue: '10.00', taxRate: '18.00', total: '1062.00', currency: 'USD',
  coverNote: 'Agreed scope', termsAndConditions: 'Customer terms', signatureRequired: true, showTermsAndConditions: true,
  revision: 1, signedAt: null, contactId: 5, businessProfileId: 22, templateId: 3, knowledgeBaseSections: [2],
  metadata: { generatedSections: [{ title: 'Scope', kind: 'content', body: 'Landing page' }],
    commercial: { packages: [{ id: 'standard', name: 'Standard' }], selectedPackageId: 'standard' },
    requirements: { deliverables: 'Two landing pages', timeline: 'October' },
    onboardingPlan: { teamId: 4, assignedMemberId: 8, dueDate: '2030-11-15' },
    templateSnapshot: { name: 'Website template', version: 2, content: { sections: [], placeholders: [], warnings: [], requiredFields: ['client_name', 'project_goal'] } },
    templateValues: { project_goal: 'Increase qualified demos' }, requiredTemplateFields: ['client_name', 'project_goal'],
    approvalRequired: false, approvedAt: '2030-01-01', approvalFingerprint: 'internal-approval',
    approvalRequests: [{ secret: 'finance comments' }], deliveryTarget: { email: 'private@example.test' },
    deliveryAttempt: { publicToken: 'internal-token' }, supportRequest: { context: 'previous request' },
    assumptions: ['Internal scope assumption'], autoOnboard: true },
  ...overrides,
});
const safeCall = (name: string, args: Record<string, unknown>, ctx = context()): Promise<SubAgentResult> =>
  safeToolExecutor.execute(name, args, ctx, () => proposalSubAgent.execute(name, args, ctx));

beforeEach(() => {
  jest.clearAllMocks(); predicates.length = 0; statements.length = 0; executions.length = 0;
  records = []; items = []; conversationAvailable = true; originalStillCurrent = true;
  widgetIdentity.mockResolvedValue({conversationId:7,leadId:31});
  createProposal.mockImplementation(async (_userId: number, data: Record<string, unknown>) => ({ id: 99, status: 'draft', ...data }));
});

describe('support proposal customer data boundary', () => {
  it.each([0, 31])('does not claim a widget draft was created for lead %s without an authenticated widget session', async leadId => {
    const ctx = context({ channel: 'web', conversationId: -17, lead: { id: leadId } as any });
    const output = await proposalSubAgent.execute('create_conversation_proposal_draft', { title: 'Local widget QA offer' }, ctx);
    expect(output.toolResults?.[0].result).toMatchObject({
      success: false, code: 'conversation_proposal_unavailable', confirmedSideEffect: false,
    });
    expect(createProposal).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(widgetIdentity).not.toHaveBeenCalled();
  });

  it('creates a widget draft through the governed executor with only its server-bound identity', async () => {
    const ctx = context({channel:'web',conversationId:-21,lead:{id:0},widgetSession:{id:21,token:'session-credential'}});
    const output = await safeCall('create_conversation_proposal_draft',{title:'Requested offer'},ctx);
    expect(widgetIdentity).toHaveBeenCalledWith({userId:9,sessionId:21,token:'session-credential',create:true});
    expect(createProposal).toHaveBeenCalledWith(9,expect.objectContaining({outreachConversationId:7,leadId:31,approvalRequired:true}));
    expect(output.toolResults?.[0].result).toMatchObject({success:true,delivered:false,seller_review_required:true});
    expect(JSON.stringify(output)).not.toContain('session-credential');
  });
  it('keeps uncredentialed widget requests and failed session bindings away from customer proposals', async () => {
    const ctx = context({channel:'web',conversationId:-21,lead:{id:0}});
    await safeCall('get_conversation_proposals',{},ctx);
    expect(widgetIdentity).not.toHaveBeenCalled(); expect(createProposal).not.toHaveBeenCalled();
    widgetIdentity.mockResolvedValue(null);
    await safeCall('create_conversation_proposal_draft',{title:'Requested offer'},
      {...ctx,widgetSession:{id:21,token:'bad'}});
    expect(createProposal).not.toHaveBeenCalled();
  });
  it.each(['whatsapp', 'facebook', 'instagram', 'email', 'sms', 'linkedin', 'twitter'])('looks up only this verified customer conversation on %s', async channel => {
    records = [source(), source({ id: 42, title: 'INTERNAL_DRAFT_TITLE', total: '12.00', status: 'draft', sentAt: null })];
    const output = await safeCall('get_conversation_proposals', {}, context({ channel }));
    expect(output.toolResults?.[0].result).toMatchObject({ success: true, confirmedSideEffect: false, proposals: [
      { proposal_id: 41, title: 'Website design', subtotal: '1000.00', discount: '100.00', tax: '162.00', total: '1062.00' },
      { proposal_id: 42, status: 'awaiting_seller_review' },
    ] });
    expect(JSON.stringify(output)).not.toMatch(/INTERNAL_DRAFT_TITLE|internal-approval|finance comments|Internal scope assumption|internal-token|private@example/);
    const conversation = predicates.find(item => item.table === 'outreach_conversations')!;
    expect(conversation.params).toEqual([9, 7, 31, channel]);
    const proposal = predicates.find(item => item.table === 'proposals')!;
    expect(proposal.params).toEqual([9, 7, 31]);
    expect(proposal.sql).toContain('"outreach_conversation_id" =');
    expect(proposal.sql).toContain('"lead_id" is null');
    expect(createProposal).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('applies tenant, conversation and lead checks even for a caller-supplied proposal ID', async () => {
    const output = await proposalSubAgent.execute('get_conversation_proposals', { proposal_id: 123456 }, context());
    expect(output.toolResults?.[0].result.proposals).toEqual([]);
    expect(predicates.find(item => item.table === 'proposals')!.params).toEqual([9, 7, 31, 123456]);
  });

  it.each(['facebook_comment', 'instagram_comment', 'support_portal'])('does not disclose private proposals in %s', async channel => {
    const output = await proposalSubAgent.execute('get_conversation_proposals', {}, context({ channel }));
    expect(output.toolResults?.[0].result).toMatchObject({ success: false, code: 'conversation_proposal_unavailable' });
    expect(select).not.toHaveBeenCalled();
  });

  it('fails closed for a conversation whose tenant, lead or channel no longer matches', async () => {
    conversationAvailable = false;
    const output = await proposalSubAgent.execute('create_conversation_proposal_draft', { title: 'Offer' }, context());
    expect(output.toolResults?.[0].result.code).toBe('conversation_proposal_unavailable');
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('treats a draft or unconfirmed delivery as internal and reports expiry without a database mutation', () => {
    for (const status of ['draft', 'sending', 'delivery_unknown']) {
      expect(customerProposalSummary(source({ status }) as any)).toEqual({ proposal_id: 41, proposal_number: undefined, status: 'awaiting_seller_review' });
    }
    expect(customerProposalSummary(source({ validUntil: new Date('2000-01-01') }) as any).status).toBe('expired');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('governed proposal tool execution', () => {
  it('registers only a safe read and reviewable draft/request writes, never approval or sending', () => {
    expect(supportToolRisk('get_conversation_proposals')).toBe('read');
    expect(supportToolRisk('create_conversation_proposal_draft')).toBe('write');
    expect(supportToolRisk('request_proposal_revision')).toBe('write');
    for (const name of ['send_proposal', 'approve_proposal', 'accept_proposal', 'generate_proposal_public_link']) {
      expect(SUPPORT_TOOL_NAMES.has(name)).toBe(false);
    }
  });

  it.each(['userId', 'leadId', 'contactId', 'outreachConversationId', 'recipientEmail', 'approvalRequired', 'lineItems', 'metadata', 'draftKey'])('rejects model-controlled %s before persistence', async key => {
    const output = await safeCall('create_conversation_proposal_draft', { title: 'Website design', [key]: 'forged' });
    expect(output.toolResults?.[0].result.code).toBe('invalid_tool_arguments');
    expect(select).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled(); expect(createProposal).not.toHaveBeenCalled();
  });

  it.each(['preview', 'advisory'] as const)('suppresses reads and writes in %s even if dryRun was omitted', async executionMode => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['get_conversation_proposals', {}], ['create_conversation_proposal_draft', { title: 'Website design' }],
      ['request_proposal_revision', { proposal_id: 41, requested_changes: 'Move the deadline to November' }],
    ];
    for (const [name, args] of cases) {
      const ctx = context({ executionMode, dryRun: false });
      expect((await safeCall(name, args, ctx)).toolResults?.[0].result.code).toBe('dry_run_suppressed');
      expect((await proposalSubAgent.execute(name, args, ctx)).toolResults?.[0].result.code).toBe('dry_run_suppressed');
    }
    expect(select).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(createProposal).not.toHaveBeenCalled();
  });

  it('respects disabled tools and the published capability boundary', async () => {
    const disabled = context({ agentConfig: { toolsEnabled: [] } });
    expect((await safeCall('create_conversation_proposal_draft', { title: 'Website design' }, disabled)).toolResults?.[0].result.code).toBe('tool_not_enabled');
    const scope = context({ playbookDirective: { playbookId: 1, version: 1, runId: 1, nodeId: 'read', nodeType: 'capability', requiredAction: 'get_conversation_proposals', capability: { name: 'proposal.list', kind: 'tool', args: {} } } as any });
    expect((await safeCall('create_conversation_proposal_draft', { title: 'Website design' }, scope)).toolResults?.[0].result.code).toBe('tool_outside_current_capability');
    expect(select).not.toHaveBeenCalled(); expect(approvals.create).not.toHaveBeenCalled();
  });

  it('binds a new draft to trusted identities and requires seller review without taking over the conversation', async () => {
    const args = { title: ' Website design ', context: 'Two landing pages', requirements: { deliverables: 'Two pages', timeline: 'October', budget: 'Discuss with seller' } };
    const output = await safeCall('create_conversation_proposal_draft', args);
    expect(createProposal).toHaveBeenCalledWith(9, expect.objectContaining({ title: 'Website design', outreachConversationId: 7, leadId: 31,
      approvalRequired: true, draftKey: expect.stringMatching(/^support-tool:/), requirements: args.requirements,
      metadata: { supportRequest: expect.objectContaining({ source: 'customer_support', context: 'Two landing pages', channel: 'whatsapp' }) } }));
    expect(output.escalated).not.toBe(true);
    expect(output.escalationType).toBeUndefined();
    expect(output).toMatchObject({ toolResults: [{ name: 'create_conversation_proposal_draft', result: {
      success: true, confirmedSideEffect: true, seller_review_required: true, delivered: false, proposal_id: 99, status: 'awaiting_seller_review',
    } }] });
    expect(supportAgentRuntime.recordToolOutcome('create_conversation_proposal_draft', args, output)).toMatchObject({ status: 'success', confirmedSideEffect: true });
    expect(approvals.create).not.toHaveBeenCalled();
  });

  it('reuses the durable success for the same provider event and uses different keys across events/tenants', async () => {
    const args = { title: 'Website design' };
    const ctx = context();
    const first = await safeCall('create_conversation_proposal_draft', args, ctx);
    const second = await safeCall('create_conversation_proposal_draft', args, ctx);
    expect(second).toEqual(first); expect(createProposal).toHaveBeenCalledTimes(1); expect(executions).toHaveLength(1);
    expect(supportToolIdempotencyKey('create_conversation_proposal_draft', args, ctx))
      .not.toBe(supportToolIdempotencyKey('create_conversation_proposal_draft', args, context({ userId: 10 })));
    expect(supportToolIdempotencyKey('create_conversation_proposal_draft', args, ctx))
      .not.toBe(supportToolIdempotencyKey('create_conversation_proposal_draft', args, context({ rawMessageId: 'different-message' })));
  });

  it('rejects empty requests, invalid references and conflicting references', () => {
    expect(validateSupportToolArgs('create_conversation_proposal_draft', { title: ' ' }).success).toBe(false);
    for (const args of [{ proposal_id: -1, requested_changes: 'Change scope' }, { proposal_id: 41, requested_changes: ' ' },
      { requested_changes: 'Change scope' }, { proposal_id: 41, proposal_number: 'PROP-1', requested_changes: 'Change scope' }]) {
      expect(validateSupportToolArgs('request_proposal_revision', args).success).toBe(false);
    }
  });
});

describe('conversation revision requests', () => {
  beforeEach(() => {
    records = [source()];
    items = [{ name: 'Design subscription', catalogId: 17, quantity: '2.00', unitPrice: '500.00', unit: 'page', discount: '10.00',
      isComplimentary: false, priceConfirmed: true, isOptional: true, selected: true, packageId: 'standard', billingPeriod: 'monthly' }];
  });

  it('records feedback and pauses only parent customer followups before preparing a fresh reviewed draft', async () => {
    const output = await safeCall('request_proposal_revision', { proposal_number: 'PROP-2030-9-001-ABCD', requested_changes: 'Please deliver in November' });
    const draft = createProposal.mock.calls[0][1];
    expect(draft).toMatchObject({ title: 'Website design', approvalRequired: true, signatureRequired: true,
      showTermsAndConditions: true, termsAndConditions: 'Customer terms', currency: 'USD', discountValue: 10, taxRate: 18,
      outreachConversationId: 7, leadId: 31, lineItems: items,
      generatedSections: [{ title: 'Scope', kind: 'content', body: 'Landing page' }],
      commercial: { selectedPackageId: 'standard' },
      requirements: { deliverables: 'Two landing pages', timeline: 'October' },
      assumptions: ['Internal scope assumption'],
      onboardingPlan: { teamId: 4, assignedMemberId: 8, dueDate: '2030-11-15' },
      templateValues: { project_goal: 'Increase qualified demos' },
      metadata: { revisionOf: 41, supportRequest: { requestedChanges: 'Please deliver in November', feedbackId: 71 },
        commercial: { selectedPackageId: 'standard' }, generatedSections: [{ title: 'Scope', kind: 'content', body: 'Landing page' }],
        requirements: { deliverables: 'Two landing pages', timeline: 'October' },
        templateSnapshot: { name: 'Website template', version: 2 },
        templateValues: { project_goal: 'Increase qualified demos' }, requiredTemplateFields: ['client_name', 'project_goal'] } });
    expect(draft.metadata).not.toHaveProperty('approvalFingerprint'); expect(draft.metadata).not.toHaveProperty('approvedAt');
    expect(draft.metadata).not.toHaveProperty('approvalRequests'); expect(draft.metadata).not.toHaveProperty('deliveryTarget');
    expect(draft.metadata).not.toHaveProperty('deliveryAttempt'); expect(draft).not.toHaveProperty('recipientEmail');
    expect(statements[0]).toMatchObject({ params: [41, 9, 7, 31, 1, 'sent'] });
    expect(statements[1].sql).toContain('ON CONFLICT (business_profile_id, user_id, source_key)');
    expect(statements[2]).toMatchObject({ params: [expect.stringContaining('"pauseReason":"change_request"'), 9, 41] });
    expect(statements[2].sql).toContain("SET status='paused'");
    expect(statements[2].sql).toContain("reminder_type='customer_followup'");
    expect(statements[2].sql).toContain("status IN ('pending','snoozed')");
    expect(output.toolResults?.[0].result).toMatchObject({ success: true, request_id: 71, proposal_id: 99, original_proposal_id: 41, delivered: false });
    expect(JSON.stringify(output)).not.toMatch(/Internal scope assumption|internal-token|finance comments/);
    expect(statements.some(item => /UPDATE proposals/.test(item.sql))).toBe(false);
  });

  it('returns the same unavailable result for foreign/missing proposals and refuses changed or signed snapshots', async () => {
    records = [];
    expect((await proposalSubAgent.execute('request_proposal_revision', { proposal_id: 51, requested_changes: 'Change scope' }, context())).toolResults?.[0].result.code).toBe('conversation_proposal_unavailable');
    expect(predicates.at(-1)?.params).toEqual([9, 7, 31, 51]);
    records = [source({ status: 'accepted', signedAt: new Date() })];
    expect((await proposalSubAgent.execute('request_proposal_revision', { proposal_id: 41, requested_changes: 'Change scope' }, context())).toolResults?.[0].result.code).toBe('proposal_requires_seller_review');
    records = [source()]; originalStillCurrent = false;
    expect((await proposalSubAgent.execute('request_proposal_revision', { proposal_id: 41, requested_changes: 'Change scope' }, context())).toolResults?.[0].result.code).toBe('conversation_proposal_unavailable');
    expect(createProposal).not.toHaveBeenCalled();
    expect(statements.some(item => item.sql.includes('INSERT INTO proposal_feedback'))).toBe(false);
  });

  it('keeps the durable request visible if copying the document fails, without claiming draft creation', async () => {
    createProposal.mockRejectedValue(new Error('Retired catalog entry; internal details'));
    const output = await safeCall('request_proposal_revision', { proposal_id: 41, requested_changes: 'Change scope' });
    expect(output.escalated).not.toBe(true);
    expect(output).toMatchObject({ toolResults: [{ result: {
      success: true, confirmedSideEffect: true, request_id: 71, original_proposal_id: 41,
      status: 'request_recorded', draft_status: 'not_created', delivered: false,
    } }] });
    expect(output.toolResults?.[0].result).not.toHaveProperty('proposal_id');
    expect(JSON.stringify(output)).not.toContain('Retired catalog');
  });

  it('whitelists only authoring material when copying metadata', () => {
    expect(Object.keys(revisionDocumentMetadata(source().metadata as ProposalDocumentMetadata)).sort()).toEqual([
      'assumptions', 'commercial', 'generatedSections', 'onboardingPlan', 'requiredTemplateFields',
      'requirements', 'templateSnapshot', 'templateValues',
    ]);
  });
});
