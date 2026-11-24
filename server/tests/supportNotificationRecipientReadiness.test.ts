import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db } from '../models/db.js';
import { getGlobalSupportNotificationSettings } from '../controllers/supportNotificationSettingsController.js';
import { supportMemberNotificationService } from '../services/SupportMemberNotificationService.js';
import { whatsappApiService } from '../services/whatsappApiService.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const member = {
  member_id: 3, member_name: 'Support QA', member_email: ' Support.QA@Example.test ',
  team_id: 1, team_name: 'Billing', is_active: true,
  whatsapp_hint: null, whatsapp_verification: null,
};

describe('persisted recipient contact readiness', () => {
  beforeEach(() => {
    jest.spyOn(whatsappApiService, 'resolveCreds').mockResolvedValue(null);
    jest.spyOn(supportMemberNotificationService, 'platformAvailability').mockReturnValue({
      email: 'provider_unavailable', whatsapp: 'provider_unavailable', slack: 'provider_unavailable',
      teams: 'provider_unavailable', browser_push: 'provider_unavailable',
      instagram: 'provider_unavailable', facebook: 'provider_unavailable',
    });
  });
  afterEach(() => { jest.restoreAllMocks(); });

  async function read(row: Record<string, unknown> = member) {
    // All persistence is mocked; no provider sends, contact writes or live DB access.
    const execute = jest.spyOn(db, 'execute').mockImplementation(async (statement: unknown) => {
      const query = new PgDialect().sqlToQuery(statement as SQL);
      return { rows: query.sql.includes('FROM team_members tm') ? [row] : [] };
    });
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    await withBusinessScope({ userId: 4101, actorUserId: 4201, businessProfileId: 51 }, () =>
      getGlobalSupportNotificationSettings({ user: { id: 4201 } } as Request, { json, status } as unknown as Response));
    expect(status).not.toHaveBeenCalled();
    const response = json.mock.calls[0][0] as {
      data: { email: { providerState: string }; recipients: Array<Record<string, unknown>> };
    };
    return { settings: response.data, queries: execute.mock.calls.map(([statement]) => new PgDialect().sqlToQuery(statement as SQL)) };
  }

  it('uses the valid persisted login email before an encrypted email destination has been synchronized', async () => {
    const { settings } = await read();
    expect(settings.recipients[0]).toMatchObject({
      memberId: 3, teamName: 'Billing', emailReady: true, emailHint: 'su********@example.test',
      whatsappReady: false, whatsappHint: null, memberProfileUrl: '/dashboard/support/teams/1/members/3',
    });
    expect(settings.recipients[0]).not.toHaveProperty('member_email');
  });

  it.each([null, undefined, '', '  ', 'invalid', 'person@example.test\r\nBcc: other@example.test'])(
    'reports missing or invalid login email %p even with a stale verified destination', async (email) => {
      const { settings } = await read({ ...member, member_email: email, email_verification: 'owner_verified', email_hint: 'ol*@example.test' });
      expect(settings.recipients[0]).toMatchObject({ emailReady: false, emailHint: null });
    });

  it('keeps provider availability and the independent WhatsApp destination separate from email readiness', async () => {
    const { settings } = await read({ ...member, whatsapp_verification: 'owner_verified', whatsapp_hint: '+91 ******1234' });
    expect(settings.email.providerState).toBe('provider_unavailable');
    expect(settings.recipients[0]).toMatchObject({ emailReady: true, whatsappReady: true, whatsappHint: '+91 ******1234' });
  });

  it('keeps the read in the active business owner tenant with team-scoped destination joins and no writes', async () => {
    const { queries } = await read();
    const recipientQuery = queries.find(query => query.sql.includes('FROM team_members tm'))!;
    expect(recipientQuery.params).toEqual([4101]);
    expect(recipientQuery.sql).toContain('st.user_id=tm.user_id');
    expect(recipientQuery.sql).toContain('whatsapp_destination.user_id=tm.user_id');
    expect(recipientQuery.sql).toContain('whatsapp_destination.team_id=tm.team_id');
    expect(queries.every(query => query.sql.trim().startsWith('SELECT'))).toBe(true);
  });
});
