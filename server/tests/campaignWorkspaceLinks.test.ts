import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';
const execute = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
const { assertOwnedCampaignThread, associateCampaignContact, CampaignWorkspaceError } = await import('../services/CampaignWorkspaceService.js');
const scoped = <T>(work: () => T) => withBusinessScope({ userId: 9, businessProfileId: 101 }, work);
const compiled = (index: number) => new PgDialect().sqlToQuery(execute.mock.calls[index][0] as SQL);
beforeEach(() => { execute.mockReset(); });
describe('explicit campaign workspace ownership', () => {
  it('checks active thread, account and selected business before linking a contact', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 12 }] }).mockResolvedValueOnce({ rows: [{ contact_id: 8 }] });
    await scoped(() => associateCampaignContact({ execute } as any, 9, 8, 12));
    expect(compiled(0).params).toEqual([12, 9, 101]);
    expect(compiled(0).sql).toContain('deleted_at IS NULL');
    expect(compiled(1).sql).toContain('ON CONFLICT (contact_id,thread_id)');
    expect(compiled(1).params).toContain(101);
  });
  it('does not write when the campaign belongs to another business or is deleted', async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(scoped(() => associateCampaignContact({ execute } as any, 9, 8, 99))).rejects.toBeInstanceOf(CampaignWorkspaceError);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid campaign IDs without querying', async () => {
    await expect(scoped(() => assertOwnedCampaignThread(9, -12))).rejects.toBeInstanceOf(CampaignWorkspaceError);
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects an unavailable contact instead of creating an unowned association', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 12 }] }).mockResolvedValueOnce({ rows: [] });
    await expect(scoped(() => associateCampaignContact({ execute } as any, 9, 999, 12))).rejects.toThrow('CRM contact not found.');
  });
});
