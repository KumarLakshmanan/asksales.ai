import { jest } from '@jest/globals';
// @ts-expect-error Migration files are intentionally plain ESM JavaScript.
import { down, up } from '../migrations/159_create_social_publish_attempts.js';

describe('social publish attempts migration', () => {
  it('creates the durable idempotent outbox contract and its claim indexes', async () => {
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (statement: string) => {
        statements.push(statement);
        return { rows: [] };
      }),
    };

    await up(client);

    const sql = statements.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS social_publish_attempts');
    expect(sql).toContain('UNIQUE (user_id, idempotency_key)');
    expect(sql).toContain("'provider_succeeded'");
    expect(sql).toContain("'ambiguous'");
    expect(sql).toContain('reconciliation_count INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('social_publish_attempts_due_idx');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS social_publish_attempts_provider_idx');
    expect(sql).toContain('reviewed_payload JSONB NOT NULL');
  });

  it('has a reversible table-level down migration', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    await down({ query });
    expect(query).toHaveBeenCalledWith('DROP TABLE IF EXISTS social_publish_attempts');
  });
});
