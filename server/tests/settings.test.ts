/**
 * Settings Controller Tests
 * Tests: lead settings, outreach settings, user preferences
 * Note: settingsController uses req.user!.id (throws TypeError) — no explicit 401
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AuthenticatedRequest } from '../types/express.js';
import type { OutreachSettings } from '../models/outreachSettings/schema.js';
import { FollowUpSettingsConflictError } from '../utils/followUpSettingsRevision.js';

function outreachRow(): OutreachSettings {
  return {
    id: 1, businessProfileId: 1, userId: 1, emailProvider: 'gmail',
    senderName: null, senderEmail: null, replyToEmail: null, emailSignature: null,
    emailDesignPreferences: { outreach: 'classic', assistant: 'classic', revision: 'initial' },
    enableAutoFollowUp: false, followUpDelay: 3, followUpDelayHours: 72, maxFollowUps: 3,
    followUpSteps: [], channelFollowUps: {}, enableTracking: true, personalizeMessages: true,
    sendTimeOptimization: true, dailyEmailLimit: 200, autoTicketDedupWindowMinutes: 30,
    blockOnZeroCredit: false, slackWebhookUrl: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

const validateTemplate = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({});
jest.unstable_mockModule('../services/followUpTemplateService.js', () => ({ loadFollowUpTemplate: validateTemplate, FollowUpTemplateError: class extends Error {} }));
class BrandContextFailure extends Error { constructor(public readonly code: string, message: string, public readonly status: number) { super(message); } }
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({ ContentBrandContextError: BrandContextFailure }));

// Mock ALL dependencies
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../models/leadSettings/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getLeadSettingsByUserId: jest.fn<any>().mockResolvedValue({ id: 1 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upsertLeadSettings: jest.fn<any>().mockResolvedValue({ id: 1 }),
}));
jest.unstable_mockModule('../models/outreachSettings/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOutreachSettingsByUserId: jest.fn<any>().mockResolvedValue({ id: 1 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upsertOutreachSettings: jest.fn<any>().mockResolvedValue({ id: 1 }),
  saveChannelFollowUpSettings: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ id: 1 }),
}));
jest.unstable_mockModule('../models/userPreferences/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getUserPreferencesByUserId: jest.fn<any>().mockResolvedValue({ id: 1 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upsertUserPreferences: jest.fn<any>().mockResolvedValue({ id: 1 }),
}));
const updateTimezone = jest.fn<(value: unknown) => unknown>().mockImplementation(() => ({ where: async () => undefined }));
const preferenceTransaction = { update: () => ({ set: updateTimezone }), insert: () => undefined };
jest.unstable_mockModule('../models/db', () => ({ db: {
  transaction: async (work: (tx: typeof preferenceTransaction) => Promise<unknown>) => work(preferenceTransaction),
} }));
// settingsController uses "import type" for schema references but needs these at runtime
jest.unstable_mockModule('../models/users/schema', () => ({
  usersTable: { id: 'id', email: 'email', name: 'name' },
}));

const { mockAuthRequest, mockRequest, mockResponse } = await import('./helpers/mockHelpers');
const settingsController = await import('../controllers/settingsController');
const outreachFunctions = await import('../models/outreachSettings/functions');
const preferencesFunctions = await import('../models/userPreferences/functions');

describe('Settings Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('getLeadSettings', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest();
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await settingsController.getLeadSettings(req as any, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });

    it('should return settings for authenticated user', async () => {
      const req = mockAuthRequest(1);
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await settingsController.getLeadSettings(req as any, res);
      expect(res._status).toBe(200);
    });
  });

  describe('updateLeadSettings', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await settingsController.updateLeadSettings(req as any, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('getOutreachSettings', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest();
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await settingsController.getOutreachSettings(req as any, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });

    it('never returns webhook URLs or obsolete settings', async () => {
      jest.mocked(outreachFunctions.getOutreachSettingsByUserId).mockResolvedValueOnce({
        id: 1,
        userId: 1,
        slackWebhookUrl: 'https://hooks.example.test/secret',
        obsoleteSettings: { accessToken: 'secret' },
      } as unknown as Awaited<ReturnType<typeof outreachFunctions.getOutreachSettingsByUserId>>);
      const req = mockAuthRequest(1);
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await settingsController.getOutreachSettings(req as any, res);
      expect(JSON.stringify(res._json)).not.toContain('hooks.example.test');
      expect(JSON.stringify(res._json)).not.toContain('accessToken');
      expect(res._json.settings.slackWebhookConfigured).toBe(true);
    });
  });

  describe('updateOutreachSettings', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await settingsController.updateOutreachSettings(req as any, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });

    it('whitelists updates and does not pass arbitrary or obsolete fields to storage', async () => {
      const req = mockAuthRequest(1, { body: {
        senderName: 'Sales Team',
        obsoleteSettings: { accessToken: 'secret' },
        arbitraryAdminFlag: true,
      } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await settingsController.updateOutreachSettings(req as any, res);
      expect(res._status).toBe(200);
      expect(jest.mocked(outreachFunctions.upsertOutreachSettings)).toHaveBeenCalledWith(1, {
        senderName: 'Sales Team',
      });
    });
  });

  describe('getUserPreferences', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest();
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await settingsController.getUserPreferences(req as any, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });

    it('should return preferences for authenticated user', async () => {
      const req = mockAuthRequest(1);
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await settingsController.getUserPreferences(req as any, res);
      expect(res._status).toBe(200);
    });
  });

  describe('updateUserPreferences', () => {
    it('should fail for unauthenticated request', async () => {
      const req = mockRequest({ body: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await settingsController.updateUserPreferences(req as any, res);
      expect(res._status).toBeGreaterThanOrEqual(400);
    });

    it('rejects invalid locale, currency, or theme values', async () => {
      const req = mockAuthRequest(1, { body: {
        language: 'en',
        locale: 'not-a-locale',
        currency: 'bitcoin',
        theme: 'midnight',
        timezone: 'UTC',
        dateFormat: 'YYYY-MM-DD',
        timeFormat: '24h',
      } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await settingsController.updateUserPreferences(req as any, res);
      expect(res._status).toBe(400);
    });

    it('canonicalizes Indian timezone aliases and keeps the user profile in sync', async () => {
      const req = mockAuthRequest(1, { body: {
        language: 'en',
        locale: 'en-US',
        currency: 'INR',
        theme: 'system',
        timezone: 'India/Kolkata',
        dateFormat: 'DD/MM/YYYY',
        timeFormat: '12h',
      } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await settingsController.updateUserPreferences(req as any, res);
      expect(res._status).toBe(200);
      expect(jest.mocked(preferencesFunctions.upsertUserPreferences)).toHaveBeenCalledWith(1, expect.objectContaining({ timezone: 'Asia/Kolkata' }), preferenceTransaction);
      expect(updateTimezone).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'Asia/Kolkata' }));
    });
  });

  describe('integration follow-up settings', () => {
    beforeEach(() => {
      jest.mocked(outreachFunctions.getOutreachSettingsByUserId).mockReset().mockResolvedValue(outreachRow());
      jest.mocked(outreachFunctions.saveChannelFollowUpSettings).mockReset().mockImplementation(async (userId, key, config) => ({
        ...outreachRow(), userId, enableAutoFollowUp: config.enabled, channelFollowUps: { [key]: config },
        followUpFenceAdvanced: true,
      }));
    });
    it.each(['email', 'whatsapp', 'instagram', 'facebook', 'sms'] as const)('round-trips 1 hour and 1 day without replacing units for %s', async integrationKey => {
      const req = mockAuthRequest(1, { params: { integrationKey }, body: {
        enableAutoFollowUp: true,
        followUpSteps: [
          { id: 1, delayValue: 1, delayUnit: 'hours', delayHours: 24, templateId: -1 },
          { id: 2, delayValue: 1, delayUnit: 'days', templateId: -1 },
        ],
      } });
      const savedResponse = mockResponse();
      await settingsController.updateIntegrationFollowUpSettings(req as AuthenticatedRequest, savedResponse);
      expect(savedResponse._status).toBe(200);
      const config = jest.mocked(outreachFunctions.saveChannelFollowUpSettings).mock.calls[0][2];
      const saved: OutreachSettings = { ...outreachRow(), enableAutoFollowUp: true, channelFollowUps: { [integrationKey]: config } };
      expect(config.followUps).toEqual([
        expect.objectContaining({ delayDays: 0, delayHours: 1, delayMinutes: 0 }),
        expect.objectContaining({ delayDays: 1, delayHours: 0, delayMinutes: 0 }),
      ]);
      jest.mocked(outreachFunctions.getOutreachSettingsByUserId).mockResolvedValueOnce(saved);
      const loadedResponse = mockResponse();
      await settingsController.getIntegrationFollowUpSettings(mockAuthRequest(1, { params: { integrationKey } }) as AuthenticatedRequest, loadedResponse);
      expect(loadedResponse._json.followUpSteps).toEqual([
        expect.objectContaining({ delayValue: 1, delayUnit: 'hours', delayHours: 1 }),
        expect.objectContaining({ delayValue: 1, delayUnit: 'days', delayHours: 24 }),
      ]);
    });

    it.each(['email', 'whatsapp', 'instagram', 'facebook', 'sms'] as const)('preserves a combined period when viewed and saved for %s', async integrationKey => {
      const settings = { enableAutoFollowUp: true, channelFollowUps: { [integrationKey]: { enabled: true, maxFollowUps: 1,
        followUps: [{ id: '1', delayDays: 1, delayHours: 1, delayMinutes: 30, enabled: true }],
      } } };
      jest.mocked(outreachFunctions.getOutreachSettingsByUserId).mockResolvedValueOnce(settings as unknown as OutreachSettings);
      const loadedResponse = mockResponse();
      await settingsController.getIntegrationFollowUpSettings(mockAuthRequest(1, { params: { integrationKey } }) as AuthenticatedRequest, loadedResponse);
      expect(loadedResponse._json.followUpSteps[0]).toMatchObject({ delayValue: 1530, delayUnit: 'minutes', delayHours: 25.5 });
      jest.mocked(outreachFunctions.getOutreachSettingsByUserId).mockResolvedValueOnce(settings as unknown as OutreachSettings);
      const savedResponse = mockResponse();
      await settingsController.updateIntegrationFollowUpSettings(mockAuthRequest(1, { params: { integrationKey }, body: loadedResponse._json }) as AuthenticatedRequest, savedResponse);
      expect(savedResponse._status).toBe(200);
      expect((jest.mocked(outreachFunctions.saveChannelFollowUpSettings).mock.calls[0][2] as { followUps: unknown[] }).followUps[0])
        .toMatchObject({ delayDays: 1, delayHours: 1, delayMinutes: 30 });
    });

    it.each([
      { delayDays: 1, delayHours: 2, delayMinutes: 15, delayValue: 1575, delayUnit: 'minutes' },
      { delayDays: 0, delayHours: 1 / 60, delayMinutes: 0, delayValue: 1, delayUnit: 'minutes' },
      { delayDays: 1, delayHours: 2, delayMinutes: 0, delayValue: 26, delayUnit: 'hours' },
    ])('round-trips legacy combined/fractional timing without losing units: $delayValue $delayUnit', async sample => {
      jest.mocked(outreachFunctions.getOutreachSettingsByUserId).mockResolvedValueOnce({
        enableAutoFollowUp: false, channelFollowUps: { email: { enabled: false, maxFollowUps: 1,
          followUps: [{ id: '1', enabled: true, ...sample }] } },
      } as unknown as OutreachSettings);
      const res = mockResponse();
      await settingsController.getIntegrationFollowUpSettings(mockAuthRequest(1, { params: { integrationKey: 'email' } }) as AuthenticatedRequest, res);
      expect(res._json.followUpSteps[0]).toMatchObject({ delayValue: sample.delayValue, delayUnit: sample.delayUnit });
      const saved = mockResponse();
      await settingsController.updateIntegrationFollowUpSettings(mockAuthRequest(1, { params: { integrationKey: 'email' }, body: res._json }) as AuthenticatedRequest, saved);
      expect(saved._status).toBe(200);
      expect(saved._json.followUpSteps[0].delayHours).toBe(res._json.followUpSteps[0].delayHours);
    });

    it('keeps an unconfigured channel follow-up schedule inactive', async () => {
      jest.mocked(outreachFunctions.getOutreachSettingsByUserId).mockResolvedValueOnce(undefined);
      const req = mockAuthRequest(1, { params: { integrationKey: 'instagram' } });
      const res = mockResponse();

      await settingsController.getIntegrationFollowUpSettings(req as AuthenticatedRequest, res);

      expect(res._status).toBe(200);
      expect(res._json.enableAutoFollowUp).toBe(false);
      expect(res._json.followUpSteps).toHaveLength(3);
    });

    it('reports a channel schedule active only when both scheduler gates and an enabled step are present', async () => {
      jest.mocked(outreachFunctions.getOutreachSettingsByUserId).mockResolvedValueOnce({
        id: 1,
        enableAutoFollowUp: true,
        channelFollowUps: {
          instagram: {
            enabled: true,
            maxFollowUps: 1,
            followUps: [{ id: '1', delayDays: 2, delayHours: 0, delayMinutes: 0, enabled: true, templateId: null, templateName: '' }],
          },
        },
      } as unknown as Awaited<ReturnType<typeof outreachFunctions.getOutreachSettingsByUserId>>);
      const req = mockAuthRequest(1, { params: { integrationKey: 'instagram' } });
      const res = mockResponse();

      await settingsController.getIntegrationFollowUpSettings(req as AuthenticatedRequest, res);

      expect(res._json.enableAutoFollowUp).toBe(true);
      expect(res._json.followUpSteps[0]).toMatchObject({ delayValue: 2, delayUnit: 'days' });
    });

    it('keeps a configured channel inactive when the global scheduler gate is disabled', async () => {
      jest.mocked(outreachFunctions.getOutreachSettingsByUserId).mockResolvedValueOnce({
        id: 1,
        enableAutoFollowUp: false,
        channelFollowUps: {
          whatsapp: {
            enabled: true,
            maxFollowUps: 1,
            followUps: [{ id: '1', delayDays: 1, delayHours: 0, delayMinutes: 0, enabled: true }],
          },
        },
      } as unknown as Awaited<ReturnType<typeof outreachFunctions.getOutreachSettingsByUserId>>);
      const req = mockAuthRequest(1, { params: { integrationKey: 'whatsapp' } });
      const res = mockResponse();

      await settingsController.getIntegrationFollowUpSettings(req as AuthenticatedRequest, res);

      expect(res._json.enableAutoFollowUp).toBe(false);
    });

    it('keeps the UI toggle inactive when the channel has no enabled step', async () => {
      jest.mocked(outreachFunctions.getOutreachSettingsByUserId).mockResolvedValueOnce({
        id: 1,
        enableAutoFollowUp: true,
        channelFollowUps: {
          email: {
            enabled: true,
            maxFollowUps: 1,
            followUps: [{ id: '1', delayDays: 1, delayHours: 0, delayMinutes: 0, enabled: false }],
          },
        },
      } as unknown as Awaited<ReturnType<typeof outreachFunctions.getOutreachSettingsByUserId>>);
      const req = mockAuthRequest(1, { params: { integrationKey: 'email' } });
      const res = mockResponse();

      await settingsController.getIntegrationFollowUpSettings(req as AuthenticatedRequest, res);

      expect(res._json.enableAutoFollowUp).toBe(false);
    });

    it('persists channel-specific delay steps and recalculates the global scheduler gate', async () => {
      jest.mocked(outreachFunctions.getOutreachSettingsByUserId).mockResolvedValueOnce(undefined);
      const req = mockAuthRequest(1, {
        params: { integrationKey: 'whatsapp' },
        body: {
          enableAutoFollowUp: true,
          followUpSteps: [{ id: 1, delayValue: 2, delayUnit: 'days', templateId: null, templateName: '' }],
        },
      });
      const res = mockResponse();

      await settingsController.updateIntegrationFollowUpSettings(req as AuthenticatedRequest, res);

      expect(res._status).toBe(200);
      expect(jest.mocked(outreachFunctions.saveChannelFollowUpSettings)).toHaveBeenCalledWith(1, 'whatsapp', {
            enabled: true,
            maxFollowUps: 1,
            followUps: [{
              id: '1', delayDays: 2, delayHours: 0, delayMinutes: 0,
              enabled: true, templateId: null, templateName: '',
            }],
      }, undefined);
    });

    it.each(['internal-admin', 'linkedin', 'twitter'])('rejects unsupported integration key %s', async (integrationKey) => {
      const req = mockAuthRequest(1, {
        params: { integrationKey },
        body: { enableAutoFollowUp: true, followUpSteps: [] },
      });
      const res = mockResponse();
      await settingsController.updateIntegrationFollowUpSettings(req as AuthenticatedRequest, res);
      expect(res._status).toBe(400);
    });

    it('validates selected templates before enabling a schedule', async () => {
      const req = mockAuthRequest(1, { params: { integrationKey: 'email' }, body: {
        enableAutoFollowUp: true,
        followUpSteps: [{ id: 1, delayValue: 1, delayUnit: 'days', templateId: 44 }],
      } });
      const res = mockResponse();
      await settingsController.updateIntegrationFollowUpSettings(req as AuthenticatedRequest, res);
      expect(validateTemplate).toHaveBeenCalledWith(1, 'email', 44);
      expect(res._status).toBe(200);
    });

    it('patches only the requested channel rather than writing a stale whole-settings snapshot', async () => {
      const req = mockAuthRequest(1, { params: { integrationKey: 'email' }, body: { enableAutoFollowUp: false, followUpSteps: [{ id: 1, delayValue: 1, delayUnit: 'days' }] } });
      await settingsController.updateIntegrationFollowUpSettings(req as AuthenticatedRequest, mockResponse());
      expect(outreachFunctions.saveChannelFollowUpSettings).toHaveBeenCalledWith(1, 'email', expect.objectContaining({ enabled: false }), undefined);
      expect(outreachFunctions.upsertOutreachSettings).not.toHaveBeenCalled();
    });

    it.each([
      [{ id: 1, delayValue: 1, delayUnit: 'days' }, { id: 1, delayValue: 2, delayUnit: 'days' }],
      [{ id: 1, delayValue: 1.5, delayUnit: 'hours' }],
      [{ id: 1, delayValue: 366, delayUnit: 'days' }],
      [{ id: 1, delayValue: 1, delayUnit: 'minutes', templateId: Number.MAX_SAFE_INTEGER + 1 }],
    ])('rejects ambiguous IDs, fractional inputs, excessive delays and unsafe template IDs', async (...steps) => {
      const res = mockResponse();
      await settingsController.updateIntegrationFollowUpSettings(mockAuthRequest(1, { params: { integrationKey: 'email' }, body: { enableAutoFollowUp: false, followUpSteps: steps } }) as AuthenticatedRequest, res);
      expect(res._status).toBe(400);
      expect(outreachFunctions.saveChannelFollowUpSettings).not.toHaveBeenCalled();
    });

    it('returns a recoverable conflict and does not report stale saves as successful', async () => {
      jest.mocked(outreachFunctions.saveChannelFollowUpSettings).mockRejectedValueOnce(new FollowUpSettingsConflictError());
      const res = mockResponse();
      await settingsController.updateIntegrationFollowUpSettings(mockAuthRequest(1, { params: { integrationKey: 'email' }, body: { enableAutoFollowUp: false, expectedRevision: 'a'.repeat(64), followUpSteps: [{ id: 1, delayValue: 1, delayUnit: 'minutes' }] } }) as AuthenticatedRequest, res);
      expect(res._status).toBe(409);
      expect(res._json.code).toBe('FOLLOW_UP_SETTINGS_CONFLICT');
      expect(res._json).not.toHaveProperty('success');
    });

    it('preserves brand approval configuration codes/status and never saves an invalid enabled template', async () => {
      validateTemplate.mockRejectedValueOnce(new BrandContextFailure('BUSINESS_PROFILE_NOT_APPROVED', 'Approve the selected business profile before generating content.', 409));
      const res = mockResponse();
      await settingsController.updateIntegrationFollowUpSettings(mockAuthRequest(1, { params: { integrationKey: 'email' }, body: { enableAutoFollowUp: true, followUpSteps: [{ id: 1, delayValue: 1, delayUnit: 'hours', templateId: 77 }] } }) as AuthenticatedRequest, res);
      expect(res._status).toBe(409);
      expect(res._json.code).toBe('BUSINESS_PROFILE_NOT_APPROVED');
      expect(outreachFunctions.saveChannelFollowUpSettings).not.toHaveBeenCalled();
    });

    it('rejects follow-up steps that are not sequential', async () => {
      const req = mockAuthRequest(1, {
        params: { integrationKey: 'email' },
        body: {
          enableAutoFollowUp: true,
          followUpSteps: [
            { id: 1, delayValue: 2, delayUnit: 'days' },
            { id: 2, delayValue: 1, delayUnit: 'days' },
          ],
        },
      });
      const res = mockResponse();
      await settingsController.updateIntegrationFollowUpSettings(req as AuthenticatedRequest, res);
      expect(res._status).toBe(400);
    });
  });
});
