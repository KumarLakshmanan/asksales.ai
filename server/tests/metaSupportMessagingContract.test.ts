import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

describe('Meta support messaging contract', () => {
  const webhook = read('controllers/instagramWebhookController.ts');
  const facebook = read('services/FacebookMessengerService.ts');
  const instagram = read('services/instagramService.ts');
  const instagramGraph = read('services/instagramGraphApiService.ts');
  const delivery = read('services/agents/pipeline/stages/DeliveryStage.ts');
  const retry = read('services/agents/orchestration/DeliveryOutboxService.ts');
  const verification = read('services/integrations/ProviderVerificationService.ts');
  const webhookLogs = read('controllers/integrationWebhookLogsController.ts');
  const webhookConfig = read('controllers/webhooksController.ts');
  const conversationWebhook = read('controllers/webhooks/conversation.ts');
  const instagramOAuth = read('controllers/instagramOAuthController.ts');
  const facebookOAuth = read('controllers/facebookOAuthController.ts');
  const eventSchema = read('models/instagramWebhookEvents/schema.ts');
  const eventAuditMigration = read('migrations/230_add_meta_webhook_event_updated_at.js');

  it('uses the production event-type/message-id idempotency boundary without suppressing agent routing', () => {
    expect(webhook).toContain('ON CONFLICT (event_type, message_id) WHERE message_id IS NOT NULL DO NOTHING');
    expect(webhook).not.toContain('ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING');

    const auditInsert = webhook.indexOf('ON CONFLICT (event_type, message_id) WHERE message_id IS NOT NULL DO NOTHING');
    const routeInbound = webhook.indexOf('await updateConversationWithReply(senderId', auditInsert);
    const auditCatch = webhook.indexOf('[Instagram Webhook] Failed to store message audit', auditInsert);
    expect(auditInsert).toBeGreaterThan(-1);
    expect(auditCatch).toBeGreaterThan(auditInsert);
    expect(routeInbound).toBeGreaterThan(auditCatch);
  });

  it('keeps Facebook Page events in the Facebook identity namespace', () => {
    expect(webhook).toContain("saveWebhookToConversation(owner.userId, { channel: 'facebook', providerAccountId: pageId");
    expect(conversationWebhook).toContain("channel === 'facebook'");
    expect(webhook).not.toContain("platformExtended}->>'facebook_id' = ${senderId} OR");
    expect(webhook).not.toContain('Page has Instagram account — skipping');
    expect(conversationWebhook).toContain(": 'process_facebook_webhook'");
    expect(conversationWebhook).toContain('await jobDispatcher.dispatch(jobName,');
  });

  it('binds generated replies and durable retries to the receiving Meta account', () => {
    expect(facebook).toContain('providerAccountId?: string;');
    expect(facebook).toContain('initializeForUser(userId: number, providerAccountId?: string)');
    expect(facebook).toContain('eq(channelCredentialsTable.accountIdentifier, providerAccountId)');
    expect(delivery).toContain('providerAccountId: typeof ctx.message.metadata?.providerAccountId');
    expect(retry).toContain('providerAccountId: typeof payload.metadata?.providerAccountId');
    expect(retry).toContain('provider_account_id, confirmed_at');
    // Retry retains the originating AI/manual and proposal/reply classification.
    expect(retry).toContain("NOW(), NOW(), ${payload.metadata?.isAiGenerated !== false}");
    expect(retry).toContain("${payload.metadata?.messageKind === 'follow_up' ? 'follow_up' : payload.metadata?.messageKind === 'proposal' ? 'proposal' : 'reply'}");
    expect(retry).toContain('message_kind = EXCLUDED.message_kind');
    expect(retry).toContain('follow_up_origin_message_id = EXCLUDED.follow_up_origin_message_id');
    expect(retry).toContain('follow_up_step = EXCLUDED.follow_up_step');
    expect(retry).toContain('provider_account_id = EXCLUDED.provider_account_id');
  });

  it('preserves native Meta delivery certainty so retries cannot duplicate accepted DMs', () => {
    expect(instagramGraph).toContain('deliveryAttempted: error?.deliveryAttempted === true');
    expect(instagramGraph).toContain("typeof error?.outcomeUncertain === 'boolean'");
    expect(instagram).toContain('deliveryAttempted: graphResult.deliveryAttempted === true');
    expect(instagram).toContain('outcomeUnknown: graphResult.outcomeUncertain === true');
    expect(facebook).toContain('deliveryAttempted: result.deliveryAttempted === true');
    expect(facebook).toContain('outcomeUnknown: result.outcomeUncertain === true');
    expect(delivery).toContain('outcomeUncertain: sendResult.outcomeUnknown === true');
    expect(retry).toContain('outcomeUncertain: result.outcomeUnknown === true');
    expect(retry).toContain('const outcomeUncertain = attempted && providerError?.outcomeUncertain !== false');
  });

  it('sends Meta attachments without an invalid simultaneous text field', () => {
    const facebookAttachment = facebook.slice(
      facebook.indexOf('async sendMessageWithAttachment('),
      facebook.indexOf('async getConversations(', facebook.indexOf('async sendMessageWithAttachment(')),
    );
    const instagramAttachment = instagramGraph.slice(
      instagramGraph.indexOf('async sendMessageWithAttachment('),
      instagramGraph.indexOf('async getConversations(', instagramGraph.indexOf('async sendMessageWithAttachment(')),
    );
    expect(facebookAttachment).not.toContain('message.text =');
    expect(instagramAttachment).not.toContain('messagePayload.text =');
    expect(instagramAttachment).toContain('`/${this.credentials.pageId}/messages`');
    expect(instagramAttachment).toContain('`/${this.credentials.instagramAccountId}/messages`');
    expect(instagramAttachment).toContain('payload: { url: attachmentUrl }');
    expect(instagramAttachment).toContain("'instagram'");
    expect(instagramAttachment).not.toContain('/message_attachments');
    expect(instagramAttachment).toContain('outcomeUncertain !== false');
    expect(facebookAttachment).toContain('outcomeUncertain: false');
    expect(instagramAttachment).toContain('outcomeUncertain: false');
  });

  it('verifies Page subscriptions with the Page token rather than the user token', () => {
    expect(verification).toContain('pageAccessToken: metaPageConnectionsTable.pageAccessToken');
    expect(verification).toContain('pageSubscriptionToken = decryptMetaSecret(connection.pageAccessToken)');
    expect(verification).toContain('headers: { authorization: `Bearer ${pageSubscriptionToken}` }');
  });

  it('recovers exact official-account ownership when Meta connection flags drift', () => {
    expect(webhook).toContain('async function resolveMetaWebhookOwner(');
    expect(webhook).toContain("platform=${credentialPlatform} AND is_active=TRUE");
    expect(webhook).toContain("session_data->>'pageId'=${routingId}");
    expect(webhook).toContain('if (result.rows.length!==1) return null');
    expect(webhook).toContain('user_id = ${userId}');
  });

  it('shows official global callbacks and credential-owned events in tenant diagnostics', () => {
    expect(webhookConfig).toContain('url: `${appUrl}/api/webhooks/instagram`');
    expect(webhookConfig).toContain('url: `${appUrl}/api/webhooks/facebook`');
    expect(webhookConfig).toContain('managed: true');
    expect(webhookLogs).toContain("SELECT account_identifier AS owned_page_id");
    expect(webhookLogs).toContain("SELECT session_data->>'instagramAccountId' AS owned_page_id");
  });

  it('keeps Meta webhook processing timestamps aligned with the production schema', () => {
    expect(webhook).toContain('updated_at = NOW()');
    expect(eventSchema).toContain('updatedAt: timestamp("updated_at").notNull().defaultNow()');
    expect(eventAuditMigration).toContain('ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()');
    expect(eventAuditMigration).toContain('SET updated_at = COALESCE(processed_at, created_at, timestamp, NOW())');
  });

  it('only requests reconnect for rejected Meta authorization, not deployment readiness', () => {
    for (const statusController of [instagramOAuth, facebookOAuth]) {
      expect(statusController).toContain('providerVerificationRequiresReconnect(apiCredential?.readinessErrorCode)');
      expect(statusController).toContain('metaMessagingReadiness(');
      expect(statusController).toContain('...readiness,');
      expect(statusController).toContain('requiresReconnect: Boolean(hasOfficialApi && (apiTokenExpired || providerCredentialInvalid))');
      expect(statusController).toContain('readinessErrorCode: apiCredential?.readinessErrorCode || null');
    }
  });


});
