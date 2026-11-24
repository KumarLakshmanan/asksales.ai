import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withBusinessScope, currentBusinessScope } from '../tenancy/businessContext.js';
const execute = jest.fn<(...args: any[]) => Promise<any>>();
const settings = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../models/outreachSettings/functions.js', () => ({ getOutreachSettingsByUserId: settings }));
const { appendEmailOpenPixel, prepareEmailOpenTracking, recordEmailImageLoad, attachEmailOpenTracking } = await import('../services/EmailOpenTrackingService.js');
const scope = { userId: 9, businessProfileId: 7 };
const id = '762aa101-cc53-4de8-9299-cbba4d07d62d';
const dialect = new PgDialect();
beforeEach(() => { execute.mockReset(); settings.mockReset().mockResolvedValue({ enableTracking: true }); });
describe('Gmail image-load tracking', () => {
  it('respects the business tracking preference without creating a token', async () => {
    settings.mockResolvedValue({ enableTracking: false });
    await expect(withBusinessScope(scope, () => prepareEmailOpenTracking(9, '<p>Hello</p>'))).resolves.toEqual({ html: '<p>Hello</p>' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('requires the exact business owner scope', async () => {
    await expect(prepareEmailOpenTracking(9, 'Hello')).rejects.toThrow('business profile');
    await expect(withBusinessScope(scope, () => prepareEmailOpenTracking(10, 'Hello'))).rejects.toThrow('scope');
    expect(execute).not.toHaveBeenCalled();
  });
  it('uses the durable send identity for repeat attempts and does not expose the recipient', async () => {
    execute.mockResolvedValue({ rows: [{ id }] });
    const result = await withBusinessScope(scope, () => prepareEmailOpenTracking(9, '<body>Hello</body>', 'intent-12', 'support@example.com'));
    expect(result.html).toContain(`/api/email-events/open/${id}.gif`);
    expect(result.html.indexOf('data-asksales-open-tracker')).toBeLessThan(result.html.indexOf('</body>'));
    expect(result.html).not.toContain('intent-12');
    const query = dialect.sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain('ON CONFLICT(business_profile_id,user_id,intent_key)');
    expect(query.params).toContain(7);
  });
  it('ignores malformed tokens without querying storage', async () => {
    await recordEmailImageLoad('1 OR 1=1');
    expect(execute).not.toHaveBeenCalled();
  });
  it('updates only the resolved business after accepted, unexpired token lookup', async () => {
    const contexts: unknown[] = [];
    execute.mockImplementation(async query => {
      contexts.push(currentBusinessScope());
      if (execute.mock.calls.length === 1) return { rows: [{ user_id: 9, business_profile_id: 7 }] };
      expect(dialect.sqlToQuery(query).sql).toContain('accepted_at IS NOT NULL');
      expect(dialect.sqlToQuery(query).sql).toContain("interval '10 minutes'");
      return { rows: [] };
    });
    await recordEmailImageLoad(id);
    expect(contexts[0]).toBeUndefined();
    expect(contexts[1]).toMatchObject(scope);
  });
  it('keeps image-load observations separate from delivery/read receipts', async () => {
    execute.mockResolvedValue({ rows: [{ message_id: 1, provider_message_id: 'gmail123', opened_at: '2026-10-29T01:00:00Z', open_count: 1 }] });
    const result = await withBusinessScope(scope, () => attachEmailOpenTracking([{ id: 1, externalMessageId: 'gmail123', status: 'sent', deliveredAt: null, readAt: null }]));
    expect(result[0]).toMatchObject({ status: 'sent', deliveredAt: null, readAt: null, emailTracking: { source: 'image_load', openCount: 1 } });
    const query = dialect.sqlToQuery(execute.mock.calls[0][0]);
    expect(query.params).toContain(9); expect(query.params).toContain(7);
  });
  it('inserts a single transport pixel without altering message text', () => {
    expect(appendEmailOpenPixel('<p>Message</p>', 'https://example.com/a.gif')).toMatch(/^<p>Message<\/p><img /);
  });
});
