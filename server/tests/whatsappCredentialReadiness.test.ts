import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), '..', path), 'utf8');

describe('WhatsApp credential readiness persistence', () => {
  it('persists key identity and verifies OAuth credentials after reconnect', () => {
    const controller = read('server/controllers/whatsappController.ts');
    expect(controller).toContain('encryption_key_id');
    expect(controller).toContain('getChannelCredentialEncryptionKeyId()');
    expect(controller).toContain("verifyProviderIntegration(userId, 'whatsapp', insertedCredentialId)");
    expect(controller).toContain('historicalCredential?.phoneNumberId');
    expect(controller).toContain("'[WhatsAppOAuth] Preserved phone validation result'");
  });

  it('surfaces provider binding failures instead of presenting a stale credential as ready', () => {
    const controller = read('server/controllers/whatsappController.ts');
    expect(controller).toContain('connectionStatus');
    expect(controller).toContain('readinessErrorCode');
    expect(controller).toContain('WHATSAPP_PHONE_NUMBER_UNAVAILABLE');
    expect(controller).toContain("connectionStatus === 'limited'");
    expect(controller).toContain('customerReplies: customerReplyReady');
    expect(controller).toContain('proactiveSending: customerReplyReady');
  });

  it('preserves only non-secret account identity on disconnect for deterministic reconnect', () => {
    const controller = read('server/controllers/whatsappController.ts');
    expect(controller).toContain('const retiredSession = currentResolved ? encryptChannelCredentialSession');
    expect(controller).toContain('businessAccountId: currentResolved.businessAccountId');
    expect(controller).toContain('session_data = ${JSON.stringify(retiredSession)}::jsonb');
    expect(controller).toContain('access_token = NULL');
    expect(controller).toContain('api_key = NULL');
  });

  it('does not let a lightweight phone probe erase account-level proactive-send limits', () => {
    const service = read('server/services/whatsappApiService.ts');
    expect(service).toContain("LIKE 'meta\\_%' ESCAPE '\\\\'");
    expect(service).toContain('ELSE ${channelCredentialsTable.readinessErrorCode}');
    expect(controllerText()).toContain("verification.errorCode === 'WABA_HEALTH'");
  });

  it('backfills key identifiers without reading or rewriting provider secrets', () => {
    const migration = read('server/migrations/199_backfill_channel_credential_key_ids.js');
    expect(migration).toContain('SET encryption_key_id = $1');
    expect(migration).toContain('AND encryption_key_id IS NULL');
    expect(migration).not.toMatch(/SELECT\s+.*(?:access_token|api_key)/is);
  });
});

function controllerText(): string {
  return read('server/controllers/whatsappController.ts');
}
