/**
 * Switches AI provider keys back on once their provider account has credits again.
 *
 * A key that runs out of credits is switched off with reason `quota_exceeded`
 * (see LLMProviderFactory). Topping up the provider account does not tell
 * AskSales anything, so without this check the key stayed off until an
 * administrator found it and switched it back on, and every chat in the
 * meantime said the AI service was unavailable.
 *
 * Each run sends one tiny completion per such key while the key is still off.
 * Only a successful reply switches it back on, so an unfunded key never fails a
 * real customer request and never sends administrators a second switch-off alert.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { adminApiCredentialsTable, type AdminApiCredentialRecord } from '../models/adminApiCredentials/schema.js';
import {
  decryptAdminCredential,
  LLM_ADMIN_PLATFORMS,
  recordAdminCredentialAudit,
} from '../models/adminApiCredentials/functions.js';
import { createVertexOpenAICompatibilityConfig } from '../utils/vertexAuth.js';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_VERTEX_MODEL,
  normalizeLLMModelName,
} from '../utils/llmConstants.js';
import { logger } from '../utils/logger.js';

/** Wait this long after a key is switched off, and between checks of the same key. */
export const CREDIT_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;

const PROVIDER_NAMES: Record<string, string> = {
  openrouter: 'OpenRouter', openai: 'OpenAI', gemini: 'Gemini', vertex_ai: 'Vertex AI', custom_ai: 'Custom AI',
};

const DEFAULT_MODELS: Record<string, string> = {
  openai: DEFAULT_OPENAI_MODEL,
  gemini: DEFAULT_GEMINI_MODEL,
  vertex_ai: DEFAULT_VERTEX_MODEL,
  openrouter: DEFAULT_OPENROUTER_MODEL,
};

interface ProbeTarget { url: string; apiKey: string; model: string; body: Record<string, unknown> }

/** Every supported provider accepts an OpenAI-compatible chat completion request. */
async function probeTarget(credential: AdminApiCredentialRecord): Promise<ProbeTarget | null> {
  const config = (credential.config || {}) as Record<string, unknown>;
  const model = normalizeLLMModelName(credential.platform,
    String(config.selectedModel || config.model || DEFAULT_MODELS[credential.platform] || ''));
  if (!credential.apiKey || !model) return null;
  const messages = [{ role: 'user', content: 'Reply with OK.' }];

  switch (credential.platform) {
    case 'openrouter':
      return { url: 'https://openrouter.ai/api/v1/chat/completions', apiKey: credential.apiKey, model,
        body: { model, messages, max_tokens: 16 } };
    case 'openai':
      // Newer OpenAI models reject max_tokens; max_completion_tokens works for all of them.
      return { url: 'https://api.openai.com/v1/chat/completions', apiKey: credential.apiKey, model,
        body: { model, messages, max_completion_tokens: 16 } };
    case 'gemini':
      return { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', apiKey: credential.apiKey, model,
        body: { model, messages, max_tokens: 16 } };
    case 'custom_ai': {
      const baseURL = String(config.baseUrl || config.baseURL || '').replace(/\/+$/, '');
      if (!baseURL) return null;
      return { url: `${baseURL}/chat/completions`, apiKey: credential.apiKey, model,
        body: { model, messages, max_tokens: 16 } };
    }
    case 'vertex_ai': {
      const vertex = await createVertexOpenAICompatibilityConfig(credential.apiKey, {
        model,
        location: typeof config.location === 'string' ? config.location : undefined,
        projectId: typeof config.projectId === 'string' ? config.projectId : undefined,
      });
      return { url: `${vertex.baseURL.replace(/\/+$/, '')}/chat/completions`, apiKey: vertex.accessToken, model: vertex.model,
        body: { model: vertex.model, messages, max_tokens: 16 } };
    }
    default:
      return null;
  }
}

export type CreditProbeResult = { ok: true } | { ok: false; message: string };

