import { jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../models/db.js';
import { ownedPaidAdAccount, resolveCampaignGoogleCredentials } from '../services/ads/PaidAdAccountsService.js';
const dialect=new PgDialect();
afterEach(()=>jest.restoreAllMocks());
it('requires both tenant and account ID for selection',async()=>{
  const query=jest.spyOn(db,'execute').mockResolvedValue({rows:[]});
  await expect(ownedPaidAdAccount(12,99)).rejects.toThrow('unavailable');
  const compiled=dialect.sqlToQuery(query.mock.calls[0][0] as any);
  expect(compiled.sql).toContain('user_id=');
  expect(compiled.sql).toContain('id=');
  expect(compiled.params).toEqual([12,99]);
});
it('does not resolve another tenant’s campaign credentials',async()=>{
  const query=jest.spyOn(db,'execute').mockResolvedValue({rows:[]});
  await expect(resolveCampaignGoogleCredentials(12,77)).rejects.toThrow('Campaign not found');
  const compiled=dialect.sqlToQuery(query.mock.calls[0][0] as any);
  expect(compiled.params).toEqual([12,77]);
  expect(query).toHaveBeenCalledTimes(1);
});
