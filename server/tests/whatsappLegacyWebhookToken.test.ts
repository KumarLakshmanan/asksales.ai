import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), '..', path), 'utf8');

describe('legacy WhatsApp webhook token compatibility', () => {
  it('retires durable legacy URL bindings at the public capability boundary', () => {
    const middleware = read('server/middleware/businessWebhookScope.ts');
    expect(middleware).toContain('parseWebhookCapability');
    expect(middleware).toContain('verifyWebhookCapability');
    expect(middleware).not.toContain('legacy_webhook_token_hash');
    expect(read('server/migrations/579_rotate_exposed_webhook_capabilities.js')).toContain('legacy_webhook_token_hash=NULL');
  });

  it('adds a constrained hash-only column and partial lookup index', () => {
    const migration = read('server/migrations/200_add_legacy_whatsapp_webhook_token_hash.js');
    expect(migration).toContain('legacy_webhook_token_hash VARCHAR(64)');
    expect(migration).toContain("legacy_webhook_token_hash ~ '^[a-f0-9]{64}$'");
    expect(migration).toContain("WHERE platform = 'whatsapp'");
  });

  it('clears compatibility bindings when a user rotates webhook credentials', () => {
    const controller = read('server/controllers/webhooksController.ts');
    expect(controller).toContain('set({ legacyWebhookTokenHash: null, updatedAt: new Date() })');
  });
});
