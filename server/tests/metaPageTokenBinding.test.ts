/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
process.env.SECRETS_ENCRYPTION_KEY = 'meta-binding-test-key-at-least-32-characters';
const limit = jest.fn<any>();
const where = jest.fn<(query: SQL) => Promise<void>>().mockResolvedValue(undefined);
const set = jest.fn<(fields: { apiKey: string }) => { where: typeof where }>(() => ({ where }));
const selectWhere = jest.fn<(query: SQL) => { limit: typeof limit }>(() => ({ limit }));
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  select: () => ({ from: () => ({ where: selectWhere }) }),
  update: () => ({ set }),
} }));
const { preserveMetaPageTokenBindings } = await import('../services/integrations/MetaPageTokenBinding.js');
const { decryptMetaSecret } = await import('../utils/metaCredentialSecrets.js');

beforeEach(() => { jest.clearAllMocks(); });

describe('independent Meta Page tokens', () => {
  it('pins encrypted legacy Page tokens only to the initiating user and matching OAuth accounts', async () => {
    limit.mockResolvedValue([{ id: 4, pageId: 'page-one', instagramAccountId: 'ig-one', pageAccessToken: 'legacy-page-token', facebookActive: true, instagramActive: true }]);
    const connection = await preserveMetaPageTokenBindings(42, 'page-one');
    expect(connection?.facebookActive).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    const fields = set.mock.calls[0][0];
    expect(fields.apiKey).not.toBe('legacy-page-token');
    expect(decryptMetaSecret(fields.apiKey)).toBe('legacy-page-token');
    const query = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(query.params).toEqual(expect.arrayContaining([42, 'oauth', true, 'facebook_api', 'page-one', 'instagram_api', 'ig-one']));
    expect(query.sql).toContain('"api_key" is null');
    const lookup = new PgDialect().sqlToQuery(selectWhere.mock.calls[0][0]);
    expect(lookup.params).toEqual([42, 'page-one']);
  });
  it('does not manufacture Facebook or Instagram credentials for a newly authorized Page', async () => {
    limit.mockResolvedValue([]);
    expect(await preserveMetaPageTokenBindings(42, 'page-new')).toBeUndefined();
    expect(set).not.toHaveBeenCalled();
  });
});
