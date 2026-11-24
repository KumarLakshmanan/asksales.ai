import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { withBusinessScope } from '../tenancy/businessContext.js';

const connectionString = process.env.OUTREACH_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
let database: ReturnType<typeof drizzle>;
const emit = jest.fn();
const protect = jest.fn<any>().mockResolvedValue({});
const attachment = jest.fn<any>().mockResolvedValue({ id: 'asset' });
const send = jest.fn<any>().mockResolvedValue({ messages: [{ id: 'api-sent' }], success: true, externalMessageId: 'api-sent' });
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, { get: (_target,key) => {
  const value = (database as any)[key]; return typeof value === 'function' ? value.bind(database) : value;
} }) }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emit } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text }), privacyVaultService: { protectInbound: protect },
}));
jest.unstable_mockModule('../services/OutreachAttachmentService.js', () => ({ outreachAttachmentService: {
  persistInboundUrl: attachment, persistInboundBuffer: attachment, recordInboundFailure: attachment,
} }));
jest.unstable_mockModule('../services/socialFollowUpService.js', () => ({ activateSocialFollowUpForAnchor: jest.fn(), cancelSocialFollowUpsForConversation: jest.fn() }));
jest.unstable_mockModule('../services/emailFollowUpService.js', () => ({ cancelConversationEmailFollowUps: jest.fn() }));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: { sendText: send, downloadMedia: jest.fn<any>().mockRejectedValue(new Error('expired')) } }));
jest.unstable_mockModule('../services/instagramService.js', () => ({ sendInstagramDM: send }));
jest.unstable_mockModule('../services/FacebookMessengerService.js', () => ({ sendFacebookDM: send }));
const { outreachConversationsTable, outreachMessagesTable, outreachMessageAttachmentsTable } = await import('../models/outreachConversations/schema.js');
const { channelCredentialsTable } = await import('../models/channelCredentials/schema.js');
const { aiAgentConfigsTable } = await import('../models/aiAgentConfigs/schema.js');
const { leadsTable } = await import('../models/leads/schema.js');
const { supportDeliveryOutboxTable } = await import('../models/supportOrchestration/schema.js');
const { agentAuditLogsTable } = await import('../models/agentAuditLogs/schema.js');
const { deliveryOutboxService: outbox } = await import('../services/agents/orchestration/DeliveryOutboxService.js');
const { persistNativeSocialMessage: native, reconcileSocialReceipt, applyMetaMessageMutation } = await import('../services/SocialMessagePersistence.js');
const { updateOutreachMessageStatus, getMessagesByConversationId } = await import('../models/outreachConversations/functions.js');
const { ConversationContextStage } = await import('../services/agents/pipeline/stages/ConversationContextStage.js');
const { WhatsAppMessagePayloadSchema } = await import('../utils/metaWebhookValidator.js');
const scoped = <T>(work: () => T) => withBusinessScope({ userId: 9, businessProfileId: 91 }, work);

