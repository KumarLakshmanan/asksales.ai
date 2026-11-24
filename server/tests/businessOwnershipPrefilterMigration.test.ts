import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
// @ts-expect-error Production migrations are JavaScript modules.
const migration = await import('../migrations/577_index_business_ownership_parent_lookups.js');

const source = readFileSync(new URL('../migrations/299_business_profile_isolation.js', import.meta.url), 'utf8');
const start = source.indexOf('CREATE OR REPLACE FUNCTION enforce_business_ownership()');
const original = source.slice(start, source.indexOf('END $$', start) + 'END $$'.length);
function fixture(definition = original) {
  let current = definition;
  const query = jest.fn<(sql: string) => Promise<{ rows: Array<{ definition: string }> }>>(async sql => {
    if (sql.startsWith('SELECT pg_get_functiondef')) return { rows: [{ definition: current }] };
    current = sql;
    return { rows: [] };
  });
  return { query, definition: () => current };
}

describe('indexed business ownership parent lookups', () => {
  it('changes only the parent predicate and retains every existing ownership check', async () => {
    const client = fixture();
    await migration.up(client);
    const patched = client.definition();
    expect(patched).toContain('ownership_indexed_prefilter_v1');
    expect(patched).toContain('key_oid IN (20,21,23,2950)');
    expect(patched).toContain("original_predicate text := format('%I::text=%L'");
    expect(patched).toContain("format('(%I=%L::%s AND %s)'");
    expect(patched).toContain('match_sql:=match_sql||original_predicate;');
    await migration.down(client);
    expect(client.definition()).toBe(original);
  });
  it('is idempotent in both directions', async () => {
    const client = fixture();
    await migration.up(client); await migration.up(client);
    expect(client.query).toHaveBeenCalledTimes(3);
    await migration.down(client); await migration.down(client);
    expect(client.query).toHaveBeenCalledTimes(6);
  });
  it('fails closed if the guard is missing or the expected predicate changed', async () => {
    const missing = { query: async () => ({ rows: [] }) };
    await expect(migration.up(missing)).rejects.toThrow('missing');
    const changed = fixture(original.replace("format('%I::text=%L'", "format('%I = %L'"));
    await expect(migration.up(changed)).rejects.toThrow('refusing');
    expect(changed.query).toHaveBeenCalledTimes(1);
  });
});
