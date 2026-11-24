import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client, Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import type { DeliveryProposal, ProposalDeliveryTarget, ProposalProviderReceipt } from '../services/ProposalDeliveryService.js';
import type { SupportDeliveryOutboxRecord } from '../models/supportOrchestration/schema.js';
import type { ProposalChannel } from '../../shared/proposals.js';

const connectionString = process.env.PROPOSAL_QA_DATABASE_URL;
const databaseTests = connectionString ? describe : describe.skip;
const schema = `proposal_delivery_qa_${Date.now()}_${process.pid}`;
let admin: Client;
let pool: Pool;
let database: NodePgDatabase;
const originalClientUrl = process.env.CLIENT_URL;
const provider = jest.fn<(userId: number, action: SupportDeliveryOutboxRecord) => Promise<ProposalProviderReceipt>>();
const reserve = jest.fn<(...args: unknown[]) => Promise<{ success: boolean; transactionId: number }>>();
const refund = jest.fn<(...args: unknown[]) => Promise<{ success: boolean }>>();
const binding = jest.fn<(userId: number, channel: string, options: { providerAccountId?: string; providerVariant?: 'gmail' | 'resend' }) => Promise<{ ready: boolean; binding?: { credentialId: number; providerAccountId: string; providerVariant?: 'gmail' | 'resend' } }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) { const value = database[key as keyof typeof database]; return typeof value === 'function' ? value.bind(database) : value; },
}) }));
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({ getEffectiveModuleAccess: async () => [{ key: 'proposals', enabled: true }, { key: 'outreach', enabled: true }] }));
jest.unstable_mockModule('../services/outreach/ProviderBindingService.js', () => ({ inspectOfficialProviderBinding: binding }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
const { ProposalDeliveryService } = await import('../services/ProposalDeliveryService.js');
const { DeliveryOutboxService } = await import('../services/agents/orchestration/DeliveryOutboxService.js');
const { proposalsTable } = await import('../models/proposals/schema.js');
const { supportDeliveryOutboxTable } = await import('../models/supportOrchestration/schema.js');
const { proposalApprovalFingerprint } = await import('../services/ProposalWorkspaceService.js');
const { encryptChannelCredentialSecret, getChannelCredentialEncryptionKeyId } = await import('../utils/channelCredentialSecrets.js');
// @ts-expect-error Production JavaScript migration is exercised in an isolated schema.
const { up: migrate } = await import('../migrations/252_proposal_delivery.js');

const lineItems = [{ id: 1, name: 'Consulting report', description: 'One agreed report', quantity: '1', unitPrice: '100.00', total: '100.00', unit: 'service', priceConfirmed: true }];
async function getProposal(userId: number, id: number) {
  const [proposal] = await database.select().from(proposalsTable).where(and(eq(proposalsTable.id, id), eq(proposalsTable.userId, userId))).limit(1);
  return proposal ? { ...proposal, lineItems } as DeliveryProposal : null;
}
function service() { return new ProposalDeliveryService({ getProposal, dispatch: provider, reserve, refund }); }
async function approve(channel: ProposalChannel = 'email', extra: Record<string, unknown> = {}) {
  const review = await service().prepare(9, 1, { channel, providerAccountId: channel === 'email' ? 'seller@example.test' : 'qa-account', ...extra });
  const current = await getProposal(9, 1);
  const metadata = { ...current!.metadata, deliveryTarget: review.target, approvalRequired: true, approvedAt: new Date().toISOString() };
  const candidate = { ...current!, recipientName: review.target.recipientName, recipientEmail: review.target.recipientEmail, metadata };
  const approvalFingerprint = proposalApprovalFingerprint(candidate);
  await database.update(proposalsTable).set({ recipientName: review.target.recipientName, recipientEmail: review.target.recipientEmail, metadata: { ...metadata, approvalFingerprint } }).where(eq(proposalsTable.id, 1));
  return review;
}

databaseTests('proposal delivery with real PostgreSQL claims and mocked providers', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Proposal QA requires local PostgreSQL.');
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema},pg_catalog`);
    for (const table of ['proposals', 'leads', 'crm_contacts', 'outreach_conversations', 'outreach_messages', 'support_delivery_outbox', 'sent_messages', 'outreach_settings', 'wallet_transactions', 'whatsapp_templates', 'channel_credentials', 'support_teams', 'team_members', 'support_chat_sessions', 'support_chat_messages', 'handoff_queue']) {
      await admin.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      await admin.query(`CREATE SEQUENCE ${table}_qa_seq; ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${table}_qa_seq')`);
    }
    await admin.query('ALTER TABLE proposals ADD COLUMN IF NOT EXISTS draft_key VARCHAR(100)');
    await admin.query('ALTER TABLE proposals ADD COLUMN IF NOT EXISTS superseded_by INTEGER');
    await admin.query('ALTER TABLE outreach_conversations ADD COLUMN IF NOT EXISTS provider_account_id VARCHAR(255)');
    await admin.query('CREATE TABLE proposal_review_policies (LIKE public.proposal_review_policies INCLUDING ALL)');
    await migrate(admin);
    await migrate(admin);
    pool = new Pool({ connectionString, max: 6, options: `-c search_path=${schema},pg_catalog -c app.business_profile_id=9 -c app.current_user_id=9` });
    database = drizzle(pool);
    process.env.CLIENT_URL = 'https://proposal.example.test';
  }, 60000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (originalClientUrl === undefined) delete process.env.CLIENT_URL;
    else process.env.CLIENT_URL = originalClientUrl;
  }, 60000);

  beforeEach(async () => {
    await pool.query('TRUNCATE proposals,leads,crm_contacts,outreach_conversations,outreach_messages,support_delivery_outbox,sent_messages,outreach_settings,wallet_transactions,whatsapp_templates,channel_credentials,proposal_review_policies,support_teams,team_members,support_chat_sessions,support_chat_messages,handoff_queue');
    provider.mockReset().mockResolvedValue({ success: true, messageId: 'qa-provider-receipt', rfcMessageId: '<qa-mail@example.test>', threadId: 'qa-gmail-thread' });
    reserve.mockReset().mockResolvedValue({ success: true, transactionId: 71 });
    refund.mockReset().mockResolvedValue({ success: true });
    binding.mockReset().mockImplementation(async (_userId, channel, opts) => ({ ready: true, binding: { credentialId: 10, providerAccountId: opts.providerAccountId || (channel === 'email' ? 'seller@example.test' : 'qa-account'), providerVariant: opts.providerVariant } }));
    await pool.query(`INSERT INTO leads(id,uuid,user_id,source,status,name,email,phone) VALUES (17,gen_random_uuid(),9,'qa','new','QA Customer','customer@example.test','+14155552671'),(18,gen_random_uuid(),9,'qa','new','Other Customer','other@example.test','+14155552672'),(19,gen_random_uuid(),10,'qa','new','Other Tenant','private@example.test','+14155552673')`);
    await pool.query(`INSERT INTO crm_contacts(id,user_id,lead_id,first_name,email,pipeline_status) VALUES (21,9,17,'QA Customer','customer@example.test','negotiation'),(22,9,18,'Other Customer','other@example.test','new')`);
    // Seed a synthetically encrypted, verified connection as a successful local
    // settings save would. The real readiness guard remains enabled.
    await pool.query(`INSERT INTO channel_credentials(user_id,platform,credential_type,api_secret,account_identifier,account_name,is_active,is_selected,session_data,encryption_version,encryption_key_id,encrypted_at,provider_verified_at) VALUES (9,'msg91_sms','api_key',$1,'QASEND','QA SMS',TRUE,TRUE,'{"senderId":"QASEND","flowId":"QA-FLOW","messageVariable":"message"}'::jsonb,'v1',$2,NOW(),NOW())`, [encryptChannelCredentialSecret('synthetic-qa-secret'), getChannelCredentialEncryptionKeyId()]);
    await pool.query(`INSERT INTO outreach_conversations(id,user_id,lead_id,crm_contact_id,channel,integration_provider,provider_account_id,lead_name,lead_email,subject,external_thread_id) VALUES (31,9,17,21,'email','gmail','seller@example.test','QA Customer','customer@example.test','Agreed consulting scope','qa-gmail-thread'),(32,9,18,22,'email','gmail','seller@example.test','Other Customer','other@example.test','Another thread','other-thread'),(33,10,19,NULL,'email','gmail','private@example.test','Private Customer','private@example.test','Private thread','private-thread')`);
    await pool.query(`INSERT INTO proposals(id,user_id,contact_id,lead_id,outreach_conversation_id,proposal_number,title,cover_note,recipient_name,recipient_email,currency,subtotal,total,show_terms_and_conditions,terms_and_conditions,metadata,revision) VALUES (1,9,21,17,31,'PROP-QA-1','Consulting report','Deliver one agreed consulting report.','QA Customer','customer@example.test','USD',100,100,TRUE,'Payment due on completion.','{}'::jsonb,4)`);
    await pool.query('UPDATE leads SET business_profile_id=10 WHERE user_id=10; UPDATE outreach_conversations SET business_profile_id=10 WHERE user_id=10');
  });

  async function widgetFixture() {
    await pool.query("INSERT INTO support_teams(id,user_id,name,is_active) VALUES(41,9,'QA webchat',true)");
    await pool.query("INSERT INTO team_members(id,team_id,user_id,name,email,is_active) VALUES(101,41,9,'QA member','qa@example.test',true)");
    await pool.query(`INSERT INTO support_chat_sessions(id,member_id,title,session_expires_at,automation_mode,metadata) VALUES(51,101,'QA customer',NOW()+INTERVAL '1 day','ai_active','{"widgetProposalIdentity":{"conversationId":31,"leadId":17}}'::jsonb)`);
    await pool.query(`UPDATE outreach_conversations SET channel='web',provider_account_id=NULL,external_thread_id='support-widget:51',metadata='{"supportWidgetSessionId":51}'::jsonb WHERE id=31`);
  }

  it('delivers webchat into only its bound session with one durable message on replay', async () => {
    await widgetFixture();expect((await approve('web')).ready).toBe(true);
    const web=new ProposalDeliveryService({getProposal,reserve,refund});
    const input={channel:'web' as const,expectedRevision:4,idempotencyKey:'web-delivery-qa'};
    const first=await web.send(9,1,input);const replay=await web.send(9,1,input);
    expect(first.delivery.state).toBe('sent');expect(replay.publicUrl).toBe(first.publicUrl);
    const messages=(await pool.query('SELECT session_id,content FROM support_chat_messages')).rows;
    expect(messages).toHaveLength(1);expect(messages[0].session_id).toBe(51);expect(messages[0].content).toContain(first.publicUrl);
    expect(provider).not.toHaveBeenCalled();
  });

  it.each(['expired','opted out','wrong binding','foreign member','human takeover'])('blocks webchat delivery for %s',async reason=>{
    await widgetFixture();
    if(reason==='expired')await pool.query("UPDATE support_chat_sessions SET session_expires_at=NOW()-INTERVAL '1 day'");
    if(reason==='opted out')await pool.query('UPDATE support_chat_sessions SET opted_out_at=NOW()');
    if(reason==='wrong binding')await pool.query(`UPDATE support_chat_sessions SET metadata='{"widgetProposalIdentity":{"conversationId":32,"leadId":18}}'::jsonb`);
    if(reason==='foreign member')await pool.query('UPDATE team_members SET user_id=10 WHERE id=101');
    if(reason==='human takeover')await pool.query("UPDATE support_chat_sessions SET automation_mode='human_active'");
    const review=await service().prepare(9,1,{channel:'web'});expect(review.ready).toBe(false);
    expect(review.issues).toEqual(expect.arrayContaining([expect.objectContaining({code:'widget_session_unavailable'})]));
    expect((await pool.query('SELECT id FROM support_chat_messages')).rows).toHaveLength(0);
  });

  it('sends one reviewed proposal, records the receipt once, and updates its CRM conversation', async () => {
    expect((await approve()).ready).toBe(true);
    const input = { expectedRevision: 4, idempotencyKey: 'pg-send-1' };
    const result = await service().send(9, 1, input);
    const replay = await service().send(9, 1, input);
    expect(result.delivery.state).toBe('sent');
    expect(replay.publicUrl).toBe(result.publicUrl);
    expect(provider).toHaveBeenCalledTimes(1); expect(reserve).toHaveBeenCalledTimes(1);
    const transcript = await pool.query("SELECT content,message_kind,provider_account_id,rfc_message_id FROM outreach_messages WHERE delivery_action_id IS NOT NULL");
    expect(transcript.rows).toHaveLength(1);
    expect(transcript.rows[0]).toMatchObject({ message_kind: 'proposal', provider_account_id: 'seller@example.test', rfc_message_id: '<qa-mail@example.test>' });
    expect(transcript.rows[0].content).toContain(result.publicUrl);
    expect((await pool.query('SELECT pipeline_status FROM crm_contacts WHERE id=21')).rows[0].pipeline_status).toBe('proposal_sent');
    expect((await pool.query("SELECT metadata->'deliveryAttempt'->>'creditTransactionId' AS credit FROM proposals WHERE id=1")).rows[0].credit).toBe('71');
  });

  it('atomically suppresses concurrent submissions of the same reviewed request', async () => {
    await approve();
    const input = { expectedRevision: 4, idempotencyKey: 'pg-concurrent-1' };
    const results = await Promise.all([service().send(9, 1, input), service().send(9, 1, input), service().send(9, 1, input)]);
    expect(results.some(result => result.delivery.state === 'sent')).toBe(true);
    expect(new Set(results.map(result => result.publicUrl)).size).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1); expect(reserve).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM support_delivery_outbox')).rows[0].count).toBe(1);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM outreach_messages')).rows[0].count).toBe(1);
  });

  it.each([{ outreachConversationId: 32 }, { outreachConversationId: 33 }, { leadId: 18 }, { leadId: 19 }, { recipientEmail: 'other@example.test' }, { providerAccountId: 'another@example.test' }])('rejects mismatched customer/account identity %j without a provider call', async override => {
    await expect(service().prepare(9, 1, override)).rejects.toBeInstanceOf(Error);
    expect(provider).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });

  it('requires the exact live proposal revision when a row changes during claim', async () => {
    await approve();
    const contender = new ProposalDeliveryService({
      getProposal: async (userId, id) => {
        const value = await getProposal(userId, id);
        if (value?.metadata?.approvedAt) await pool.query("UPDATE proposals SET title='Changed during review',revision=revision+1 WHERE id=1 AND title='Consulting report'");
        return value;
      }, dispatch: provider, reserve, refund,
    });
    await expect(contender.send(9, 1, { expectedRevision: 4, idempotencyKey: 'pg-stale-revision' })).rejects.toMatchObject({ statusCode: 409 });
    expect(provider).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });

  it('gates opt-outs and a removed reviewed integration account', async () => {
    await approve();
    await pool.query('UPDATE leads SET do_not_contact=TRUE WHERE id=17');
    const review = await service().prepare(9, 1, {});
    expect(review.ready).toBe(false);
    expect(review.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'recipient_opted_out' })]));
    await pool.query('UPDATE leads SET do_not_contact=FALSE WHERE id=17');
    binding.mockResolvedValueOnce({ ready: false });
    await expect(service().send(9, 1, { expectedRevision: 4, idempotencyKey: 'pg-missing-account' })).rejects.toMatchObject({ code: 'PROPOSAL_DELIVERY_GATED' });
    expect(provider).not.toHaveBeenCalled();
  });

  it.each(['whatsapp', 'facebook', 'instagram'] as const)('uses only the reviewed %s account conversation for reply-window eligibility', async channel => {
    await pool.query(`UPDATE outreach_conversations SET channel=$1,integration_provider=NULL,provider_account_id='qa-account',external_thread_id='14155552671' WHERE id=31`, [channel]);
    await pool.query(`INSERT INTO outreach_messages(conversation_id,user_id,direction,content,status,created_at) VALUES (31,9,'inbound','Prior inquiry','received',NOW()-INTERVAL '2 days')`);
    expect((await service().prepare(9, 1, { channel, providerAccountId: 'qa-account' })).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'channel_window_closed' })]));
    await pool.query("UPDATE outreach_messages SET created_at=NOW() WHERE conversation_id=31");
    const review = await approve(channel);
    expect(review.ready).toBe(true);
    expect((await service().send(9, 1, { expectedRevision: 4, idempotencyKey: `pg-${channel}-send` })).delivery.state).toBe('sent');
    expect((provider.mock.calls[0][1].payload.metadata?.target as ProposalDeliveryTarget).providerAccountId).toBe('qa-account');
  });

  it.each([
    { channel: 'sms', providerAccountId: 'QASEND', recipient: '+14155552671' },
    { channel: 'linkedin', providerAccountId: 'qa-account', recipient: 'urn:li:person:qa-customer' },
    { channel: 'twitter', providerAccountId: 'qa-account', recipient: '1234567890' },
  ] as const)('resolves, freezes, and records the reviewed $channel recipient and account', async ({ channel, providerAccountId, recipient }) => {
    await pool.query(`UPDATE outreach_conversations SET channel=$1,integration_provider=NULL,provider_account_id=$2,external_thread_id=$3 WHERE id=31`, [channel, providerAccountId, recipient]);
    const review = await approve(channel, { providerAccountId });
    expect(review.ready).toBe(true);
    expect(review.target).toMatchObject({ channel, providerAccountId, recipient, outreachConversationId: 31 });
    const result = await service().send(9, 1, { expectedRevision: 4, idempotencyKey: `pg-${channel}-send` });
    expect(result.delivery.state).toBe('sent');
    expect(provider.mock.calls[0][1].payload.metadata?.target as ProposalDeliveryTarget).toMatchObject({ channel, providerAccountId, recipient });
    const transcript = await pool.query('SELECT message_kind,provider_account_id,external_message_id FROM outreach_messages WHERE delivery_action_id IS NOT NULL');
    expect(transcript.rows).toEqual([expect.objectContaining({ message_kind: 'proposal', provider_account_id: providerAccountId, external_message_id: 'qa-provider-receipt' })]);
  });

  it('gates SMS before delivery when its required MSG91 Flow contract is incomplete', async () => {
    await pool.query("UPDATE outreach_conversations SET channel='sms',integration_provider=NULL,provider_account_id='QASEND',external_thread_id='+14155552671' WHERE id=31");
    await pool.query(`UPDATE channel_credentials SET session_data='{"senderId":"QASEND"}'::jsonb WHERE user_id=9 AND platform='msg91_sms'`);
    const review = await service().prepare(9, 1, { channel: 'sms', providerAccountId: 'QASEND' });
    expect(review.ready).toBe(false);
    expect(review.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'provider_unavailable', field: 'providerAccountId' }),
    ]));
    await expect(service().send(9, 1, { channel: 'sms', providerAccountId: 'QASEND', expectedRevision: 4, idempotencyKey: 'pg-sms-missing-flow' })).rejects.toMatchObject({ code: 'PROPOSAL_DELIVERY_GATED' });
    expect(provider).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('keeps the live link and prevents both refunds and retries after an uncertain provider outcome', async () => {
    await approve();
    provider.mockResolvedValueOnce({ success: false, deliveryAttempted: true, error: 'Response lost after provider call' });
    const input = { expectedRevision: 4, idempotencyKey: 'pg-uncertain-1' };
    const result = await service().send(9, 1, input);
    expect(result.delivery.state).toBe('uncertain');
    const row = (await pool.query('SELECT status,public_token_hash FROM proposals WHERE id=1')).rows[0];
    expect(row.status).toBe('delivery_unknown'); expect(row.public_token_hash).toHaveLength(64);
    expect((await service().send(9, 1, input)).publicUrl).toBe(result.publicUrl);
    expect(refund).not.toHaveBeenCalled(); expect(provider).toHaveBeenCalledTimes(1);
    expect((await new DeliveryOutboxService().processReady()).processed).toBe(0);
  });

  it('restores the prior token after an authoritative rejection and does not retry a terminal failure', async () => {
    await pool.query("UPDATE proposals SET public_token_hash=repeat('a',64),public_token_expires_at=NOW()+INTERVAL '1 day' WHERE id=1");
    await approve();
    provider.mockResolvedValueOnce({ success: false, deliveryAttempted: true, outcomeUncertain: false, error: 'Provider rejected the recipient' });
    expect((await service().send(9, 1, { expectedRevision: 4, idempotencyKey: 'pg-rejected-1' })).delivery.state).toBe('failed');
    expect((await pool.query('SELECT public_token_hash FROM proposals WHERE id=1')).rows[0].public_token_hash).toBe('a'.repeat(64));
    expect(refund).toHaveBeenCalledTimes(1);
    expect((await new DeliveryOutboxService().processReady()).processed).toBe(0);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('atomically marks an expired sender lease and its proposal as uncertain', async () => {
    await approve();
    provider.mockResolvedValueOnce({ success: false, deliveryAttempted: true });
    const result = await service().send(9, 1, { expectedRevision: 4, idempotencyKey: 'pg-lease-1' });
    await pool.query("UPDATE support_delivery_outbox SET status='sending',lease_expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [result.delivery.actionId]);
    await pool.query("UPDATE proposals SET status='sending' WHERE id=1");
    expect(await new DeliveryOutboxService().reconcileExpiredLeases()).toBe(1);
    expect((await pool.query('SELECT status FROM proposals WHERE id=1')).rows[0].status).toBe('delivery_unknown');
    expect((await database.select().from(supportDeliveryOutboxTable))[0].status).toBe('uncertain');
  });

  it('does not make a general non-retryable outbox rejection automatically eligible', async () => {
    const outbox = new DeliveryOutboxService();
    const identity = { userId: 9, conversationId: 31, channel: 'email', idempotencyKey: 'non-retryable-rejection' };
    const claim = await outbox.claim(identity, { recipient: 'customer@example.test', text: 'QA only' });
    await outbox.markFailed(claim.action.id, 'Permanent policy gate', false, false);
    expect((await outbox.processReady()).processed).toBe(0);
    await expect(outbox.claim(identity, claim.action.payload)).rejects.toThrow('requires review');
  });
});
