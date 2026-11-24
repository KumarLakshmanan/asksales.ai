import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';

describe('privacy vault provider idempotency migration', () => {
  it('creates a non-partial unique index compatible with the runtime conflict target', () => {
    const sql = readFileSync(new URL('../migrations/218_repair_privacy_vault_provider_conflict.js', import.meta.url), 'utf8');
    const up = sql.slice(sql.indexOf('export async function up'), sql.indexOf('export async function down'));
    expect(up).toContain('CREATE UNIQUE INDEX support_privacy_vault_provider_message_uq');
    expect(up).toContain('ON support_privacy_vault(user_id, channel, provider_message_id)');
    expect(up).not.toContain('WHERE provider_message_id IS NOT NULL');
  });
});
