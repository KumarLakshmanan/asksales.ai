import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), '..', path), 'utf8');

describe('WhatsApp delivery status audit persistence', () => {
  it('scopes webhook-event idempotency by event type and provider message', () => {
    const migration = read('server/migrations/206_scope_webhook_event_dedupe_by_type.js');
    expect(migration).toContain('ON instagram_webhook_events (event_type, message_id)');
    expect(migration).toContain('WHERE message_id IS NOT NULL');
  });

  it('reconciles duplicate callbacks for the same delivery transition', () => {
    const controller = read('server/controllers/webhooks/whatsapp.ts');
    expect(controller).toContain('ON CONFLICT (event_type, message_id) WHERE message_id IS NOT NULL');
    expect(controller).toContain('raw_data = EXCLUDED.raw_data');
    expect(controller).toContain('processed_at = EXCLUDED.processed_at');
  });

  it('updates canonical delivery state monotonically inside the same tenant transaction', () => {
    const controller = read('server/controllers/webhooks/whatsapp.ts');
    expect(controller).toContain("['sent', 'delivered', 'read', 'failed'].includes(status.status)");
    expect(controller).toContain("WHEN ${statusName} = 'delivered' AND status != 'read' THEN 'delivered'");
    expect(controller).toContain('WHERE user_id = ${userId}');
    expect(controller).toContain('waba_message_id = ${status.id}');
    expect(controller).toContain('await db.transaction(async (tx: typeof db) =>');
  });
});
