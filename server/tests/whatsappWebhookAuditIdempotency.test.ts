import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), '..', path), 'utf8');

describe('WhatsApp webhook audit event idempotency', () => {
  it('ignores provider retries that already have an audit event', () => {
    const controller = read('server/controllers/webhooks/whatsapp.ts');
    const start = controller.indexOf('async function processWhatsAppMessage(');
    const end = controller.indexOf('async function processWhatsAppStatus(', start);
    const handler = controller.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain("'whatsapp_message'");
    expect(handler).toContain('ON CONFLICT DO NOTHING');
  });

  it('keeps a unique event-type/message-id index for idempotency', () => {
    const migration = read('server/migrations/206_scope_webhook_event_dedupe_by_type.js');
    expect(migration).toContain('ON instagram_webhook_events (event_type, message_id)');
    expect(migration).toContain('WHERE message_id IS NOT NULL');
  });
});
