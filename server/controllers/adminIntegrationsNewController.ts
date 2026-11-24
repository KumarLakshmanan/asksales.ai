import { assertBillingCredentialMutation, normalizeBillingCredentialError } from '../services/subscriptions/credentialPolicy.js';
import { testEmbeddingCredential } from '../services/embeddings/testEmbeddingCredential.js';
/**
 * Admin Integrations Controller
 * Manages admin-level API credentials for system-wide integrations
 * (OpenAI, OpenRouter, Apify, Gemini, ZeroBounce, SMTP)
 */

import { Request, Response } from "express";
import { LLMProviderFactory } from '../services/agents/LLMProviderFactory.js';
import { VertexAIProvider } from '../services/agents/VertexAIProvider.js';
import { DEFAULT_VERTEX_MODEL } from '../utils/llmConstants.js';
import {
  getAdminCredentialsByPlatform,
  getActiveAdminCredential,
  getAllAdminCredentials,
  createAdminCredential,
  updateAdminCredential,
  deleteAdminCredential,
  toggleAdminCredential,
  getAdminCredentialStats,
  getAdminCredentialById,
  recordAdminCredentialAudit,
  updateAdminCredentialValidation,
  listAdminCredentialAudit,
  AdminApiPlatform,
} from "../models/adminApiCredentials/functions";
import { logger } from '../utils/logger.js';
import { assertPublicHttpUrl, fetchPublicHttpUrl } from '../utils/safeRemoteFetch.js';
import {
  maskSensitiveIntegrationConfig as maskConfigSecrets,
  mergeIntegrationCredentialConfig as mergeCredentialConfig,
  containsSensitiveIntegrationConfig,
} from '../utils/integrationSecrets.js';
import {
  ADMIN_INTEGRATION_PLATFORMS,
  parseCredentialId,
  parseIntegrationCredentialInput,
  validateIntegrationRequirements,
} from '../utils/integrationCredentialValidation.js';
import { adminActorIdOrNull as adminActorId } from '../utils/requestUserIds.js';

let _nodemailer: typeof import('nodemailer') | null = null;
let _resend: typeof import('resend') | null = null;

const VALID_PLATFORMS = ADMIN_INTEGRATION_PLATFORMS;
const RETIRED_INTEGRATION_PLATFORMS = new Set(['perplexity']);
const PROVIDER_TEST_TIMEOUT_MS = 10_000;

function isRetiredIntegrationPlatform(platform: string): boolean {
  return RETIRED_INTEGRATION_PLATFORMS.has(platform);
}

function retiredIntegrationResponse(res: Response) {
  return res.status(410).json({ error: 'This integration provider has been retired.' });
}
export function maskSensitiveIntegrationConfig(value: unknown, key = ''): unknown {
  return maskConfigSecrets(value, key);
}

export function mergeIntegrationCredentialConfig(existing: unknown, incoming: unknown): Record<string, unknown> {
  return mergeCredentialConfig(existing, incoming);
}

function maskCredential<T extends { platform?: string; apiKey: string; apiSecret?: string | null; config?: unknown }>(credential: T) {
  return {
    ...credential,
    apiKey: credential.platform === 'vertex_ai' ? 'service-account:••••••••' : maskApiKey(credential.apiKey),
    apiSecret: credential.apiSecret ? maskApiKey(credential.apiSecret) : null,
    config: maskSensitiveIntegrationConfig(credential.config),
  };
}

function providerFetch(input: string | URL, init: RequestInit = {}): Promise<globalThis.Response> {
  return fetch(input, {
    ...init,
    signal: init.signal || AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
  });
}

/**
 * Get all admin API credentials
 * GET /api/admin/integrations
 */
export async function getAllIntegrations(req: Request, res: Response) {
  try {
    const { platform } = req.query;

    const requestedPlatform = typeof platform === 'string' ? platform : undefined;
    if (platform !== undefined && (!requestedPlatform || !VALID_PLATFORMS.includes(requestedPlatform as AdminApiPlatform))) {
      return res.status(400).json({ error: 'Invalid integration platform' });
    }

    let credentials;
    if (requestedPlatform) {
      credentials = await getAdminCredentialsByPlatform(requestedPlatform as AdminApiPlatform);
    } else {
      credentials = (await getAllAdminCredentials())
        .filter((credential) => VALID_PLATFORMS.includes(credential.platform as AdminApiPlatform));
    }
    
    const maskedCredentials = credentials.map(maskCredential);
    
    return res.json({
      success: true,
      credentials: maskedCredentials,
    });
  } catch (error) {
    logger.error({ err: error }, '[getAllIntegrations] Error');
    return res.status(500).json({ error: "Unable to retrieve integrations. Please try again." });
  }
}

