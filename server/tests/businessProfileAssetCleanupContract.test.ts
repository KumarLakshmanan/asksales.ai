import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { currentDatabaseScope } from '../tenancy/businessContext.js';

type Receipt = { id: string; user_id: number; storage_key: string; storage_backend: string; attempts: number };
type FixtureTransaction = { execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }> };
type CleanupInput = {
  identity: { ownerUserId: number; storageBackend: string; storageKey: string };
  expectedNamespace: string;
  loadIntent(tx: FixtureTransaction): Promise<boolean>;
  acknowledge(tx: FixtureTransaction): Promise<boolean | void>;
};
type CleanupResult = { status: 'deleted' | 'already_consumed' | 'referenced' | 'deferred'; reason?: string };
const consume = jest.fn<(input: CleanupInput) => Promise<CleanupResult>>();
let receipts: Receipt[] = [];
let failCounter = false;
const globalStatements: Array<{ sql: string; params: unknown[] }> = [];
const transactionStatements: Array<{ sql: string; params: unknown[] }> = [];
const tuple = (receipt: Receipt) => [receipt.id, receipt.user_id, receipt.storage_key, receipt.storage_backend];
const matches = (receipt: Receipt, params: unknown[]) => JSON.stringify(tuple(receipt)) === JSON.stringify(params);
const tx: FixtureTransaction = { execute: async query => {
  const statement = new PgDialect().sqlToQuery(query); transactionStatements.push(statement);
  const index = receipts.findIndex(receipt => matches(receipt, statement.params));
  if (statement.sql.startsWith('SELECT id FROM business_profile_asset_cleanup')) {
    expect(statement.sql).toContain('FOR UPDATE');
    return { rows: index < 0 ? [] : [{ id: receipts[index].id }] };
  }
  if (statement.sql.startsWith('DELETE FROM business_profile_asset_cleanup')) {
    expect(statement.sql).toContain('RETURNING id');
    return { rows: index < 0 ? [] : [{ id: receipts.splice(index, 1)[0].id }] };
  }
  throw new Error('Unexpected transaction operation in Data callback');
} };
const execute = async (query: SQL) => {
  const statement = new PgDialect().sqlToQuery(query); globalStatements.push(statement);
  if (statement.sql.startsWith('SELECT * FROM business_profile_asset_cleanup')) return { rows: receipts.map(receipt => ({ ...receipt })) };
  if (statement.sql.startsWith('UPDATE business_profile_asset_cleanup SET attempts')) {
    if (failCounter) { failCounter = false; throw new Error('Synthetic retry-counter failure'); }
    const receipt = receipts.find(receipt => matches(receipt, statement.params));
    if (receipt) receipt.attempts++;
    return { rows: [] };
  }
  throw new Error('Data must not acknowledge cleanup outside the canonical transaction');
};
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
// Isolated contract seam. The separate PostgreSQL suite exercises the actual
// canonical consumer and migration480; this mock is not combined acceptance.
jest.unstable_mockModule('../services/managedStorageCleanup', () => ({ consumeManagedStorageCleanup: consume }));
const { objectStorage } = await import('../services/ObjectStorageService.js');
const providerDelete = jest.spyOn(objectStorage, 'delete').mockResolvedValue(undefined);
const { cleanupDeletedProfileAssets } = await import('../services/businessProfileAssetCleanup.js');
const seed = (id = '1', key = '9/brand_asset/synthetic.png', backend = 'local'): Receipt => ({ id, user_id: 9, storage_key: key, storage_backend: backend, attempts: 0 });
beforeEach(() => {
  receipts = []; failCounter = false; globalStatements.length = 0; transactionStatements.length = 0;
  providerDelete.mockClear(); process.env.STORAGE_BACKEND = 'local'; consume.mockReset();
  consume.mockImplementation(async input => {
    expect(currentDatabaseScope()?.kind).toBe('system');
    if (!await input.loadIntent(tx)) return { status: 'already_consumed' };
    return { status: await input.acknowledge(tx) ? 'deleted' : 'deferred' };
  });
});

