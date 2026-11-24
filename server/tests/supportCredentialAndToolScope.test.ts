import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
const dialect = new PgDialect();
const predicates: Array<{ sql: string; params: unknown[] }> = [];
const select = jest.fn<any>(() => ({ from: () => ({ where: (where: any) => ({ limit: async () => {
  predicates.push(dialect.sqlToQuery(where)); return [];
} }) }) }));
const insert = jest.fn<any>(() => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: 1, attemptCount: 1 }] }) }) }));
const update = jest.fn<any>(() => ({ set: () => ({ where: async () => [] }) }));
const mockDb = { select, insert, update, execute: jest.fn<any>() };
const approvals = { findByThread: jest.fn<any>(), create: jest.fn<any>() };
const registry = { getToolsForSubAgents: jest.fn<any>(), dispatch: jest.fn<any>(async () => ({ toolResults: [{ name: 'check_room_availability', result: { success: true } }] })) };
const postPolicy = jest.fn<any>(() => ({ passed: true, enforcements: [] }));
jest.unstable_mockModule('../models/db.js', () => ({ db: mockDb, pgPool: undefined }));
jest.unstable_mockModule('../models/toolApprovals/functions.js', () => ({ ToolApprovalModel: approvals }));
jest.unstable_mockModule('../services/agents/subagents/index.js', () => ({ subAgentRegistry: registry }));
jest.unstable_mockModule('../services/agents/pipeline/PolicyEngine.js', () => ({ policyEngine: { evaluatePostGeneration: postPolicy } }));
jest.unstable_mockModule('../services/agents/orchestration/ContentModerationService.js', () => ({ contentModerationService: { moderate: jest.fn<any>() } }));
const { redactPiiWithStableTokens, redactCredentialEchoes, sanitizeStructuredForModel, privacyVaultService } = await import('../services/agents/orchestration/PrivacyVaultService.js');
const { guardrailService } = await import('../services/agents/pipeline/GuardrailService.js');
const { PrivacyStage } = await import('../services/agents/pipeline/stages/PrivacyStage.js');
const { safeToolExecutor, sanitizeSupportToolData, supportToolScopeError } = await import('../services/agents/orchestration/SafeToolExecutor.js');
const { BaseOutreachAgent } = await import('../services/agents/BaseOutreachAgent.js');
class TestAgent extends BaseOutreachAgent {
  readonly agentName = 'scope-fixture';
  async handle(): Promise<any> { return {}; }
  tools(input: any) { return this.toolsForInput(input); }
  dispatch(name: string, args: any, ctx: any, offered?: string[]) { return this.dispatchToSubAgent(name, args, ctx, offered); }
}
const previousKey = process.env.SUPPORT_PII_ENCRYPTION_KEY;
process.env.SUPPORT_PII_ENCRYPTION_KEY = 'security-fixture-key-at-least-32-characters';
afterAll(() => {
  if (previousKey === undefined) delete process.env.SUPPORT_PII_ENCRYPTION_KEY;
  else process.env.SUPPORT_PII_ENCRYPTION_KEY = previousKey;
});
beforeEach(() => {
  jest.clearAllMocks();
  predicates.length = 0;
  postPolicy.mockReturnValue({ passed: true, enforcements: [] });
  registry.getToolsForSubAgents.mockReturnValue(['check_room_availability', 'save_booking_details', 'answer_from_knowledge_base', 'get_hotel_info']
    .map(name => ({ type: 'function', function: { name } })));
});
const inbound = 'My password is synthetic-hunter2 and my OTP is 123456';
const pipeline = (overrides: any = {}) => ({
  message: { userId: 991, conversationId: 11, messageId: 12, channel: 'whatsapp', inboundText: 'hello', metadata: {} },
  metadata: {}, ...overrides,
}) as any;
const availabilityArgs = { check_in: '2026-10-01', check_out: '2026-10-03', guests: 2 };
const context = (overrides: any = {}) => ({
  userId: 991, conversationId: 11, channel: 'whatsapp', messageId: 12, inboundText: 'Two guests please',
  nlu: {}, slots: {}, memory: {}, intel: {}, lead: {}, history: [], dryRun: true,
  agentConfig: { agentType: 'hotel_sales', toolsEnabled: ['check_room_availability', 'save_booking_details', 'answer_from_knowledge_base', 'get_hotel_info'] },
  playbookDirective: { playbookId: 1, version: 1, runId: 1, nodeId: 'availability', nodeType: 'capability',
    requiredAction: 'check_room_availability', capability: { name: 'availability.check', kind: 'tool', args: availabilityArgs } },
  ...overrides,
}) as any;

