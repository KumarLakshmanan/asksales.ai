import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

const list = jest.fn<any>();
const get = jest.fn<any>();
const create = jest.fn<any>();
const update = jest.fn<any>();
const remove = jest.fn<any>();
const audit = jest.fn<any>();
const validation = jest.fn<any>();
const probe = jest.fn<any>();
jest.unstable_mockModule('../models/intentClassifierCredentials/functions.js', () => ({
  CLASSIFIER_PLATFORMS: ['openrouter', 'openai', 'gemini', 'vertex_ai', 'custom_ai'],
  listClassifierCredentials: list, getClassifierCredential: get, createClassifierCredential: create,
  updateClassifierCredential: update, deleteClassifierCredential: remove,
  recordClassifierAudit: audit, recordClassifierValidation: validation, listClassifierAudit: jest.fn(),
}));
jest.unstable_mockModule('../services/agents/intent/IntentClassifierService.js', () => ({ probeClassifierCredential: probe }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const controller = await import('../controllers/adminIntentClassifierIntegrationsController.js');
const { mockAuthRequest, mockResponse } = await import('./helpers/mockHelpers.js');
const row = { id: 7, platform: 'openrouter', name: 'Jev primary', apiKey: 'secret-key', apiSecret: null,
  isActive: true, priority: 'high', config: { model: 'typesafe/jev-1.13' }, usageCount: 3 };

beforeEach(() => {
  jest.clearAllMocks();
  list.mockResolvedValue([row]); get.mockResolvedValue(row); create.mockResolvedValue(row);
  update.mockImplementation(async (_id: number, input: any) => ({ ...row, ...input }));
  remove.mockResolvedValue(true); audit.mockResolvedValue(undefined); validation.mockResolvedValue(undefined);
  probe.mockResolvedValue(true);
});

describe('classifier integration API', () => {
  it('restricts every classifier route to super admins and removes global settings API', () => {
    const routes = readFileSync(new URL('../routes/admin.routes.ts', import.meta.url), 'utf8');
    for (const line of routes.split('\n').filter(value => value.includes("router.") && value.includes("'/intent-classifier-integrations"))) {
      expect(line).toContain('requireSuperAdmin');
    }
    expect(routes).not.toContain("router.get('/ai-settings'");
    expect(routes).not.toContain("router.put('/ai-settings'");
  });
  it('returns masked classifier credentials with usage, priority and active status', async () => {
    const res = mockResponse();
    await controller.listClassifierIntegrations(mockAuthRequest(1) as any, res);
    expect(res._json.credentials[0]).toMatchObject({ priority: 'high', isActive: true, usageCount: 3 });
    expect(JSON.stringify(res._json)).not.toContain('secret-key');
  });
  it('creates an independent OpenRouter Jev credential and audits the change', async () => {
    const res = mockResponse();
    await controller.createClassifierIntegration(mockAuthRequest(9, { body: {
      platform: 'openrouter', name: 'Jev primary', apiKey: 'secret-key', priority: 'high',
      config: { model: 'typesafe/jev-1.13' }, isActive: true,
    } }) as any, res);
    expect(res._status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ platform: 'openrouter', priority: 'high', config: { model: 'typesafe/jev-1.13' } }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', credentialId: 7, adminId: 9 }));
  });
  it('rejects Jev under another provider and missing models', async () => {
    for (const config of [{ model: 'typesafe/jev-1.13' }, {}]) {
      const res = mockResponse();
      await controller.createClassifierIntegration(mockAuthRequest(9, { body: {
        platform: 'openai', name: 'bad', apiKey: 'secret-key', config,
      } }) as any, res);
      expect(res._status).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();
  });
  it('updates priority, toggles active state, and preserves audit history on deletion', async () => {
    const updateRes = mockResponse();
    await controller.updateClassifierIntegration(mockAuthRequest(9, { params: { id: '7' }, body: { priority: 'fallback' } }) as any, updateRes);
    expect(update).toHaveBeenCalledWith(7, expect.objectContaining({ priority: 'fallback' }));
    await controller.toggleClassifierIntegration(mockAuthRequest(9, { params: { id: '7' } }) as any, mockResponse());
    expect(update).toHaveBeenCalledWith(7, { isActive: false });
    await controller.deleteClassifierIntegration(mockAuthRequest(9, { params: { id: '7' } }) as any, mockResponse());
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete', credentialId: 7 }));
    expect(remove).toHaveBeenCalledWith(7);
  });
  it('tests the actual classifier contract and saves validation state', async () => {
    const res = mockResponse();
    await controller.testClassifierIntegration(mockAuthRequest(9, { params: { id: '7' } }) as any, res);
    expect(probe).toHaveBeenCalledWith(row);
    expect(validation).toHaveBeenCalledWith(expect.objectContaining({ id: 7, success: true }));
    expect(res._json.test.success).toBe(true);
  });
});