/**
 * Get integration stats summary
 * GET /api/admin/integrations/stats
 */
export async function getIntegrationStats(req: Request, res: Response) {
  try {
    const stats = await getAdminCredentialStats();
    return res.json({
      success: true,
      ...stats,
    });
  } catch (error) {
    logger.error({ err: error }, '[getIntegrationStats] Error');
    return res.status(500).json({ error: "Unable to retrieve integration statistics. Please try again." });
  }
}

export async function getIntegrationAudit(req: Request, res: Response) {
  try {
    const limit = Number(req.query.limit ?? 20);
    const offset = Number(req.query.offset ?? 0);
    const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      return res.status(400).json({ error: 'limit must be 1–100 and offset must be non-negative' });
    }
    if (platform && !VALID_PLATFORMS.includes(platform as AdminApiPlatform)) return res.status(400).json({ error: 'Invalid integration platform' });
    return res.json(await listAdminCredentialAudit({ platform, limit, offset }));
  } catch (error) {
    logger.error({ err: error }, '[getIntegrationAudit] Error');
    return res.status(500).json({ error: 'Unable to retrieve integration credential history.' });
  }
}

/**
 * Get single integration by ID
 * GET /api/admin/integrations/:id
 */
export async function getIntegration(req: Request, res: Response) {
  try {
    const id = parseCredentialId(req.params.id);
    if (!id) return res.status(400).json({ error: 'A valid integration ID is required' });
    const credential = await getAdminCredentialById(id);
    
    if (!credential) {
      return res.status(404).json({ error: "Integration not found" });
    }
    if (isRetiredIntegrationPlatform(credential.platform)) return retiredIntegrationResponse(res);
    
    return res.json({
      success: true,
      credential: maskCredential(credential),
    });
  } catch (error) {
    logger.error({ err: error }, '[getIntegration] Error');
    return res.status(500).json({ error: "Unable to retrieve the integration. Please try again." });
  }
}

/**
 * Get single integration by ID with full API key (for edit mode)
 * GET /api/admin/integrations/:id/full
 */
export async function getIntegrationFull(req: Request, res: Response) {
  try {
    const id = parseCredentialId(req.params.id);
    if (!id) return res.status(400).json({ error: 'A valid integration ID is required' });
    const credential = await getAdminCredentialById(id);
    
    if (!credential) {
      return res.status(404).json({ error: "Integration not found" });
    }
    if (isRetiredIntegrationPlatform(credential.platform)) return retiredIntegrationResponse(res);
    
    // Return masked API key for edit mode (admin only endpoint)
    return res.json({
      success: true,
      credential: maskCredential(credential),
    });
  } catch (error) {
    logger.error({ err: error }, '[getIntegrationFull] Error');
    return res.status(500).json({ error: "Unable to retrieve the full integration details. Please try again." });
  }
}

/**
 * Create new admin API credential
 * POST /api/admin/integrations
 */
export async function createIntegration(req: Request, res: Response) {
  try {
    const input = parseIntegrationCredentialInput(req.body);
    validateIntegrationRequirements(input);
    
    const credential = await createAdminCredential({
      platform: input.platform!,
      name: input.name!,
      apiKey: input.apiKey!,
      apiSecret: input.apiSecret || null,
      priority: input.priority || 'normal',
      config: input.config || {},
      isActive: input.isActive ?? true,
    });
    await recordAdminCredentialAudit({
      credentialId: credential.id,
      platform: credential.platform,
      action: 'create',
      adminId: adminActorId(req),
      changedFields: ['name', 'apiKey', ...(credential.apiSecret ? ['apiSecret'] : []), 'priority', 'config', 'isActive'],
    });
    
    return res.status(201).json({
      success: true,
      message: "Integration created successfully",
      credential: maskCredential(credential),
    });
  } catch (error) {
    if (error instanceof Error && /must|required|invalid|unsupported|between|smaller|at least/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, '[createIntegration] Error');
    return res.status(500).json({ error: "Unable to create the integration. Please try again." });
  }
}

/**
 * Update admin API credential
 * PUT /api/admin/integrations/:id
 */
