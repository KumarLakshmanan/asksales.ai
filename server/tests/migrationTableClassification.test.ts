import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The API and workers refuse to start while any table is unclassified
 * (tenancy/schemaGuard.ts). Migration 299 classified every table that existed
 * then; each table created later must be registered in business_scope_tables
 * (business-owned, with row security) or business_scope_accounts (global) by
 * the migration that creates it or a later one. Catch a missing registration
 * here, before a release crash-loops the API.
 */
const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrations = readdirSync(directory)
  .filter(file => /^\d+_.+\.(?:js|mjs|cjs|sql)$/.test(file))
  .sort()
  .map(file => {
    const text = readFileSync(`${directory}${file}`, 'utf8');
    // Only the forward migration counts: down() names tables in DELETEs.
    const up = text.split(/export\s+(?:async\s+)?function\s+down\b/)[0];
    return { file, number: Number.parseInt(file, 10), up };
  });

const created = /CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const dropped = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:(?:public\.)?"?[a-z_][a-z0-9_]*"?\s*,\s*)*(?:public\.)?"?[a-z_][a-z0-9_]*"?)/gi;
const quoted = /['"`]([a-z_][a-z0-9_]*)['"`]/gi;
const registers = /business_scope_(?:tables|accounts)/;

export function unclassifiedTables(list: typeof migrations) {
  const pending = new Map<string, string>();
  for (const migration of list) {
    if (migration.number <= 299) continue;
    for (const match of migration.up.matchAll(created)) pending.set(match[1].toLowerCase(), migration.file);
    for (const match of migration.up.matchAll(dropped)) {
      for (const name of match[1].split(',')) pending.delete(name.replace(/public\.|"/g, '').trim().toLowerCase());
    }
    if (registers.test(migration.up)) {
      for (const match of migration.up.matchAll(quoted)) pending.delete(match[1].toLowerCase());
    }
  }
  return [...pending].map(([table, file]) => `${table} (created in ${file})`);
}

describe('migration table classification', () => {
  it('registers every table created after migration 299', () => {
    expect(unclassifiedTables(migrations)).toEqual([]);
  });

  it('would have caught the WhatsApp billing tables before migration 596', () => {
    const without596 = migrations.filter(migration => migration.number !== 596);
    expect(unclassifiedTables(without596)).toEqual(expect.arrayContaining([
      'whatsapp_rate_cards (created in 595_whatsapp_platform_billing.js)',
      'whatsapp_rate_markets (created in 595_whatsapp_platform_billing.js)',
      'whatsapp_billing_accounts (created in 595_whatsapp_platform_billing.js)',
      'whatsapp_billing_reconciliation (created in 595_whatsapp_platform_billing.js)',
    ]));
  });
});