suite('social drafts and native messages in PostgreSQL', () => {
  let admin: Pool; let pool: Pool; let schema: string;
  beforeAll(async () => {
    if (!connectionString || !['localhost','127.0.0.1','[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Explicit local QA database required');
    schema = `social_drafts_qa_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, max: 5, options: `-c search_path=${schema},pg_catalog` });
    database = drizzle(pool);
    const dialect = new PgDialect();
    for (const table of [outreachConversationsTable,outreachMessagesTable,outreachMessageAttachmentsTable,channelCredentialsTable,
      aiAgentConfigsTable,leadsTable,supportDeliveryOutboxTable,agentAuditLogsTable]) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        let d = '';
        if (column.name === 'business_profile_id') d = ' DEFAULT 91';
        else if (column.default !== undefined) {
          const value = column.default;
          if (value && typeof value === 'object' && 'queryChunks' in value) d = ` DEFAULT ${dialect.sqlToQuery(value as any).sql}`;
          else if (typeof value === 'string') d = ` DEFAULT '${value.replaceAll("'", "''")}'`;
          else if (typeof value === 'boolean' || typeof value === 'number') d = ` DEFAULT ${value}`;
          else if (value && typeof value === 'object') d = ` DEFAULT '${JSON.stringify(value)}'::jsonb`;
        }
        return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${d}`;
      });
      await pool.query(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
    }
    await pool.query(`CREATE UNIQUE INDEX delivery_decision ON support_delivery_outbox(decision_key);
      CREATE UNIQUE INDEX delivery_message ON outreach_messages(delivery_action_id) WHERE delivery_action_id IS NOT NULL;
      ALTER TABLE outreach_messages ADD CONSTRAINT outreach_messages_waba_message_id_unique UNIQUE(waba_message_id);
      CREATE UNIQUE INDEX idempotency_message ON outreach_messages(business_profile_id,user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX social_session ON outreach_conversations(business_profile_id,user_id,lead_id,channel,provider_account_id) WHERE session_ended_at IS NULL;`);
    // Exercise the additive deployment migration against the same real schema.
    // @ts-expect-error JavaScript migration
    const { up } = await import('../migrations/307_social_reply_drafts.js');
    await up(pool); await up(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin?.end(); });
  beforeEach(async () => {
    jest.clearAllMocks();
    await pool.query(`TRUNCATE outreach_messages,outreach_message_attachments,outreach_conversations,leads,support_delivery_outbox,agent_audit_logs,ai_agent_configs,channel_credentials RESTART IDENTITY;
      INSERT INTO ai_agent_configs(user_id,agent_type,enabled,metadata) VALUES(9,'general_service',true,'{"platformAutoReplies":{"whatsapp":false,"instagram":false,"facebook":false}}');
      INSERT INTO channel_credentials(user_id,platform,account_identifier,is_active) VALUES(9,'whatsapp','phone',true),(9,'instagram_api','ig',true),(9,'facebook_api','page',true),(9,'instagram_api','ig-other',true);
      INSERT INTO leads(user_id,name,phone,platform_extended) VALUES(9,'Customer','919999999999','{"whatsapp_id":"919999999999","instagram_id":"customer","facebook_id":"customer"}');
      INSERT INTO outreach_conversations(user_id,lead_id,channel,provider_account_id,external_thread_id,unread_count,automation_mode)
        VALUES(9,1,'whatsapp','phone','919999999999',3,'human_owned'),(9,1,'instagram','ig','customer',3,'human_owned'),(9,1,'facebook','page','customer',3,'human_owned');`);
  });
  const platforms = [{ channel:'whatsapp',account:'phone',conversationId:1,recipient:'919999999999' },
    { channel:'instagram',account:'ig',conversationId:2,recipient:'customer' }, { channel:'facebook',account:'page',conversationId:3,recipient:'customer' }] as const;
  it.each(platforms)('persists terminal $channel drafts per turn and part, and never releases them', async ({channel,account,conversationId,recipient}) => scoped(async () => {
    const identity = { userId:9,channel,conversationId,inboundProviderMessageId:'turn:one' };
    const payload = { text:'Approved reply',recipient,phoneNumberId:channel==='whatsapp'?account:undefined,
      metadata:{ dispatchKind:'pipeline_message',providerAccountId:account,sourceMessageIds:[101,102] } };
    const claims = await Promise.all([outbox.claim(identity,payload),outbox.claim(identity,payload)]);
    expect(claims.map(c=>c.state)).toEqual(['drafted','drafted']);
    await outbox.claim({...identity,partIndex:1},payload);
    await outbox.claim({...identity,inboundProviderMessageId:'turn:two'},payload);
    const drafts=(await pool.query('SELECT * FROM outreach_messages ORDER BY id')).rows;
    expect(drafts).toHaveLength(3);
    for(const draft of drafts) expect(draft).toMatchObject({status:'draft',is_ai_generated:true,provider_call_state:'not_started',sent_at:null,delivered_at:null,read_at:null,provider_message_id:null,metadata:{sourceMessageIds:[101,102]}});
    expect(new Set(drafts.map(d=>d.delivery_action_id)).size).toBe(3);
    expect((await pool.query('SELECT unread_count,automation_mode FROM outreach_conversations WHERE id=$1',[conversationId])).rows[0]).toEqual({unread_count:3,automation_mode:'human_owned'});
    await pool.query("UPDATE ai_agent_configs SET metadata='{}'");
    expect((await outbox.claim(identity,payload)).state).toBe('drafted');
    await outbox.processReady(); expect(send).not.toHaveBeenCalled();
    await pool.query('DELETE FROM outreach_messages WHERE id=$1',[drafts[0].id]);
    await outbox.claim(identity,payload);
    expect((await pool.query('SELECT COUNT(*)::int n FROM outreach_messages')).rows[0].n).toBe(2);
  }));
  it.each(platforms)('holds $channel delivery disabled after claim, with no provider send', async ({channel,account,conversationId,recipient}) => scoped(async () => {
    await pool.query("UPDATE ai_agent_configs SET metadata='{}'");
    const claim=await outbox.claim({userId:9,conversationId,channel,inboundMessageId:17},{text:'Ready',recipient,metadata:{dispatchKind:'pipeline_message',providerAccountId:account}});
    expect(claim.state).toBe('claimed');
    await pool.query('UPDATE ai_agent_configs SET metadata=$1',[JSON.stringify({platformAutoReplies:{[channel]:false}})]);
    expect(await outbox.holdIfDisabled(claim.action)).toBe(true);
    expect((await pool.query('SELECT status FROM outreach_messages')).rows[0].status).toBe('draft');
    expect(send).not.toHaveBeenCalled();
  }));
  it.each(platforms)('deduplicates $channel native text, preserves ownership/unread, and uses provider time', async ({channel,account,conversationId,recipient}) => scoped(async () => {
    const input={userId:9,channel,accountId:account,recipientId:recipient,providerMessageId:'native-id',timestamp:new Date('2026-09-01T10:00:00Z'),text:'Sent from the app'};
    const ids=await Promise.all([native(input),native(input),native(input)]);
    expect(new Set(ids).size).toBe(1);
    const msg=(await pool.query('SELECT * FROM outreach_messages')).rows[0];
    expect(msg).toMatchObject({direction:'outbound',status:'sent',is_read:true,is_ai_generated:false,provider_call_state:'confirmed',metadata:{origin:'native_app'}});
    expect(new Date(msg.sent_at).getTime()).toBe(input.timestamp.getTime());
    expect((await pool.query('SELECT total_messages,unread_count,automation_mode FROM outreach_conversations WHERE id=$1',[conversationId])).rows[0]).toEqual({total_messages:1,unread_count:3,automation_mode:'human_owned'});
    expect(send).not.toHaveBeenCalled();
  }));
  it.each(['echo_first','confirmation_first'])('reconciles a pending API send with %s without losing receipts', async order => scoped(async () => {
    const input={userId:9,channel:'instagram' as const,accountId:'ig',recipientId:'customer',providerMessageId:'api-id',timestamp:new Date('2026-09-01T10:00:00Z'),text:'App reply'};
    const pending=(await pool.query("INSERT INTO outreach_messages(user_id,conversation_id,direction,content,status) VALUES(9,2,'outbound','App reply','pending') RETURNING id")).rows[0].id;
    await pool.query('UPDATE outreach_conversations SET total_messages=1 WHERE id=2');
    if(order==='echo_first') { const id=await native(input); await pool.query("UPDATE outreach_messages SET status='read',read_at=NOW() WHERE id=$1",[id]); }
    await updateOutreachMessageStatus(pending,'sent',{externalMessageId:'api-id',providerMessageId:'api-id',providerCallState:'confirmed'});
    if(order==='confirmation_first') await native(input);
    const messages=(await pool.query('SELECT * FROM outreach_messages')).rows;
    expect(messages).toHaveLength(1); expect(messages[0].id).toBe(pending);
    expect(messages[0].status).toBe(order==='echo_first'?'read':'sent');
    expect(new Date(messages[0].sent_at).getTime()).toBe(input.timestamp.getTime());
    expect((await pool.query('SELECT total_messages FROM outreach_conversations WHERE id=2')).rows[0].total_messages).toBe(1);
  }));
  it('adopts an early echo into an automatic delivery action', async () => scoped(async () => {
    await pool.query("UPDATE ai_agent_configs SET metadata='{}'");
    const claim=await outbox.claim({userId:9,channel:'instagram',conversationId:2,inboundMessageId:12},{text:'Reply',recipient:'customer',metadata:{dispatchKind:'pipeline_message',providerAccountId:'ig'}});
    const id=await native({userId:9,channel:'instagram',accountId:'ig',recipientId:'customer',providerMessageId:'early',timestamp:new Date('2026-09-01T10:00:00Z'),text:'Reply'});
    await outbox.completeClaimedAction(claim.action,'early');
    expect((await pool.query('SELECT id,delivery_action_id,is_ai_generated FROM outreach_messages')).rows).toEqual([{id,delivery_action_id:String(claim.action.id),is_ai_generated:true}]);
    expect((await pool.query('SELECT total_messages FROM outreach_conversations WHERE id=2')).rows[0].total_messages).toBe(1);
  }));
  it('isolates account identities and rejects an unbound account', async () => scoped(async () => {
    const input={userId:9,channel:'instagram' as const,accountId:'ig',recipientId:'customer',providerMessageId:'same-id',timestamp:new Date(),text:'Hello'};
    expect(await native(input)).not.toBe(await native({...input,accountId:'ig-other'}));
    await expect(native({...input,accountId:'foreign'})).rejects.toThrow('not connected');
    await pool.query("INSERT INTO channel_credentials(user_id,platform,account_identifier,is_active) VALUES(9,'whatsapp','phone-other',true)");
    const whatsapp={...input,channel:'whatsapp' as const,recipientId:'919999999999',accountId:'phone'};
    expect(await native(whatsapp)).not.toBe(await native({...whatsapp,accountId:'phone-other'}));
  }));
  it('creates an unknown native contact and retains an unavailable media record', async () => scoped(async () => {
    await native({userId:9,channel:'whatsapp',accountId:'phone',recipientId:'918888888888',providerMessageId:'media',timestamp:new Date(),text:'',attachments:[{mediaId:'expired',type:'image'}]});
    expect((await pool.query("SELECT phone FROM leads WHERE phone='918888888888'")).rows).toHaveLength(1);
    expect(attachment).toHaveBeenCalledWith(expect.objectContaining({direction:'outbound',error:expect.any(Error)}));
  }));
  it('applies edits/deletion to the original and ignores replayed old media', async () => scoped(async () => {
    const input={userId:9,channel:'whatsapp' as const,accountId:'phone',recipientId:'919999999999',providerMessageId:'original',timestamp:new Date('2026-09-01T10:00:00Z'),text:'Original'};
    const id=await native(input);
    await native({...input,eventType:'edit',originalMessageId:'original',providerMessageId:'edit',timestamp:new Date('2026-09-01T11:00:00Z'),text:'Edited'});
    expect((await pool.query('SELECT content FROM outreach_messages WHERE id=$1',[id])).rows[0].content).toBe('Edited');
    await native({...input,eventType:'revoke',originalMessageId:'original',providerMessageId:'revoke',timestamp:new Date('2026-09-01T12:00:00Z')});
    await native({...input,attachments:[{url:'https://example.test/old.png'}]});
    await native({...input,eventType:'edit',originalMessageId:'original',providerMessageId:'late-edit',timestamp:new Date('2026-09-01T13:00:00Z'),text:'Replayed edit'});
    expect((await pool.query('SELECT content,metadata FROM outreach_messages')).rows).toEqual([{content:'[Message deleted]',metadata:expect.objectContaining({deleted:true})}]);
    expect(attachment).not.toHaveBeenCalled();
  }));
  it('paginates drafts by creation time and messages by provider time with an ID tie-breaker', async () => scoped(async () => {
    await pool.query(`INSERT INTO outreach_messages(user_id,conversation_id,direction,content,status,created_at,sent_at) VALUES
      (9,2,'outbound','draft one','draft','2026-09-02',NULL),(9,2,'outbound','old native','sent','2026-09-04','2026-09-01'),
      (9,2,'outbound','draft two','draft','2026-09-02',NULL)`);
    const newest=await getMessagesByConversationId(2,2);
    expect(newest.map(m=>m.content)).toEqual(['draft two','draft one']);
    expect((await getMessagesByConversationId(2,2,0,newest[1].id)).map(m=>m.content)).toEqual(['old native']);
  }));
  it('keeps receipt watermarks away from drafts and other accounts', async () => scoped(async () => {
    const input={userId:9,channel:'instagram' as const,accountId:'ig',recipientId:'customer',providerMessageId:'read-me',timestamp:new Date('2026-09-01T10:00:00Z'),text:'Sent'};
    const sent=await native(input);
    const other=await native({...input,accountId:'ig-other'});
    await outbox.claim({userId:9,conversationId:2,channel:'instagram',inboundMessageId:123},{text:'Unsent',recipient:'customer',metadata:{dispatchKind:'pipeline_message'}});
    await reconcileSocialReceipt({userId:9,channel:'instagram',accountId:'ig',recipientId:'customer',state:'read',watermark:Date.parse('2026-09-20')});
    const rows=(await pool.query('SELECT id,status,delivered_at,read_at FROM outreach_messages ORDER BY id')).rows;
    expect(rows.find(r=>r.id===sent).status).toBe('read');
    expect(rows.find(r=>r.id===other).status).toBe('sent');
    expect(rows.find(r=>r.status==='draft')).toMatchObject({delivered_at:null,read_at:null});
    await reconcileSocialReceipt({userId:9,channel:'instagram',accountId:'ig',messageIds:['read-me'],state:'delivered'});
    expect((await pool.query('SELECT status FROM outreach_messages WHERE id=$1',[sent])).rows[0].status).toBe('read');
  }));
  it.each(['instagram','facebook'])('keeps the public target on a disabled %s comment reply', async channel => scoped(async () => {
    await outbox.claim({userId:9,conversationId:channel==='instagram'?2:3,channel:`${channel}_comment`,inboundMessageId:123},
      {text:'Public reply',recipient:'comment-99',metadata:{dispatchKind:'public_comment',sourceMessageIds:[123]}});
    expect((await pool.query('SELECT status,metadata FROM outreach_messages')).rows[0]).toMatchObject({status:'draft',metadata:{replySurface:'comment',commentId:'comment-99',sourceMessageIds:[123]}});
    expect(send).not.toHaveBeenCalled();
  }));
  it('includes actual native sends but excludes drafts from subsequent AI context', async () => scoped(async () => {
    await native({userId:9,channel:'instagram',accountId:'ig',recipientId:'customer',providerMessageId:'actual',timestamp:new Date(),text:'Actual sent reply'});
    await outbox.claim({userId:9,conversationId:2,channel:'instagram',inboundMessageId:123},{text:'Unsent AI suggestion',recipient:'customer',metadata:{dispatchKind:'pipeline_message'}});
    const ctx:any={message:{userId:9,conversationId:2,channel:'instagram',senderIdentifier:'customer',inboundText:'Next question',messageId:999},metadata:{},confidence:1,policyViolations:[]};
    await new ConversationContextStage().execute(ctx);
    expect(ctx.metadata.historyStatus).toBe('available');
    expect(JSON.stringify(ctx.message.metadata.conversationHistory)).toContain('Actual sent reply');
    expect(JSON.stringify(ctx.message.metadata.conversationHistory)).not.toContain('Unsent AI suggestion');
  }));
  it('applies Instagram edits and deletes without generating a new message', async () => scoped(async () => {
    const id=await native({userId:9,channel:'instagram',accountId:'ig',recipientId:'customer',providerMessageId:'edited',timestamp:new Date('2026-09-01'),text:'Original'});
    await applyMetaMessageMutation(9,'instagram','ig',{timestamp:Date.parse('2026-09-02'),message_edit:{mid:'edited',text:'Corrected',num_edit:1}});
    expect((await pool.query('SELECT content FROM outreach_messages WHERE id=$1',[id])).rows[0].content).toBe('Corrected');
    await applyMetaMessageMutation(9,'instagram','ig',{timestamp:Date.parse('2026-09-03'),message:{mid:'edited',is_deleted:true}});
    expect((await pool.query('SELECT content FROM outreach_messages')).rows).toEqual([{content:'[Message deleted]'}]);
    expect(send).not.toHaveBeenCalled();
  }));
  it('validates WhatsApp echoes together with incoming messages, statuses, and unrelated changes', () => {
    const parsed=WhatsAppMessagePayloadSchema.parse({object:'whatsapp_business_account',entry:[{changes:[
      {field:'account_update',value:{}}, {field:'messages',value:{metadata:{phone_number_id:'phone'},
        messages:[{from:'customer',id:'in',timestamp:'1',type:'text',text:{body:'Hello'}}],statuses:[{id:'out',status:'read',timestamp:'2'}]}},
      {field:'smb_message_echoes',value:{metadata:{phone_number_id:'phone'},message_echoes:[{from:'business',to:'customer',id:'out',timestamp:1,type:'text',text:{body:'Hi'}}]}}
    ]}]});
    expect(parsed.entry[0].changes).toHaveLength(2);
    expect(parsed.entry[0].changes[1].value.message_echoes?.[0].timestamp).toBe('1');
  });
});