export async function updateIntegration(req: Request, res: Response) {
  try {
    const id = parseCredentialId(req.params.id);
    if (!id) return res.status(400).json({ error: 'A valid integration ID is required' });
    const input = parseIntegrationCredentialInput(req.body, true);
    const existing = await getAdminCredentialById(id);
    if (!existing) {
      return res.status(404).json({ error: "Integration not found" });
    }
    if (isRetiredIntegrationPlatform(existing.platform)) return retiredIntegrationResponse(res);
    
    if (input.platform && input.platform !== existing.platform) return res.status(409).json({ error: 'Integration platform is immutable' });
    const mergedConfig = input.config === undefined ? (existing.config || {}) : mergeIntegrationCredentialConfig(existing.config, input.config);
    validateIntegrationRequirements({ ...input, config: mergedConfig }, existing as unknown as Parameters<typeof validateIntegrationRequirements>[1]);
    const updateData: Record<string, unknown> = { ...input };
    delete updateData.platform;
    if (input.config !== undefined) updateData.config = mergedConfig;
    const secretRotated = !!input.apiKey || input.apiSecret !== undefined || containsSensitiveIntegrationConfig(input.config);
    if (secretRotated) {
      updateData.rotatedAt = new Date();
      updateData.rotatedBy = adminActorId(req);
      updateData.validationStatus = null;
      updateData.validationMessage = null;
      updateData.lastValidatedAt = null;
    }
    
    await assertBillingCredentialMutation(existing, updateData);
    const updated = await updateAdminCredential(id, updateData);
    // Invalidate LLM provider cache since credentials changed
    LLMProviderFactory.clearCache();
    
    if (!updated) {
      return res.status(500).json({ error: "Unable to update the integration. Please try again." });
    }
    await recordAdminCredentialAudit({
      credentialId: updated.id,
      platform: updated.platform,
      action: secretRotated ? 'rotate' : 'update',
      adminId: adminActorId(req),
      changedFields: Object.keys(input).filter((field) => field !== 'platform'),
    });
    
    return res.json({
      success: true,
      message: "Integration updated successfully",
      credential: maskCredential(updated),
    });
  } catch (error) {
    const billingConflict=normalizeBillingCredentialError(error);
    if(billingConflict) return res.status(409).json({error:billingConflict.message,code:billingConflict.code});
    if (error instanceof Error && /must|required|invalid|unsupported|between|smaller|at least/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, '[updateIntegration] Error');
    return res.status(500).json({ error: "Unable to update the integration. Please try again." });
  }
}

/**
 * Toggle integration active status
 * POST /api/admin/integrations/:id/toggle
 */
export async function toggleIntegration(req: Request, res: Response) {
  try {
    const id = parseCredentialId(req.params.id);
    if (!id) return res.status(400).json({ error: 'A valid integration ID is required' });
    const existing = await getAdminCredentialById(id);
    if (!existing) {
      return res.status(404).json({ error: "Integration not found" });
    }
    if (isRetiredIntegrationPlatform(existing.platform)) return retiredIntegrationResponse(res);
    await assertBillingCredentialMutation(existing, {isActive:!existing.isActive});
    const updated = await toggleAdminCredential(id);
    
    if (!updated) {
      return res.status(404).json({ error: "Integration not found" });
    }
    LLMProviderFactory.clearCache();
    await recordAdminCredentialAudit({
      credentialId: updated.id,
      platform: updated.platform,
      action: updated.isActive ? 'activate' : 'deactivate',
      adminId: adminActorId(req),
      changedFields: ['isActive'],
    });
    
    return res.json({
      success: true,
      message: `Integration ${updated.isActive ? 'activated' : 'deactivated'} successfully`,
      isActive: updated.isActive,
    });
  } catch (error) {
    const billingConflict=normalizeBillingCredentialError(error);
    if(billingConflict) return res.status(409).json({error:billingConflict.message,code:billingConflict.code});
    logger.error({ err: error }, '[toggleIntegration] Error');
    return res.status(500).json({ error: "Unable to toggle the integration status. Please try again." });
  }
}

/**
 * Delete integration
 * DELETE /api/admin/integrations/:id
 */
export async function deleteIntegration(req: Request, res: Response) {
  try {
    const id = parseCredentialId(req.params.id);
    if (!id) return res.status(400).json({ error: 'A valid integration ID is required' });
    const existing = await getAdminCredentialById(id);
    if (!existing) {
      return res.status(404).json({ error: "Integration not found" });
    }
    
    await assertBillingCredentialMutation(existing, {delete:true});
    await recordAdminCredentialAudit({
      credentialId: existing.id,
      platform: existing.platform,
      action: 'delete',
      adminId: adminActorId(req),
      changedFields: [],
    });
    await deleteAdminCredential(id);
    LLMProviderFactory.clearCache();
    
    return res.json({
      success: true,
      message: "Integration deleted successfully",
    });
  } catch (error) {
    const billingConflict=normalizeBillingCredentialError(error);
    if(billingConflict) return res.status(409).json({error:billingConflict.message,code:billingConflict.code});
    logger.error({ err: error }, '[deleteIntegration] Error');
    return res.status(500).json({ error: "Unable to delete the integration. Please try again." });
  }
}

