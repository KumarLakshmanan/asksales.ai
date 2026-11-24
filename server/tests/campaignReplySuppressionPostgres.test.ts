import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { withBusinessScope } from '../tenancy/businessContext.js';
let client: Client, database: NodePgDatabase;
const send = jest.fn<any>(),
  complete = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({
  db: { execute: (query: SQL) => database.execute(query) },
}));
jest.unstable_mockModule(
  '../services/agents/orchestration/DeliveryOutboxService.js',
  () => ({
    deliveryOutboxService: {
      claim: async (identity: any, payload: any) => ({
        state: 'claimed',
        action: {
          id: 201,
          userId: 9,
          conversationId: identity.conversationId,
          payload,
        },
      }),
      completeClaimedAction: complete,
      markFailed: jest.fn(),
    },
  }),
);
jest.unstable_mockModule('../services/emailService.js', () => ({
  emailService: { sendEmailWithUserCredentials: send },
}));
jest.unstable_mockModule(
  '../services/outreach/ProviderBindingService.js',
  () => ({
    resolveOfficialProviderBinding: async () => ({
      credentialId: 8,
      providerAccountId: 'sender@example.test',
      platform: 'gmail_api',
    }),
  }),
);
const { sendCampaignEmailReply } =
  await import('../services/outreach/CampaignEmailReplyDelivery.js');
const scoped = <T,>(work: () => T) =>
  withBusinessScope({ userId: 9, businessProfileId: 7 }, work);
const context = {
  kind: 'campaign' as const,
  campaignId: 51,
  conversationId: 68,
  source: { table: 'sent_messages' as const, id: 41 },
  senderId: 3,
  accountId: 'sender@example.test',
  recipientEmail: 'recipient@example.test',
  autoSendVerified: true,
  draftHash: createHash('sha256').update('Synthetic reply').digest('hex'),
};
beforeAll(async () => {
  client = new Client({
    connectionString: process.env.OUTREACH_QA_DATABASE_URL,
  });
  await client.connect();
  await client.query('SET search_path TO pg_temp,pg_catalog');
  database = drizzle(client);
  await client.query(`CREATE TEMP TABLE sent_messages(id integer,user_id integer,business_profile_id integer,campaign_id integer,lead_id integer,subject text,message text,sender_id integer,channel text,status text,is_reply boolean,outreach_message_id integer,recipient_address text,lead_name text,bounced_at timestamp,delivery_status text);
 CREATE TEMP TABLE outreach_messages(id integer,user_id integer,business_profile_id integer,campaign_id integer,conversation_id integer,subject text,redacted_content text,content text,direction text,status text,rfc_message_id text,metadata jsonb);
 CREATE TEMP TABLE outreach_conversations(id integer,user_id integer,business_profile_id integer,lead_id integer,channel text,external_thread_id text,automation_mode text,status text,provider_account_id text);
 CREATE TEMP TABLE outreach_campaigns(id integer,user_id integer,business_profile_id integer,name text,description text,settings jsonb);
 CREATE TEMP TABLE leads(id integer,user_id integer,business_profile_id integer,deleted_at timestamp,email text,email_unsubscribed boolean,do_not_contact boolean,blacklisted boolean,phone text);
 CREATE TEMP TABLE email_senders(id integer,user_id integer,business_profile_id integer,email text,type text,credential_id integer,is_verified boolean);
 INSERT INTO sent_messages(id,user_id,business_profile_id,campaign_id,lead_id,subject,message,sender_id,channel,status,is_reply) VALUES(41,9,7,51,12,'Synthetic offer','Synthetic original campaign',3,'email','sent',false);
 INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,direction,rfc_message_id,metadata) VALUES(701,9,7,68,'inbound','<inbound@example.test>','{"inboundEmailReceipt":{"sentMessageId":"91"}}');
 INSERT INTO outreach_conversations VALUES(68,9,7,12,'email','thread','ai_active','replied','sender@example.test');
 INSERT INTO outreach_campaigns VALUES(51,9,7,'Synthetic campaign',NULL,'{"replyPolicy":{"autoSend":true}}');
 INSERT INTO leads VALUES(12,9,7,NULL,'recipient@example.test',true,true,true,NULL);
 INSERT INTO email_senders VALUES(3,9,7,'sender@example.test','gmail',8,true);`);
  send.mockResolvedValue({
    success: true,
    providerMessageId: 'synthetic-provider-receipt',
  });
  complete.mockResolvedValue(undefined);
});
afterAll(async () => {
  await client?.end();
});
describe('campaign reply suppression audit', () => {
  it('F08 automatic campaign reply refuses persisted lead suppression', async () => {
    const result = await scoped(() =>
      sendCampaignEmailReply({
        id: 91,
        user_id: 9,
        lead_id: 12,
        lead_email: 'recipient@example.test',
        smart_reply: 'Synthetic reply',
        reply_context: context,
        message_id: 'inbound-native',
        gmail_thread_id: 'thread',
      }),
    );
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('suppressed'),
    });
    expect(send).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
  it('F08 permits the same verified reply when all suppression flags are false', async () => {
    await client.query(
      'UPDATE leads SET email_unsubscribed=false,do_not_contact=false,blacklisted=false',
    );
    send.mockClear();
    complete.mockClear();
    const result = await scoped(() =>
      sendCampaignEmailReply({
        id: 91,
        user_id: 9,
        lead_id: 12,
        lead_email: 'recipient@example.test',
        smart_reply: 'Synthetic reply',
        reply_context: context,
        message_id: 'inbound-native',
        gmail_thread_id: 'thread',
      }),
    );
    expect(result).toEqual({ success: true, mediaSent: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['email_unsubscribed', 'do_not_contact', 'blacklisted'])(
    'F08 independently blocks %s',
    async (flag) => {
      await client.query(
        'UPDATE leads SET email_unsubscribed=false,do_not_contact=false,blacklisted=false',
      );
      await client.query(`UPDATE leads SET ${flag}=true`);
      send.mockClear();
      const result = await scoped(() =>
        sendCampaignEmailReply({
          id: 91,
          user_id: 9,
          lead_id: 12,
          lead_email: 'recipient@example.test',
          smart_reply: 'Synthetic reply',
          reply_context: context,
          message_id: 'inbound-native',
          gmail_thread_id: 'thread',
        }),
      );
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('suppressed'),
      });
      expect(send).not.toHaveBeenCalled();
    },
  );
});
