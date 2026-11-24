import type { Request, Response } from 'express';
import { CLASSIFIER_PLATFORMS, createClassifierCredential, deleteClassifierCredential,
  getClassifierCredential, listClassifierAudit, listClassifierCredentials, recordClassifierAudit,
  recordClassifierValidation, updateClassifierCredential } from '../models/intentClassifierCredentials/functions.js';
import type { IntentClassifierCredential } from '../models/intentClassifierCredentials/schema.js';
import { parseCredentialId, parseIntegrationCredentialInput, validateIntegrationRequirements } from '../utils/integrationCredentialValidation.js';
import { maskSensitiveIntegrationConfig, mergeIntegrationCredentialConfig } from './adminIntegrationsNewController.js';
import { probeClassifierCredential } from '../services/agents/intent/IntentClassifierService.js';
import { logger } from '../utils/logger.js';
import { JEV_MODEL } from '../services/agents/intent/intentClassifierConfig.js';
import type { AdminApiPlatform } from '../models/adminApiCredentials/functions.js';
import { adminActorIdOrNull as actor } from '../utils/requestUserIds.js';

const platforms = new Set<string>(CLASSIFIER_PLATFORMS);
const modelPattern = /^[\w./:+-]{1,200}$/;
function masked(credential: IntentClassifierCredential) {
  return { ...credential, apiKey: credential.platform === 'vertex_ai' ? 'service-account:••••••••' : '••••••••',
    apiSecret: credential.apiSecret ? '••••••••' : null,
    config: maskSensitiveIntegrationConfig(credential.config) };
}
function validateModel(platform: string, config: Record<string, unknown>): void {
  const model = config.model;
  if (typeof model !== 'string' || !modelPattern.test(model)) throw new Error('A valid classifier model is required');
  if (model === JEV_MODEL && platform !== 'openrouter') throw new Error('Jev is available only through OpenRouter');
  if (platform === 'openrouter' && !model.includes('/')) throw new Error('OpenRouter model must include a provider prefix');
  if (platform === 'gemini' || platform === 'vertex_ai') {
    if (!/^(gemini|gemma)-/.test(model)) throw new Error('Gemini model must start with gemini- or gemma-');
  }
  if (platform === 'openai' && model.includes('/')) throw new Error('OpenAI model must not have a provider prefix');
}
function parseInput(body: unknown, update = false) {
  const input = parseIntegrationCredentialInput(body, update);
  if (input.platform && !platforms.has(input.platform)) throw new Error('Unsupported classifier provider');
  return input;
}
function invalid(res: Response, error: unknown) {
  if (error instanceof Error && /required|must|invalid|unsupported|Jev|classifier|model/i.test(error.message)) {
    return res.status(400).json({ error: error.message });
  }
  logger.error({ err: error }, '[ClassifierIntegrations] Request failed');
  return res.status(500).json({ error: 'Unable to manage classifier integration.' });
}

export async function listClassifierIntegrations(_req: Request, res: Response) {
  try { return res.json({ success: true, credentials: (await listClassifierCredentials()).map(masked) }); }
  catch (error) { return invalid(res, error); }
}
export async function getClassifierIntegration(req: Request, res: Response) {
  const id = parseCredentialId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid integration ID' });
  try {
    const credential = await getClassifierCredential(id);
    return credential ? res.json({ success: true, credential: masked(credential) }) : res.status(404).json({ error: 'Classifier integration not found' });
  } catch (error) { return invalid(res, error); }
}
export async function createClassifierIntegration(req: Request, res: Response) {
  try {
    const input = parseInput(req.body);
    validateModel(input.platform!, input.config || {});
    validateIntegrationRequirements(input);
    const credential = await createClassifierCredential({ platform: input.platform!, name: input.name!, apiKey: input.apiKey!,
      apiSecret: input.apiSecret || null, priority: input.priority || 'normal', isActive: input.isActive ?? true, config: input.config || {} });
    await recordClassifierAudit({ credentialId: credential.id, platform: credential.platform, action: 'create', adminId: actor(req),
      changedFields: ['name', 'apiKey', 'priority', 'isActive', 'config'] });
    return res.status(201).json({ success: true, credential: masked(credential) });
  } catch (error) { return invalid(res, error); }
}
export async function updateClassifierIntegration(req: Request, res: Response) {
  const id = parseCredentialId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid integration ID' });
  try {
    const existing = await getClassifierCredential(id);
    if (!existing) return res.status(404).json({ error: 'Classifier integration not found' });
    const input = parseInput(req.body, true);
    if (input.platform && input.platform !== existing.platform) return res.status(409).json({ error: 'Integration provider is immutable' });
    const config = input.config ? mergeIntegrationCredentialConfig(existing.config, input.config) : existing.config;
    validateModel(existing.platform, config);
    validateIntegrationRequirements({ ...input, platform: existing.platform as AdminApiPlatform, config }, existing as Parameters<typeof validateIntegrationRequirements>[1]);
    const { platform: _platform, ...changes } = input;
    const credential = await updateClassifierCredential(id, { ...changes,
      ...(input.config ? { config } : {}),
      ...((input.apiKey || input.apiSecret !== undefined || input.config) ? {
        validationStatus: null, validationMessage: null, lastValidatedAt: null,
      } : {}),
    });
    if (!credential) return res.status(404).json({ error: 'Classifier integration not found' });
    await recordClassifierAudit({ credentialId: id, platform: existing.platform, action: input.apiKey ? 'rotate' : 'update',
      adminId: actor(req), changedFields: Object.keys(input).filter(field => field !== 'platform') });
    return res.json({ success: true, credential: masked(credential) });
  } catch (error) { return invalid(res, error); }
}
export async function toggleClassifierIntegration(req: Request, res: Response) {
  const id = parseCredentialId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid integration ID' });
  try {
    const existing = await getClassifierCredential(id);
    if (!existing) return res.status(404).json({ error: 'Classifier integration not found' });
    const updated = await updateClassifierCredential(id, { isActive: !existing.isActive });
    await recordClassifierAudit({ credentialId: id, platform: existing.platform,
      action: updated?.isActive ? 'activate' : 'deactivate', adminId: actor(req), changedFields: ['isActive'] });
    return res.json({ success: true, isActive: updated?.isActive });
  } catch (error) { return invalid(res, error); }
}
export async function deleteClassifierIntegration(req: Request, res: Response) {
  const id = parseCredentialId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid integration ID' });
  try {
    const existing = await getClassifierCredential(id);
    if (!existing) return res.status(404).json({ error: 'Classifier integration not found' });
    await recordClassifierAudit({ credentialId: id, platform: existing.platform, action: 'delete', adminId: actor(req) });
    await deleteClassifierCredential(id);
    return res.json({ success: true });
  } catch (error) { return invalid(res, error); }
}
export async function testClassifierIntegration(req: Request, res: Response) {
  const id = parseCredentialId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid integration ID' });
  try {
    const credential = await getClassifierCredential(id);
    if (!credential) return res.status(404).json({ error: 'Classifier integration not found' });
    let success = false;
    try { success = await probeClassifierCredential(credential); } catch { /* no provider error or secret in response */ }
    const message = success ? 'Classifier responded with a valid decision' : 'Classifier connection or decision contract failed';
    await recordClassifierValidation({ id, platform: credential.platform, adminId: actor(req), success, message });
    return res.json({ success: true, test: { success, message } });
  } catch (error) { return invalid(res, error); }
}
export async function getClassifierAudit(req: Request, res: Response) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    return res.json({ success: true, entries: await listClassifierAudit(limit) });
  } catch (error) { return invalid(res, error); }
}