/**
 * Test integration connection
 * POST /api/admin/integrations/:id/test
 */
export async function testIntegration(req: Request, res: Response) {
  try {
    const id = parseCredentialId(req.params.id);
    if (!id) return res.status(400).json({ error: 'A valid integration ID is required' });
    const credential = await getAdminCredentialById(id);
    if (!credential) {
      return res.status(404).json({ error: "Integration not found" });
    }
    if (isRetiredIntegrationPlatform(credential.platform)) return retiredIntegrationResponse(res);
    
    let testResult: { success: boolean; message: string; details?: unknown } = {
      success: false,
      message: "Unknown platform",
    };
    
    switch (credential.platform) {
      case 'openai':
        testResult = await testOpenAI(credential.apiKey);
        break;
      case 'openrouter':
        testResult = await testOpenRouter(credential.apiKey);
        break;
      case 'apify':
        testResult = await testApify(credential.apiKey);
        break;
      case 'gemini':
        testResult = await testGemini(credential.apiKey);
        break;
      case 'vertex_ai':
        testResult = await testVertexAI(credential.apiKey, credential.config);
        break;
      case 'gemini_image':
      case 'gemini_video':
        testResult = await testGemini(credential.apiKey);
        break;
      case 'zerobounce':
        testResult = await testZeroBounce(credential.apiKey);
        break;
      case 'smtp':
        testResult = await testSMTP(credential.apiKey, credential.apiSecret, credential.config);
        break;
      case 'razorpay':
        testResult = await testRazorpay(credential.apiKey, credential.apiSecret);
        break;
      case 'custom_ai':
        testResult = await testCustomAI(credential.apiKey, credential.config);
        break;
      case 'resend':
        testResult = await testResend(credential.apiKey);
        break;
      case 'openai_embedding':
        testResult = await testEmbeddingCredential('openai', credential.apiKey, credential.config);
        break;
      case 'openrouter_embedding':
        testResult = await testEmbeddingCredential('openrouter', credential.apiKey, credential.config);
        break;
      case 'gemini_embedding':
        testResult = await testEmbeddingCredential('gemini', credential.apiKey, credential.config);
        break;
      case 'gmail_oauth':
        testResult = testGmailOAuthConfig(credential.apiKey, credential.apiSecret);
        break;
      case 'meta_app':
        testResult = await testMetaApp(credential.apiKey, credential.apiSecret, credential.config);
        break;
    }
    const validationStatus = credential.platform === 'gmail_oauth' && testResult.success
      ? 'manual_required'
      : testResult.success ? 'valid' : 'invalid';
    await updateAdminCredentialValidation({
      id: credential.id,
      platform: credential.platform,
      adminId: adminActorId(req),
      status: validationStatus,
      message: testResult.message,
    });
    
    return res.json({
      success: true,
      test: testResult,
    });
  } catch (error) {
    logger.error({ err: error }, '[testIntegration] Error');
    return res.status(500).json({ error: "Unable to test the integration. Please try again." });
  }
}