/** Send one tiny completion. Only a 2xx reply counts as credits being available. */
export async function probeLLMCredential(credential: AdminApiCredentialRecord): Promise<CreditProbeResult> {
  try {
    const target = await probeTarget(credential);
    if (!target) return { ok: false, message: 'The key has no model or address to check.' };
    const response = await fetch(target.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(target.body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true };
    const text = await response.text().catch(() => '');
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      detail = (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) || parsed.message || text;
    } catch { /* keep the raw body */ }
    return { ok: false, message: `${response.status} ${detail}`.trim().slice(0, 500) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Claim every AI key that is off for lack of credits and has not been checked
 * in the last interval. The claim is one atomic UPDATE, so two workers never
 * check the same key at once.
 */
async function claimCreditDisabledCredentials(now: Date): Promise<AdminApiCredentialRecord[]> {
  const cutoff = new Date(now.getTime() - CREDIT_RECHECK_INTERVAL_MS);
  const rows = await db
    .update(adminApiCredentialsTable)
    .set({ lastValidatedAt: now })
    .where(and(
      eq(adminApiCredentialsTable.isActive, false),
      eq(adminApiCredentialsTable.deactivationReason, 'quota_exceeded'),
      sql`${adminApiCredentialsTable.platform} IN (${sql.join(LLM_ADMIN_PLATFORMS.map(platform => sql`${platform}`), sql`, `)})`,
      sql`${adminApiCredentialsTable.deactivatedAt} < ${cutoff}`,
      sql`(${adminApiCredentialsTable.lastValidatedAt} IS NULL OR ${adminApiCredentialsTable.lastValidatedAt} < ${cutoff})`,
    ))
    .returning();
  return (rows as AdminApiCredentialRecord[]).map(decryptAdminCredential);
}

export interface CreditRecoveryResult { checked: number; reactivated: number[] }

export async function recoverCreditDisabledLLMCredentials(
  probe: (credential: AdminApiCredentialRecord) => Promise<CreditProbeResult> = probeLLMCredential,
  now: Date = new Date(),
): Promise<CreditRecoveryResult> {
  const claimed = await claimCreditDisabledCredentials(now);
  const reactivated: number[] = [];

  for (const credential of claimed) {
    const provider = PROVIDER_NAMES[credential.platform] || credential.platform;
    const result = await probe(credential);

    if (!result.ok) {
      await db.update(adminApiCredentialsTable)
        .set({ validationStatus: 'invalid', validationMessage: `Still unavailable: ${result.message}`.slice(0, 1000) })
        .where(eq(adminApiCredentialsTable.id, credential.id));
      logger.info({ credentialId: credential.id, platform: credential.platform, reason: result.message },
        '[LLMCredentialRecovery] Key is still out of credits; it stays off');
      continue;
    }

    // The guard keeps an administrator's own change (switching it off by hand,
    // deleting it) made while the check was running.
    const [updated] = await db.update(adminApiCredentialsTable)
      .set({
        isActive: true,
        deactivationReason: null,
        deactivatedAt: null,
        validationStatus: 'valid',
        validationMessage: 'Credits are available again; switched back on automatically.',
        updatedAt: new Date(),
      })
      .where(and(
        eq(adminApiCredentialsTable.id, credential.id),
        eq(adminApiCredentialsTable.isActive, false),
        eq(adminApiCredentialsTable.deactivationReason, 'quota_exceeded'),
      ))
      .returning({ id: adminApiCredentialsTable.id });
    if (!updated) continue;

    reactivated.push(credential.id);
    logger.info({ credentialId: credential.id, platform: credential.platform },
      '[LLMCredentialRecovery] Credits are available again; key switched back on');

    try {
      await recordAdminCredentialAudit({
        credentialId: credential.id,
        platform: credential.platform,
        action: 'activate',
        validationStatus: 'valid',
        message: 'Switched back on automatically after a test request succeeded.',
      });
    } catch (error) {
      logger.warn({ err: error, credentialId: credential.id }, '[LLMCredentialRecovery] Could not record the audit entry');
    }
    try {
      const { notifyAllAdmins } = await import('../models/adminNotifications/functions.js');
      await notifyAllAdmins({
        title: `${provider} key switched back on`,
        message: `The ${provider} key "${credential.name}" has credits again, so AskSales switched it back on. AI replies and other AI features use it again.`,
        type: 'success',
        category: 'system',
      });
    } catch (error) {
      logger.warn({ err: error, credentialId: credential.id }, '[LLMCredentialRecovery] Could not tell administrators');
    }
  }

  return { checked: claimed.length, reactivated };
}