describe('credential privacy through inbound, structured context and outbound gates', () => {
  it('redacts the exact disclosed password and OTP repro with typed stable tokens', () => {
    const result = redactPiiWithStableTokens(inbound);
    expect(result).toEqual({ redactedText: 'My password is [CREDENTIAL_1] and my OTP is [OTP_1]', piiTypes: ['credential', 'otp'], tokenCount: 2 });
  });
  it.each([
    ['Password: "space separated S3cret!"', 'space separated S3cret!'],
    ["My passphrase is correct horse battery staple and rooms are available", 'correct horse battery staple'],
    ['API key = sk_test_synthetic_123456', 'sk_test_synthetic_123456'],
    ['Client secret: client-fixture-777', 'client-fixture-777'],
    ['Your PIN is 4321', '4321'],
    ['Verification code: 123 456', '123 456'],
    ['MFA code is A1B2C3', 'A1B2C3'],
    ['Authorization: Bearer synthetic.token.123', 'synthetic.token.123'],
    ['My password is fixture.secret!', 'fixture.secret!'],
    ['My password is Blue Lagoon 42 and I need 2 rooms.', 'Blue Lagoon 42'],
    ['OTP 123456 and room code DLX2', '123456'],
    ['123456 is your verification code.', '123456'],
    ['My password is now updated-secret-fixture', 'updated-secret-fixture'],
    ['{"password":"json-secret-fixture", "otp":123456}', 'json-secret-fixture'],
  ])('redacts context-bound secret in %s', (text, secret) => {
    expect(redactPiiWithStableTokens(text).redactedText).not.toContain(secret);
    expect(redactCredentialEchoes(`I received ${secret}`, text)).not.toContain(secret);
  });
  it.each([
    'Booking reference ABC123, 2 rooms, 4 guests, check-in 2026-10-01 and check-out 2026-10-03.',
    'The OTP is 6 digits and expires in 5 minutes.',
    'My password is not working. Please help reset it.',
    'Discount code: SAVE20. Room code DELUXE2.',
    'I need a password reset and a verification code.',
    'Password length is 16 characters. OTP expires in 5 minutes.',
  ])('preserves useful non-secret numbers and contextual status text: %s', text => {
    expect(redactPiiWithStableTokens(text).redactedText).toBe(text);
  });
  it('redacts numeric and nested structured secrets while retaining normal codes/counts', () => {
    const data = { otp: 123456, credentials: { secret: 'fixture' }, apiKey: 'fixture', verificationCode: 'A1B2C3', rooms: 2, roomCode: 'DLX2', note: inbound };
    for (const sanitized of [sanitizeStructuredForModel(data).value, sanitizeSupportToolData(data)] as any[]) {
      expect(sanitized.otp).toBe('[REDACTED_SECRET]');
      expect(sanitized.credentials).toBe('[REDACTED_SECRET]');
      expect(sanitized.verificationCode).toBe('[REDACTED_SECRET]');
      expect(sanitized.rooms).toBe(2);
      expect(sanitized.roomCode).toBe('DLX2');
      expect(JSON.stringify(sanitized)).not.toContain('synthetic-hunter2');
    }
  });
  it('blocks unlabeled OTP echoes even when the model changes digit spacing', () => {
    expect(redactCredentialEchoes('You sent 123-456.', 'My OTP is 123 456')).not.toContain('123-456');
    expect(redactCredentialEchoes('You sent 123 456.', 'My OTP is 123456')).not.toContain('123 456');
  });
  it('PrivacyStage removes credentials before any model stage, including dry-run previews', async () => {
    const ctx = pipeline({ message: { userId: 991, conversationId: 11, channel: 'whatsapp', inboundText: inbound, metadata: { dryRun: true } } });
    const result = await new PrivacyStage().execute(ctx);
    expect(result.message.inboundText).not.toContain('synthetic-hunter2');
    expect(result.message.inboundText).not.toContain('123456');
    expect(result.metadata?.privacy?.piiTypes).toEqual(['credential', 'otp']);
    expect(insert).not.toHaveBeenCalled();
  });
  it('masks unlabeled echoed secrets from the current tenant-bound vault entry, even if allowlisted', async () => {
    const reveal = jest.spyOn(privacyVaultService, 'reveal').mockResolvedValue({ rawText: inbound, piiTypes: ['credential', 'otp'], expiresAt: new Date('2099-01-01') });
    try {
      const ctx = pipeline({ metadata: { privacy: { piiTypes: ['credential', 'otp'], vaultId: 81 }, businessPiiAllowlist: ['synthetic-hunter2', '123456'] } });
      const result = await guardrailService.checkOutbound('Received synthetic-hunter2 and 123456.', ctx);
      expect(reveal).toHaveBeenCalledWith(991, 81, { conversationId: 11, messageId: 12, actor: 'system:outbound-guardrail', purpose: 'credential_echo_prevention' });
      expect(result.finalText).not.toContain('synthetic-hunter2');
      expect(result.finalText).not.toContain('123456');
      expect(result.action).toBe('sanitize');
    } finally { reveal.mockRestore(); }
  });
  it.each(['missing_id', 'expired_or_foreign', 'read_error', 'unrelated_evidence'])('fails closed for %s secret echo evidence without exposing the draft', async condition => {
    const reveal = jest.spyOn(privacyVaultService, 'reveal');
    if (condition === 'read_error') reveal.mockRejectedValue(new Error('fixture read failed'));
    else reveal.mockResolvedValue(condition === 'unrelated_evidence' ? { rawText: 'unrelated context', piiTypes: [], expiresAt: new Date('2099-01-01') } : null);
    try {
      const ctx = pipeline({ metadata: { privacy: { piiTypes: ['credential'], ...(condition === 'missing_id' ? {} : { vaultId: 81 }) } } });
      const result = await guardrailService.checkOutbound('synthetic-hunter2', ctx);
      expect(result).toMatchObject({ safe: false, action: 'human_handoff' });
      expect(result.finalText).not.toContain('synthetic-hunter2');
    } finally { reveal.mockRestore(); }
  });
  it('vault reads bind user, conversation and inbound message, not just an arbitrary vault ID', async () => {
    expect(await privacyVaultService.reveal(991, 81, { conversationId: 11, messageId: 12, actor: 'system:test', purpose: 'scope_test' })).toBeNull();
    expect(predicates[0].params).toEqual([81, 991, 11, 12]);
    expect(predicates[0].sql).toContain('"user_id" =');
    expect(predicates[0].sql).toContain('"conversation_id" =');
    expect(predicates[0].sql).toContain('"message_id" =');
  });
  it('redacts new draft credentials and policy suffixes without removing allowed public business contact details', async () => {
    postPolicy.mockReturnValue({ passed: false, enforcements: [{ action: 'append_disclaimer', detail: 'The password is policy-secret-fixture.' }] });
    const result = await guardrailService.checkOutbound('Call hotel@example.test. My OTP is 987654.', pipeline({ metadata: { businessPiiAllowlist: ['hotel@example.test'] } }));
    expect(result.finalText).toContain('hotel@example.test');
    expect(result.finalText).not.toContain('987654');
    expect(result.finalText).not.toContain('policy-secret-fixture');
  });
});

