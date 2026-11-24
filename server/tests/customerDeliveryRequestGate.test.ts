/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';
import type { Request, Response } from 'express';

const execute = jest.fn<(...args: any[]) => Promise<any>>();
const emailSend = jest.fn<(...args: any[]) => Promise<any>>();
const gmailSend = jest.fn<(...args: any[]) => Promise<any>>();
const gmailBulk = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../models/emailSenders/functions.js', () => ({ getDefault: async () => ({ id: 12, email: 'sales@example.test', isVerified: true }), getById: async () => ({ id: 12, email: 'sales@example.test', isVerified: true }) }));
jest.unstable_mockModule('../services/assistants/AssistantCatalogService.js', () => ({ assistantCatalog: async () => ({}), assistantPlatformReadiness: async () => ({}) }));
jest.unstable_mockModule('../services/emailService.js', () => ({ emailService: { sendPersonalizedEmail: emailSend } }));
jest.unstable_mockModule('../services/gmailApiService.js', () => ({ gmailApiService: { getUserEmail: async () => 'sales@example.test', sendPersonalizedEmail: gmailSend, sendBulkEmails: gmailBulk } }));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() } }));
const email = await import('../controllers/emailOutreachController.js');
const gmail = await import('../controllers/gmailOutreachController.js');
const oldFlag = process.env.SUPPORT_ASSISTANTS_ENABLED;
const oldProfiles = process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
beforeEach(() => { jest.clearAllMocks(); execute.mockReset().mockResolvedValue({ rows: [] }); delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES; });
afterEach(() => {
  if (oldFlag === undefined) delete process.env.SUPPORT_ASSISTANTS_ENABLED; else process.env.SUPPORT_ASSISTANTS_ENABLED = oldFlag;
  if (oldProfiles === undefined) delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES; else process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES = oldProfiles;
});
describe('legacy HTTP sends fail before personalization, provider or batch mutation', () => {
  for (const [name, handler] of [['email', email.sendEmailToLead], ['email bulk', email.sendBulkEmails], ['Gmail', gmail.sendEmailToLead], ['Gmail bulk', gmail.sendBulkEmails]] as const) {
    it.each(['runtime_disabled', 'assignment_required', 'draft', 'paused'])(`${name}: %s`, async reason => {
      process.env.SUPPORT_ASSISTANTS_ENABLED = reason === 'runtime_disabled' ? 'false' : 'true';
      if (reason === 'draft' || reason === 'paused') execute.mockResolvedValue({ rows: [{ assistant_id: '11111111-1111-4111-8111-111111111111', enabled: true, state: reason, published_revision: reason === 'draft' ? null : 3, configuration: {} }] });
      const res = { status: jest.fn(), json: jest.fn() };
      res.status.mockReturnValue(res); res.json.mockImplementation(value => value);
      const req = { user: { id: 9 }, params: { leadId: '21' }, body: { leadIds: [21, 22], subject: 'Mock only', body: 'Reviewed original campaign' } };
      await withBusinessScope({ userId: 9, businessProfileId: 7 }, () => handler(req as unknown as Request, res as unknown as Response));
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'ASSISTANT_SETUP_REQUIRED', reason: ['draft','paused'].includes(reason) ? 'assistant_not_live' : reason, setupUrl: expect.stringContaining('/dashboard/settings/outreach'), deliveryAttempted: false, outcomeUncertain: false, retryable: false }));
      expect(emailSend).not.toHaveBeenCalled(); expect(gmailSend).not.toHaveBeenCalled(); expect(gmailBulk).not.toHaveBeenCalled();
      if (reason === 'runtime_disabled') expect(execute).not.toHaveBeenCalled();
    });
  }
});