// Test helpers
async function testOpenAI(apiKey: string): Promise<{ success: boolean; message: string; details?: unknown }> {
  try {
    const response = await providerFetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (response.ok) {
      return { success: true, message: "OpenAI API key is valid" };
    }
    const errorData = await response.json() as { error?: { message?: string } };
    return { success: false, message: errorData.error?.message || "Invalid API key", details: errorData };
  } catch (err) {
    return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function testOpenRouter(apiKey: string): Promise<{ success: boolean; message: string; details?: unknown }> {
  try {
    const response = await providerFetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (response.ok) {
      return { success: true, message: "OpenRouter API key is valid" };
    }
    const errorData = await response.json() as { error?: { message?: string } };
    return { success: false, message: errorData.error?.message || "Invalid API key", details: errorData };
  } catch (err) {
    return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function testApify(apiKey: string): Promise<{ success: boolean; message: string; details?: unknown }> {
  try {
    const response = await providerFetch('https://api.apify.com/v2/users/me', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (response.ok) {
      const data = await response.json() as { data?: { username?: string; plan?: { name?: string } } };
      return { 
        success: true, 
        message: "Apify API key is valid",
        details: { username: data.data?.username, plan: data.data?.plan?.name }
      };
    }
    const errorData = await response.json() as { error?: { message?: string } };
    return { success: false, message: errorData.error?.message || "Invalid API key", details: errorData };
  } catch (err) {
    return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function testGemini(apiKey: string): Promise<{ success: boolean; message: string; details?: unknown }> {
  try {
    const response = await providerFetch('https://generativelanguage.googleapis.com/v1/models', {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (response.ok) {
      return { success: true, message: "Gemini API key is valid" };
    }
    const errorData = await response.json() as { error?: { message?: string } };
    return { success: false, message: errorData.error?.message || "Invalid API key", details: errorData };
  } catch (err) {
    return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function testVertexAI(
  serviceAccountJson: string,
  config: Record<string, unknown> | null | undefined,
): Promise<{ success: boolean; message: string; accountName?: string; details?: unknown }> {
  const model = typeof config?.model === 'string' ? config.model : DEFAULT_VERTEX_MODEL;
  const provider = new VertexAIProvider(serviceAccountJson, model, {
    location: typeof config?.location === 'string' ? config.location : undefined,
    projectId: typeof config?.projectId === 'string' ? config.projectId : undefined,
  });
  const summary = provider.getCredentialSummary();
  const initializationError = provider.getInitializationError();
  if (!summary || initializationError) {
    return { success: false, message: initializationError || 'Invalid Vertex AI service account' };
  }
  const response = await provider.createChatCompletion({
    model,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    temperature: 0,
    max_tokens: 8,
  });
  if (!response.success) {
    const providerError = response.error || '';
    if (/dunning decision is deny/i.test(providerError)) {
      return {
        success: false,
        message: 'Google Cloud authenticated the service account, but project billing is delinquent or suspended. Resolve the billing account for this project, then validate again.',
      };
    }
    if (/permission_denied|\b403\b/i.test(providerError)) {
      return {
        success: false,
        message: 'Google Cloud authenticated the service account but denied Vertex AI access. Enable the Vertex AI API and grant the service account Vertex AI User access.',
      };
    }
    return { success: false, message: 'Vertex AI connection failed. Check the project, region, model availability, and Google Cloud audit logs.' };
  }
  return {
    success: true,
    message: `Vertex AI is available in ${summary.location}`,
    accountName: `Vertex AI · ${summary.projectId}`,
    details: { projectId: summary.projectId, location: summary.location, model },
  };
}

async function testZeroBounce(apiKey: string): Promise<{ success: boolean; message: string; details?: unknown }> {
  try {
    const response = await providerFetch('https://api.zerobounce.net/v2/getcredits', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (response.ok) {
      const data = await response.json() as { Credits?: number };
      return { 
        success: true, 
        message: "ZeroBounce API key is valid",
        details: { credits: data.Credits }
      };
    }
    const errorData = await response.json() as { error?: string };
    return { success: false, message: errorData.error || "Invalid API key", details: errorData };
  } catch (err) {
    return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function testSMTP(
  user: string, 
  password: string | null, 
  config: Record<string, unknown> | null
): Promise<{ success: boolean; message: string; details?: unknown }> {
  try {
    if (!_nodemailer) _nodemailer = await import('nodemailer'); const nodemailer = _nodemailer;
    const transporter = nodemailer.createTransport({
      host: config?.host as string || 'smtp.gmail.com',
      port: config?.port as number || 587,
      secure: config?.secure as boolean || false,
      connectionTimeout: PROVIDER_TEST_TIMEOUT_MS,
      greetingTimeout: PROVIDER_TEST_TIMEOUT_MS,
      socketTimeout: PROVIDER_TEST_TIMEOUT_MS,
      auth: {
        user: user,
        pass: password || '',
      },
    });
    
    await transporter.verify();
    return { success: true, message: "SMTP connection successful" };
  } catch (err) {
    return { success: false, message: `SMTP connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function testResend(apiKey: string): Promise<{ success: boolean; message: string; details?: unknown }> {
  try {
    if (!_resend) _resend = await import('resend'); const { Resend } = _resend;
    const resend = new Resend(apiKey);
    const { data, error } = await resend.domains.list();
    if (error) {
      return { success: false, message: 'Invalid Resend API key' };
    }
    const domains = Array.isArray(data) ? data : (data as Record<string, unknown>)?.data ?? [];
    return { success: true, message: `Resend API key is valid. ${(domains as unknown[]).length} domain(s) found.` };
  } catch (err) {
    return { success: false, message: `Resend connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

function testGmailOAuthConfig(clientId: string, clientSecret: string | null) {
  const validClientId = /^[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i.test(clientId);
  if (!validClientId || !clientSecret || clientSecret.length < 8) {
    return { success: false, message: 'Gmail OAuth Client ID or Client Secret format is invalid' };
  }
  return {
    success: true,
    message: 'Gmail OAuth credential format is valid. Google verifies the app during the first OAuth consent callback.',
    details: { requiresOAuthConsent: true },
  };
}

async function testMetaApp(
  appId: string,
  appSecret: string | null,
  config: Record<string, unknown> | null,
): Promise<{ success: boolean; message: string; details?: unknown }> {
  if (!/^\d{5,30}$/.test(appId) || !appSecret) return { success: false, message: 'Meta App ID or App Secret is invalid' };
  const version = typeof config?.apiVersion === 'string' && /^v\d{1,3}\.\d{1,2}$/.test(config.apiVersion)
    ? config.apiVersion
    : 'v25.0';
  try {
    const response = await providerFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(appId)}?fields=id,name`, {
      headers: { Authorization: `Bearer ${appId}|${appSecret}` },
    });
    if (response.ok) return { success: true, message: 'Meta App credentials are valid' };
    return { success: false, message: response.status === 401 || response.status === 400 ? 'Meta rejected the App ID or App Secret' : `Meta API returned status ${response.status}` };
  } catch (err) {
    return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

/**
 * Validate API key and get account info
 * POST /api/admin/integrations/validate
 */
export async function validateApiKey(req: Request, res: Response) {
  try {
    const raw = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const config = raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config)
      ? raw.config as Record<string, unknown>
      : {};
    if (raw.baseUrl !== undefined) config.baseUrl = raw.baseUrl;
    if (raw.model !== undefined) config.model = raw.model;
    const input = parseIntegrationCredentialInput({
      platform: raw.platform,
      name: 'Credential validation',
      apiKey: raw.apiKey,
      apiSecret: raw.apiSecret,
      config,
    });
    validateIntegrationRequirements(input);
    const platform = input.platform!;
    const apiKey = input.apiKey!;

    let result: { success: boolean; message: string; accountName?: string; details?: unknown } = {
      success: false,
      message: "Unknown platform",
    };

    switch (platform) {
      case 'openai':
        result = await validateOpenAIKey(apiKey);
        break;
      case 'openrouter':
        result = await validateOpenRouterKey(apiKey);
        break;
      case 'apify':
        result = await validateApifyKey(apiKey);
        break;
      case 'gemini':
        result = await validateGeminiKey(apiKey);
        break;
      case 'vertex_ai':
        result = await testVertexAI(apiKey, input.config);
        break;
      case 'gemini_image':
      case 'gemini_video':
        result = await validateGeminiKey(apiKey);
        break;
      case 'zerobounce':
        result = await validateZeroBounceKey(apiKey);
        break;
      case 'custom_ai':
        result = await validateCustomAIKey(apiKey, req.body.baseUrl, req.body.model);
        break;
      case 'openai_embedding':
        result = await testEmbeddingCredential('openai', apiKey, input.config);
        break;
      case 'openrouter_embedding':
        result = await testEmbeddingCredential('openrouter', apiKey, input.config);
        break;
      case 'gemini_embedding':
        result = await testEmbeddingCredential('gemini', apiKey, input.config);
        break;
      case 'smtp':
        result = await testSMTP(apiKey, input.apiSecret || null, input.config || {});
        break;
      case 'razorpay':
        result = await testRazorpay(apiKey, input.apiSecret || null);
        break;
      case 'resend':
        result = await testResend(apiKey);
        break;
      case 'gmail_oauth':
        result = testGmailOAuthConfig(apiKey, input.apiSecret || null);
        break;
      case 'meta_app':
        result = await testMetaApp(apiKey, input.apiSecret || null, input.config || {});
        break;
      default:
        result = { success: false, message: "Automated validation is not available for this platform." };
    }

    return res.json({
      success: true,
      validation: result,
    });
  } catch (error) {
    if (error instanceof Error && /must|required|invalid|unsupported|between|smaller/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, '[validateApiKey] Error');
    return res.status(500).json({ error: "Unable to validate the API key. Please try again." });
  }
}

// Validation helpers that return account info
async function validateOpenAIKey(apiKey: string): Promise<{ success: boolean; message: string; accountName?: string; details?: unknown }> {
  try {
    const response = await providerFetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (response.ok) {
      return { success: true, message: "OpenAI API key is valid", accountName: "OpenAI Account" };
    }
    const errorData = await response.json() as { error?: { message?: string } };
    return { success: false, message: errorData.error?.message || "Invalid API key" };
  } catch (err) {
    return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function validateOpenRouterKey(apiKey: string): Promise<{ success: boolean; message: string; accountName?: string; details?: unknown }> {
  try {
    const response = await providerFetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (response.ok) {
      const data = await response.json() as { data?: { name?: string; label?: string } };
      const accountName = data.data?.label || data.data?.name || "OpenRouter Account";
      return { success: true, message: "OpenRouter API key is valid", accountName };
    }
    const errorData = await response.json() as { error?: { message?: string } };
    return { success: false, message: errorData.error?.message || "Invalid API key" };
  } catch (err) {
    return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function validateApifyKey(apiKey: string): Promise<{ success: boolean; message: string; accountName?: string; details?: unknown }> {
  try {
    const response = await providerFetch('https://api.apify.com/v2/users/me', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (response.ok) {
      const data = await response.json() as { data?: { username?: string; plan?: { name?: string } } };
      const accountName = data.data?.username || "Apify Account";
      return { 
        success: true, 
        message: "Apify API key is valid",
        accountName,
        details: { username: data.data?.username, plan: data.data?.plan?.name }
      };
    }
    const errorData = await response.json() as { error?: { message?: string } };
    return { success: false, message: errorData.error?.message || "Invalid API key" };
  } catch (err) {
    return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function validateGeminiKey(apiKey: string): Promise<{ success: boolean; message: string; accountName?: string; details?: unknown }> {
  try {
    const response = await providerFetch('https://generativelanguage.googleapis.com/v1/models', {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (response.ok) {
      return { success: true, message: "Gemini API key is valid", accountName: "Google Gemini" };
    }
    const errorData = await response.json() as { error?: { message?: string } };
    return { success: false, message: errorData.error?.message || "Invalid API key" };
  } catch (err) {
    return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function validateZeroBounceKey(apiKey: string): Promise<{ success: boolean; message: string; accountName?: string; details?: unknown }> {
  try {
    const response = await providerFetch('https://api.zerobounce.net/v2/getcredits', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (response.ok) {
      const data = await response.json() as { Credits?: number };
      return { 
        success: true, 
        message: "ZeroBounce API key is valid",
        accountName: "ZeroBounce Account",
        details: { credits: data.Credits }
      };
    }
    const errorData = await response.json() as { error?: string };
    return { success: false, message: errorData.error || "Invalid API key" };
  } catch (err) {
    return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function testRazorpay(
  keyId: string,
  keySecret: string | null
): Promise<{ success: boolean; message: string; details?: unknown }> {
  if (!keySecret) {
    return { success: false, message: "Key Secret is required for Razorpay" };
  }
  try {
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const response = await providerFetch('https://api.razorpay.com/v1/payments?count=1', {
      headers: { 'Authorization': `Basic ${auth}` },
    });
    if (response.ok) {
      return { success: true, message: "Razorpay credentials are valid" };
    }
    if (response.status === 401) {
      return { success: false, message: "Invalid Razorpay Key ID or Key Secret" };
    }
    return { success: false, message: `Razorpay API returned status ${response.status}` };
  } catch (err) {
    return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function validateCustomAIKey(
  apiKey: string,
  baseUrl?: string,
  model?: string
): Promise<{ success: boolean; message: string; accountName?: string; details?: unknown }> {
  if (!baseUrl) {
    return { success: false, message: "Base URL is required for custom AI validation" };
  }
  try {
    // Normalize base URL — remove trailing slash
    const normalizedUrl = (await assertPublicHttpUrl(baseUrl)).toString().replace(/\/+$/, '');
    // Try hitting the models endpoint (OpenAI-compatible)
    const modelsUrl = `${normalizedUrl}/models`;
    const { response } = await fetchPublicHttpUrl(modelsUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
    });
    if (response.ok) {
      return {
        success: true,
        message: "Custom AI endpoint is reachable and API key is valid",
        accountName: `Custom AI (${new URL(normalizedUrl).hostname})`,
      };
    }
    // If /models fails, try a lightweight chat completion
    const chatUrl = `${normalizedUrl}/chat/completions`;
    const { response: chatResponse } = await fetchPublicHttpUrl(chatUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
    });
    if (chatResponse.ok) {
      return {
        success: true,
        message: "Custom AI endpoint is reachable and API key is valid",
        accountName: `Custom AI (${new URL(normalizedUrl).hostname})`,
      };
    }
    if (chatResponse.status === 401 || chatResponse.status === 403) {
      return { success: false, message: "Invalid API key — the endpoint rejected authentication" };
    }
    return { success: false, message: `Endpoint returned status ${chatResponse.status}` };
  } catch (err) {
    return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function testCustomAI(
  apiKey: string,
  config: Record<string, unknown> | null
): Promise<{ success: boolean; message: string; details?: unknown }> {
  const baseUrl = (config?.baseUrl as string) || '';
  const model = (config?.model as string) || '';
  if (!baseUrl) {
    return { success: false, message: "Base URL is not configured for this custom AI credential" };
  }
  const result = await validateCustomAIKey(apiKey, baseUrl, model);
  return { success: result.success, message: result.message, details: result.details };
}

/**
 * Fetch verified domains from a Resend API key
 * GET /api/admin/integrations/resend-domains?credentialId=N
 * OR GET /api/admin/integrations/resend-domains (uses active resend credential)
 */
export async function getResendDomains(req: Request, res: Response) {
  try {
    const credentialId = req.query.credentialId ? Number(req.query.credentialId) : undefined;

    let apiKey: string | undefined;
    if (credentialId) {
      const cred = await getAdminCredentialById(credentialId);
      if (!cred || cred.platform !== 'resend') {
        return res.status(404).json({ error: 'Resend credential not found' });
      }
      apiKey = cred.apiKey;
    } else {
      const cred = await getActiveAdminCredential('resend');
      if (!cred) {
        return res.status(404).json({ error: 'No active Resend credential found' });
      }
      apiKey = cred.apiKey;
    }

    if (!_resend) _resend = await import('resend'); const { Resend } = _resend;
    const resend = new Resend(apiKey);
    const { data, error } = await resend.domains.list();
    if (error) {
      return res.status(400).json({ error: 'Failed to fetch domains' });
    }

    const domains = Array.isArray(data) ? data : (data as Record<string, unknown>)?.data ?? [];
    return res.json({
      success: true,
      domains: (domains as Array<{ id: string; name: string; status: string; region?: string }>).map(d => ({
        id: d.id,
        name: d.name,
        status: d.status,
        region: d.region,
      })),
    });
  } catch (error) {
    logger.error({ err: error }, '[getResendDomains] Error');
    return res.status(500).json({ error: 'Failed to fetch Resend domains' });
  }
}

/**
 * Get Apify account balance for all Apify credentials
 * GET /api/admin/integrations/apify/balance
 */
export async function getApifyBalances(req: Request, res: Response) {
  try {
    const credentials = await getAdminCredentialsByPlatform('apify');
    
    const balances = await Promise.allSettled(
      credentials.map(async (cred) => {
        try {
          // Fetch user info and limits in parallel
          const [userResponse, limitsResponse] = await Promise.all([
            fetch('https://api.apify.com/v2/users/me', {
              headers: { 'Authorization': `Bearer ${cred.apiKey}` },
            }),
            fetch('https://api.apify.com/v2/users/me/limits', {
              headers: { 'Authorization': `Bearer ${cred.apiKey}` },
            }),
          ]);
          
          if (userResponse.ok && limitsResponse.ok) {
            const userData = await userResponse.json() as {
              data?: {
                username?: string;
                plan?: {
                  name?: string;
                };
              };
            };
            
            const limitsData = await limitsResponse.json() as {
              data?: {
                limits?: {
                  maxMonthlyUsageUsd?: number;
                };
                current?: {
                  monthlyUsageUsd?: number;
                };
              };
            };
            
            const maxUsage = limitsData.data?.limits?.maxMonthlyUsageUsd ?? 0;
            const currentUsage = limitsData.data?.current?.monthlyUsageUsd ?? 0;
            const dollarRemaining = maxUsage - currentUsage;
            
            return {
              id: cred.id,
              name: cred.name,
              username: userData.data?.username,
              plan: userData.data?.plan?.name,
              dollarRemaining,
              totalMonthUsageUsd: currentUsage,
              monthlyChargeUsd: maxUsage,
            };
          }
          return { id: cred.id, name: cred.name, error: 'Failed to fetch' };
        } catch {
          return { id: cred.id, name: cred.name, error: 'Connection failed' };
        }
      })
    );

    const result = balances.map((b) => b.status === 'fulfilled' ? b.value : { id: 0, name: 'Unknown', error: 'Failed' });
    
    return res.json({
      success: true,
      balances: result,
    });
  } catch (error) {
    logger.error({ err: error }, '[getApifyBalances] Error');
    return res.status(500).json({ error: "Unable to retrieve Apify balances. Please try again." });
  }
}

// Helper to mask API keys
function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '****';
  return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}