describe('support capability permission at actual tool execution', () => {
  const executor = jest.fn<any>(async () => ({ toolResults: [{ name: 'check_room_availability', result: { success: true } }] }));
  it.each([true, false])('blocks the exact save_booking_details mismatch before effects/approval/DB with dryRun=%s', async dryRun => {
    const result = await safeToolExecutor.execute('save_booking_details', { guest_name: 'Fixture Guest' }, context({ dryRun }), executor);
    expect(result.toolResults?.[0].result).toMatchObject({ success: false, code: 'tool_outside_current_capability', wouldExecute: false });
    expect(executor).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(approvals.findByThread).not.toHaveBeenCalled();
  });
  it('suppresses the required availability tool in an ordinary dry run', async () => {
    const result = await safeToolExecutor.execute('check_room_availability', availabilityArgs, context(), executor);
    expect(result.toolResults?.[0].result).toMatchObject({ code: 'dry_run_suppressed', wouldExecute: true });
    expect(executor).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
  it('runs only the public availability read in the authenticated owner simulator and drops proposed effects', async () => {
    executor.mockResolvedValueOnce({
      toolResults: [{ name: 'check_room_availability', result: { success: true } }],
      externalBookingHandoff: { stage: 'search', url: 'https://bookings.example.test/?rooms=1' },
      effectProposals: [{ type: 'external_booking_referral', payload: { url: 'https://bookings.example.test/' } }],
    });
    const result = await safeToolExecutor.execute('check_room_availability', availabilityArgs,
      context({ executionMode: 'advisory', isSupportChat: true }), executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.toolResults?.[0].result).toEqual({ success: true });
    expect(result.externalBookingHandoff).toMatchObject({ stage: 'search' });
    expect(result.effectProposals).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
  it('offers only public read tools to the authenticated owner simulator', () => {
    const agent = new TestAgent();
    expect(agent.tools(context({ executionMode: 'advisory', isSupportChat: true, playbookDirective: null }))
      .map((tool: any) => tool.function.name)).toEqual([
        'check_room_availability', 'answer_from_knowledge_base', 'get_hotel_info',
      ]);
    expect(agent.tools(context({ executionMode: 'advisory', isSupportChat: false, playbookDirective: null }))).toEqual([]);
  });
  it('blocks a forged high-risk booking call before creating any human approval request', async () => {
    const ctx = context({ dryRun: false });
    ctx.agentConfig.toolsEnabled.push('create_booking');
    const result = await safeToolExecutor.execute('create_booking', { room_type_id: 1, agreed_price_per_night: 100 }, ctx, executor);
    expect(result.toolResults?.[0].result).toMatchObject({ code: 'tool_outside_current_capability', wouldExecute: false });
    expect(approvals.findByThread).not.toHaveBeenCalled();
    expect(approvals.create).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });
  it('executes an authorized availability read through the real safe executor with a mocked adapter', async () => {
    const result = await safeToolExecutor.execute('check_room_availability', availabilityArgs, context({ dryRun: false }), executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.toolResults?.[0].result).toEqual({ success: true });
    expect(insert).toHaveBeenCalledTimes(1);
  });
  it.each([
    {}, [], 'unscoped',
    { nodeType: 'invented', requiredAction: 'check_room_availability' },
    { nodeType: 'action', requiredAction: 'invented_tool' },
    { nodeType: 'action', requiredAction: '' },
    { nodeType: 'collect', requiredAction: 'save_booking_details' },
    { nodeType: 'capability', requiredAction: 'check_room_availability' },
    { nodeType: 'capability', requiredAction: 'check_room_availability', capability: { name: 'invented.capability', kind: 'tool' } },
    { nodeType: 'capability', requiredAction: 'save_booking_details', capability: { name: 'availability.check', kind: 'tool' } },
    { nodeType: 'capability', requiredAction: 'check_room_availability', capability: { name: 'availability.check', kind: 'effect' } },
    { nodeType: 'capability', requiredAction: 'check_room_availability', capability: { name: 'availability.check', kind: 'tool', validationErrors: ['missing approval'] } },
  ])('rejects malformed claimed scope %# without touching any effect adapter', async playbookDirective => {
    const result = await safeToolExecutor.execute('check_room_availability', availabilityArgs, context({ playbookDirective }), executor);
    expect(result.toolResults?.[0].result).toMatchObject({ code: 'invalid_tool_scope', wouldExecute: false });
    expect(executor).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
  it('preserves ordinary unscoped agent allowlists and refuses disabled tools', async () => {
    const allowed = await safeToolExecutor.execute('save_booking_details', {}, context({ playbookDirective: null }), executor);
    expect(allowed.toolResults?.[0].result).toMatchObject({ code: 'dry_run_suppressed', wouldExecute: true });
    const denied = await safeToolExecutor.execute('get_payment_methods', {}, context({ playbookDirective: null }), executor);
    expect(denied.toolResults?.[0].result.code).toBe('tool_not_enabled');
  });
  it.each(['constructor', '__proto__', 'toString', 'save_booking_details;delete_all'])('rejects unregistered adversarial tool name %s before schema lookup or effects', async name => {
    const result = await safeToolExecutor.execute(name, {}, context({ playbookDirective: null, agentConfig: { toolsEnabled: [name] } }), executor);
    expect(result.toolResults?.[0].result).toMatchObject({ code: 'tool_not_enabled', wouldExecute: false });
    expect(executor).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
  it('allows only the knowledge read in a separate governed knowledge interruption', () => {
    expect(supportToolScopeError('answer_from_knowledge_base', { nodeType: 'knowledge' })).toBeNull();
    expect(supportToolScopeError('save_booking_details', { nodeType: 'knowledge' })).toBe('tool_outside_current_capability');
    expect(supportToolScopeError('get_hotel_info', context().playbookDirective, 'hotel_sales')).toBe('tool_outside_current_capability');
    expect(supportToolScopeError('check_room_availability', context().playbookDirective, 'technical_support')).toBe('invalid_tool_scope');
  });
  it('aligns offered tools with runtime permission and rejects forged calls on a tool-free turn', async () => {
    const agent = new TestAgent();
    const ctx = context();
    expect(agent.tools(ctx).map(tool => tool.function.name)).toEqual(['check_room_availability']);
    expect(agent.tools({ ...ctx, playbookDirective: { nodeType: 'media' } })).toEqual([]);
    expect((await agent.dispatch('check_room_availability', availabilityArgs, ctx, [])).toolResults?.[0].result).toMatchObject({ code: 'tool_not_offered_current_turn', wouldExecute: false });
    expect(registry.dispatch).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
});
