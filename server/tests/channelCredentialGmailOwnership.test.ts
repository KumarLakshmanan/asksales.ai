import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';

const execute = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const selectLimit = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const selectWhere = jest.fn((_where: SQL) => ({ limit: selectLimit, orderBy: () => ({ limit: selectLimit }) }));
const selectFrom = jest.fn((_table: unknown) => ({ where: selectWhere }));
const select = jest.fn((_selection?: unknown) => ({ from: selectFrom }));
const updateReturning = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const updateWhere = jest.fn((_where: SQL) => ({ returning: updateReturning }));
const updateSet = jest.fn((_values: unknown) => ({ where: updateWhere }));
const update = jest.fn((_table: unknown) => ({ set: updateSet }));
const insertReturning = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const insertValues = jest.fn((_values: unknown) => ({ returning: insertReturning }));
const insert = jest.fn((_table: unknown) => ({ values: insertValues }));
const tx = { execute, select, update, insert };
const transaction = jest.fn(async (callback: (connection: typeof tx) => Promise<unknown>, _config?: unknown) => callback(tx));

jest.unstable_mockModule('../models/db.js', () => ({ db: { transaction } }));
const { ChannelCredentialModel, GmailMailboxOwnershipConflictError } = await import('../models/channelCredentials/functions.js');
const parse = (value: SQL) => new PgDialect().sqlToQuery(value);

const oauthCredential = (overrides: Record<string, unknown> = {}) => ({
  userId: 12,
  platform: 'gmail_api',
  credentialType: 'oauth',
  accountIdentifier: ' Owner@Example.Test ',
  isActive: true,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockReset().mockImplementation(async query => ({ rows: parse(query as SQL).sql.includes('AS conflict') ? [{ conflict: false }] : [] }));
  selectLimit.mockResolvedValue([]);
  updateReturning.mockResolvedValue([]);
  insertReturning.mockResolvedValue([]);
  transaction.mockImplementation(async callback => callback(tx));
});

const inBusiness = <T>(work: () => T) => withBusinessScope({ userId: 12, businessProfileId: 21 }, work);

describe('Gmail mailbox ownership on credential upsert', () => {
  it('serializes mailbox connects and rejects an active connection owned by another tenant', async () => {
    execute.mockImplementation(async query => ({ rows: parse(query as SQL).sql.includes('AS conflict') ? [{ conflict: true }] : [] }));

    await expect(inBusiness(() => ChannelCredentialModel.upsert(oauthCredential() as never)))
      .rejects.toBeInstanceOf(GmailMailboxOwnershipConflictError);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(4);
    const lock = parse(execute.mock.calls[0][0] as SQL);
    expect(lock.sql).toContain('pg_advisory_xact_lock');
    expect(lock.params).toContain('channel_credentials:gmail_api:owner@example.test');

    const ownershipCheck = parse(execute.mock.calls[2][0] as SQL);
    expect(ownershipCheck.sql).toContain('LOWER(TRIM');
    expect(ownershipCheck.sql).toContain('business_profile_id IS DISTINCT FROM');
    expect(ownershipCheck.params).toEqual([21, 12, 'owner@example.test']);
    expect(parse(execute.mock.calls[1][0] as SQL).sql).toContain("'app.business_system', 'on'");
    expect(parse(execute.mock.calls[3][0] as SQL).sql).toContain("'app.business_system', 'off'");
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'read committed' });
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('updates this tenant’s case-insensitive mailbox match on reconnect', async () => {
    const existing = { id: 51, userId: 12, platform: 'gmail_api', accountIdentifier: 'Owner@Example.Test' };
    const updated = { ...existing, accountIdentifier: 'owner@example.test' };
    selectLimit.mockResolvedValueOnce([existing]);
    updateReturning.mockResolvedValueOnce([updated]);

    await expect(inBusiness(() => ChannelCredentialModel.upsert(oauthCredential() as never))).resolves.toEqual(updated);

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      accountIdentifier: 'owner@example.test',
      isActive: true,
      businessProfileId: 21,
    }));
    expect(insert).not.toHaveBeenCalled();
  });
  it('requires an authorized business and rejects supplied foreign owner/profile before transaction', async () => {
    await expect(ChannelCredentialModel.upsert(oauthCredential() as never)).rejects.toThrow('business profile');
    await expect(inBusiness(() => ChannelCredentialModel.upsert(oauthCredential({ userId: 99 }) as never))).rejects.toThrow('authorized business');
    await expect(inBusiness(() => ChannelCredentialModel.upsert(oauthCredential({ businessProfileId: 22 }) as never))).rejects.toThrow('authorized business');
    expect(transaction).not.toHaveBeenCalled();
  });
  it('restores tenant visibility after a failed or unverifiable conflict read and performs no write', async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(inBusiness(() => ChannelCredentialModel.upsert(oauthCredential() as never))).rejects.toThrow('ownership could not be verified');
    expect(parse(execute.mock.calls.at(-1)![0] as SQL).sql).toContain("'app.business_system', 'off'");
    expect(update).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
  });
  it('aborts if restoring business visibility fails instead of writing in system scope', async () => {
    execute.mockImplementation(async query => {
      const statement = parse(query as SQL).sql;
      if (statement.includes("'app.business_system', 'off'")) throw new Error('fixture restore failed');
      return { rows: statement.includes('AS conflict') ? [{ conflict: false }] : [] };
    });
    await expect(inBusiness(() => ChannelCredentialModel.upsert(oauthCredential() as never))).rejects.toThrow('restore failed');
    expect(update).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
  });

});
