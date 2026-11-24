import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {withBusinessScope} from '../tenancy/businessContext.js';

const execute = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ rows: [] });
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
const { assistantFollowUps,scheduleAssistantFollowUp } = await import('../services/assistants/AssistantFollowUps.js');
const originalEnabled = process.env.SUPPORT_ASSISTANTS_ENABLED;
const originalProfiles = process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
afterEach(() => {
  if (originalEnabled === undefined) delete process.env.SUPPORT_ASSISTANTS_ENABLED;
  else process.env.SUPPORT_ASSISTANTS_ENABLED = originalEnabled;
  if (originalProfiles === undefined) delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
  else process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES = originalProfiles;
  execute.mockClear();
});
describe('assistant follow-up rollout inventory', () => {
  it('does not schedule another check-in after a confirmed courtesy acknowledgement',async()=>{
    process.env.SUPPORT_ASSISTANTS_ENABLED='true';process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES='';
    execute.mockResolvedValueOnce({rows:[{id:99,channel:'whatsapp',automation_mode:'ai_active',metadata:{assistant:{revision:4},suppressAssistantFollowUp:true}}]});
    expect(await withBusinessScope({userId:9,actorUserId:9,businessProfileId:7,role:'owner'},()=>scheduleAssistantFollowUp(99))).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('uses individual bound workspace IDs when a rollout is configured', async () => {
    process.env.SUPPORT_ASSISTANTS_ENABLED = 'true';
    process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES = '1,7';
    await expect(assistantFollowUps.processDue()).resolves.toBe(0);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).toMatch(/business_profile_id IN \(\$\d+, \$\d+\)/);
    expect(query.params).toEqual(expect.arrayContaining([1, 7]));
  });
});