describe('Data adapter for the canonical managed cleanup contract (isolated mocks)', () => {
  it('delegates an existing receipt and qualifies both callbacks inside the supplied transaction', async () => {
    receipts = [seed()]; await cleanupDeletedProfileAssets(9, ['1']);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0][0]).toMatchObject({ identity: { ownerUserId: 9, storageBackend: 'local', storageKey: '9/brand_asset/synthetic.png' }, expectedNamespace: '9/brand_asset' });
    expect(transactionStatements).toHaveLength(2);
    for (const statement of transactionStatements) expect(statement.params).toEqual(['1', 9, '9/brand_asset/synthetic.png', 'local']);
    expect(receipts).toEqual([]); expect(providerDelete).not.toHaveBeenCalled();
    expect(currentDatabaseScope()).toBeUndefined();
    expect(globalStatements.some(statement => /storage_quotas|storage_files|DELETE FROM/.test(statement.sql))).toBe(false);
  });
  it('does not scan for an empty receipt selection', async () => {
    await cleanupDeletedProfileAssets(9, []); expect(globalStatements).toEqual([]); expect(consume).not.toHaveBeenCalled();
  });
  it.each(['10/brand_asset/foreign.png', '9/document/wrong.png', '9/brand_asset/../document/traversal.png'])('retains unsafe namespace %s', async key => {
    receipts = [seed('1', key)]; await cleanupDeletedProfileAssets();
    expect(consume).not.toHaveBeenCalled(); expect(providerDelete).not.toHaveBeenCalled(); expect(receipts[0].attempts).toBe(1);
  });
  it('retains mismatched backend receipts without invoking the consumer', async () => {
    receipts = [seed('1', undefined, 's3')]; await cleanupDeletedProfileAssets();
    expect(consume).not.toHaveBeenCalled(); expect(receipts[0].attempts).toBe(1);
  });
  it('passes normalized identity but qualifies callbacks with the original key and backend alias', async () => {
    process.env.STORAGE_BACKEND = 's3'; receipts = [seed('1', './9/brand_asset/synthetic.png', 'aws')];
    await cleanupDeletedProfileAssets();
    expect(consume.mock.calls[0][0].identity).toEqual({ ownerUserId: 9, storageBackend: 'aws', storageKey: '9/brand_asset/synthetic.png' });
    expect(transactionStatements[0].params).toEqual(['1', 9, './9/brand_asset/synthetic.png', 'aws']);
    expect(receipts).toEqual([]);
  });
  it('keeps referenced objects pending without acknowledging or releasing quota', async () => {
    consume.mockResolvedValue({ status: 'referenced' }); receipts = [seed()];
    await cleanupDeletedProfileAssets(); expect(receipts).toEqual([seed()]); expect(transactionStatements).toEqual([]);
    expect(providerDelete).not.toHaveBeenCalled();
    expect(globalStatements).toHaveLength(1);
  });
  it('leaves an already-consumed receipt alone', async () => {
    consume.mockResolvedValue({ status: 'already_consumed' }); receipts = [seed()];
    await cleanupDeletedProfileAssets(); expect(receipts).toEqual([seed()]); expect(globalStatements).toHaveLength(1);
  });
  it.each(['deferred', 'throws'] as const)('keeps %s work and consumes that same receipt on a later pass', async outcome => {
    receipts = [seed()];
    if (outcome === 'throws') consume.mockRejectedValueOnce(new Error('Synthetic canonical consumer failure'));
    else consume.mockResolvedValueOnce({ status: 'deferred', reason: 'provider_or_ack_uncertain' });
    await cleanupDeletedProfileAssets(); expect(receipts[0].attempts).toBe(1);
    await cleanupDeletedProfileAssets(); expect(receipts).toEqual([]); expect(providerDelete).not.toHaveBeenCalled();
  });
  it.each(['id', 'user_id', 'storage_key', 'storage_backend'] as const)('rejects a stale %s during fresh load', async field => {
    receipts = [seed()]; consume.mockImplementationOnce(async input => {
      receipts[0] = { ...receipts[0], [field]: field === 'user_id' ? 10 : 'changed' };
      expect(await input.loadIntent(tx)).toBe(false); return { status: 'already_consumed' };
    });
    await cleanupDeletedProfileAssets(); expect(receipts).toHaveLength(1); expect(transactionStatements).toHaveLength(1);
  });
  it.each(['id', 'user_id', 'storage_key', 'storage_backend'] as const)('rejects a stale %s during acknowledgement', async field => {
    receipts = [seed()]; consume.mockImplementationOnce(async input => {
      expect(await input.loadIntent(tx)).toBe(true);
      receipts[0] = { ...receipts[0], [field]: field === 'user_id' ? 10 : 'changed' };
      expect(await input.acknowledge(tx)).toBe(false); return { status: 'deferred' };
    });
    await cleanupDeletedProfileAssets(); expect(receipts).toHaveLength(1); expect(transactionStatements).toHaveLength(2);
  });
  it('retains work and continues another receipt when retry bookkeeping is also unavailable', async () => {
    receipts = [seed(), seed('2', '9/brand_asset/other.png')]; failCounter = true;
    consume.mockRejectedValueOnce(new Error('Synthetic consumer failure'));
    await expect(cleanupDeletedProfileAssets()).resolves.toBeUndefined();
    expect(consume).toHaveBeenCalledTimes(2); expect(receipts).toEqual([seed()]);
  });
});
