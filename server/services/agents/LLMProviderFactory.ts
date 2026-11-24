import { assertConversationRequestActive, ConversationRequestError } from '../ConversationRequestCoordinator.js';
/**
 * LLM Provider Factory
 * Creates appropriate LLM provider based on admin credentials (system-wide)
 * Active general LLM integrations are attempted by configured priority;
 * classifier integrations use a separate credential pool.
 * Supports automatic fallback on rate limit/quota exceeded errors
 * 
 * NOTE: This uses admin-configured API keys from admin_api_credentials table.
 * All users share these system-wide credentials.
 */

import { LLMProvider, type LLMChatOptions, type LLMResponse, type LLMStreamOptions } from './LLMProvider';
import { OpenAIService } from './OpenAIService';
import { OpenRouterProvider } from './OpenRouterProvider';
import { CustomAIProvider } from './CustomAIProvider';
import { GeminiProvider } from './GeminiProvider';
import { VertexAIProvider } from './VertexAIProvider.js';
import { 
  getActiveAdminCredential, 
  markAdminCredentialInactive,
  getActiveLLMAdminCredentials,
  updateAdminCredentialLastUsed,
  AdminApiPlatform,
} from '../../models/adminApiCredentials/functions';
import { logger } from '../../utils/logger.js';
import type { IntentClassifierCredential } from '../../models/intentClassifierCredentials/schema.js';
import {
  classifyLLMProviderFailure,
  isProviderResponseError,
  LLMProviderQuotaError,
  LLMProviderResponseError,
  safeLLMProviderFailureMessage,
} from './LLMProviderErrors.js';
import { DEFAULT_OPENROUTER_MODEL, normalizeLLMModelName } from '../../utils/llmConstants.js';
import { currentAssistant } from '../assistants/AssistantContext.js';
import { assertAssistantFresh } from '../assistants/AssistantFreshness.js';
import { getManagedAssistantModels, mergeAssistantModelCatalog, quotaBlockedAssistantProviders, quotaDisabledAIProviders } from '../assistants/AssistantModelCatalogService.js';

interface AdminCredentials {
  openai: { id: number; apiKey: string; model?: string; config?: Record<string, unknown> | null } | null;
  gemini: { id: number; apiKey: string; model?: string; config?: Record<string, unknown> | null } | null;
  vertex_ai: { id: number; apiKey: string; model?: string; config?: Record<string, unknown> | null } | null;
  openrouter: { id: number; apiKey: string; model?: string; config?: Record<string, unknown> | null } | null;
  custom_ai: { id: number; apiKey: string; model?: string; baseURL?: string; config?: Record<string, unknown> | null } | null;
}
type RuntimeLLMPlatform = keyof AdminCredentials;

// Cache admin credentials for a short time to avoid repeated DB queries
let adminCredentialCache: { credentials: AdminCredentials; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Rate limit error patterns — kept specific to avoid false positives
const RATE_LIMIT_ERROR_PATTERNS = [
  'rate limit',
  'rate-limited',
  'rate_limit',
  'quota exceeded',
  'quota_exceeded',
  'too many requests',
  '429',
  'insufficient_quota',
  'exceeded your current quota',
  'resource exhausted',
  'service unavailable',
  'overloaded',
  'high demand',
  'capacity',
  'server_overloaded',
  'requests per minute',
  'requests per day',
];

/**
 * Check if an error is a rate limit, quota, or service overload error
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isRateLimitError(error: any): boolean {
  const errorMessage = (error?.message || error?.error?.message || String(error)).toLowerCase();
  const errorCode = error?.status || error?.code || error?.error?.code;
  
  // Check status codes: 429 (rate limit) and 503 (service unavailable / overloaded)
  if (errorCode === 429 || errorCode === '429' || errorCode === 503 || errorCode === '503') {
    return true;
  }
  
  // Check error message patterns
  return RATE_LIMIT_ERROR_PATTERNS.some(pattern => errorMessage.includes(pattern));
}

function isProviderTimeoutError(error: unknown): boolean {
  const message = error instanceof Error
    ? `${error.name} ${error.message}`
    : String(error);
  return /timed?\s*out|timeout|deadline exceeded|ETIMEDOUT|ECONNABORTED|gateway timeout|\b504\b/i.test(message);
}

// Billing failures are durable until an administrator funds or replaces the
// credential. Treating them as an ordinary provider error causes every queued
// job to hammer the same unusable account.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isProviderCreditError(error: any): boolean {
  // A positive, request-specific affordable-token limit is not evidence that
  // the shared credential is exhausted; it must not be quarantined.
  return classifyLLMProviderFailure(error).category === 'insufficient_credits';
}

// Only durable quota exhaustion should disable a shared credential. A plain
// 429 (including OpenRouter's temporary credit-verification timeout) is safe to
// retry and must not take the provider offline for every user.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isDurableProviderQuotaError(error: any): boolean {
  const errorMessage = (error?.message || error?.error?.message || String(error)).toLowerCase();
  if (errorMessage.includes('could not verify available credits')
    || errorMessage.includes('retry shortly')) return false;
  return errorMessage.includes('quota exceeded')
    || errorMessage.includes('quota_exceeded')
    || errorMessage.includes('insufficient_quota')
    || errorMessage.includes('exceeded your current quota')
    || errorMessage.includes('requests per day');
}

export class LLMProviderFactory {
  /** Bound providers also cover older direct-call paths. Their model cannot be
   * replaced by an agent override, tool callback or a different provider's ID. */
  private static bindAssistantProvider(provider: LLMProvider): LLMProvider {
    const selected = currentAssistant();
    if (!selected) return provider;
    const parameters = <T extends LLMChatOptions | LLMStreamOptions>(options: T): T => {
      if (currentAssistant() !== selected) throw new Error('The reply provider belongs to another assistant turn.');
      const result = {...options,model:provider.defaultModel};
      if (/(?:reply|response|_agent$|assistant_follow_up)/i.test(String(options.loggingContext?.purpose || ''))) {
        result.max_tokens = selected.configuration.response.maxReplyTokens;
      }
      delete result.temperature;
      delete (result as LLMChatOptions).top_p;
      if (!(provider.getProviderName() === 'openai' && /^(?:o\d|gpt-5)/i.test(provider.defaultModel))) {
        result.temperature = selected.configuration.response.temperature;
        (result as LLMChatOptions).top_p = selected.configuration.response.topP;
      }
      result.loggingContext = {...options.loggingContext,purpose:options.loggingContext?.purpose || 'support',
        service:options.loggingContext?.service || 'Assistant',metadata:{...options.loggingContext?.metadata,assistant:selected.provenance}};
      return result;
    };
    return new Proxy(provider, {
      get(target,key) {
        if (key === 'createChatCompletion') return async (options: LLMChatOptions) => {
          await assertAssistantFresh();
          const result = await target.createChatCompletion(parameters(options));
          await assertAssistantFresh();
          return result;
        };
        if (key === 'createChatCompletionStream') return async (options: LLMStreamOptions) => {
          await assertAssistantFresh();
          const result = await target.createChatCompletionStream(parameters(options));
          await assertAssistantFresh();
          return result;
        };
        const value = Reflect.get(target,key,target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  static createClassifierProvider(userId: number, credential: IntentClassifierCredential): LLMProvider {
    const model = String(credential.config?.model || '').trim();
    if (!credential.isActive || !model || !credential.apiKey) throw new Error('Classifier credential unavailable');
    const provider = this.createProviderInstance(credential.platform as RuntimeLLMPlatform, credential, userId, model);
    if (!provider) throw new Error('Classifier provider configuration is incomplete');
    return provider;
  }

  private static createProviderInstance(
    platform: RuntimeLLMPlatform,
    credential: {
      id: number;
      apiKey: string;
      config?: Record<string, unknown> | null;
    },
    userId: number,
    preferredModel?: string,
  ): LLMProvider | null {
    const config = credential.config || {};
    const configuredModel = typeof config.selectedModel === 'string'
      ? config.selectedModel
      : typeof config.model === 'string' ? config.model : undefined;
    const model = normalizeLLMModelName(
      platform,
      preferredModel
        || configuredModel
        || (platform === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : undefined),
    );
    let provider: LLMProvider;

    if (platform === 'openai') {
      provider = new OpenAIService(credential.apiKey, model);
    } else if (platform === 'gemini') {
      provider = new GeminiProvider(credential.apiKey, model);
    } else if (platform === 'vertex_ai') {
      provider = new VertexAIProvider(credential.apiKey, model, {
        location: typeof config.location === 'string' ? config.location : undefined,
        projectId: typeof config.projectId === 'string' ? config.projectId : undefined,
      });
    } else if (platform === 'openrouter') {
      provider = new OpenRouterProvider(credential.apiKey, model);
    } else {
      const baseURL = typeof config.baseUrl === 'string'
        ? config.baseUrl
        : typeof config.baseURL === 'string' ? config.baseURL : undefined;
      if (!baseURL) return null;
      provider = new CustomAIProvider(credential.apiKey, baseURL, model);
    }

    // Server-only metadata supports observability and rate-limit handling.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any)._credentialId = credential.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any)._userId = userId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any)._platform = platform;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any)._isAdmin = true;
    return provider;
  }

  /**
   * Return every active chat provider in configured preference order. This is
   * intentionally read-only: a generic 4xx/model incompatibility must not
   * deactivate a credential or mutate provider state.
   */
  private static async createProviderCandidatesForUser(userId: number): Promise<LLMProvider[]> {
    const candidates: LLMProvider[] = [];
    const credentials = await getActiveLLMAdminCredentials();
    const assistant = currentAssistant();
    if (assistant) {
      const approved = [assistant.configuration.replyModel,...assistant.configuration.fallbackModels].filter(Boolean);
      const catalog = mergeAssistantModelCatalog(credentials, await getManagedAssistantModels());
      for (const selection of approved) {
        if (!selection) continue;
        const entry = catalog.find(model => model.provider === selection.provider && model.model === selection.model && model.enabled && model.connected);
        const credential = entry ? credentials.find(c => c.id === entry.credentialId && c.platform === entry.provider) : undefined;
        if (!credential) continue;
        const provider=this.createProviderInstance(credential.platform as RuntimeLLMPlatform,credential,userId,selection.model);
        if (provider) candidates.push(this.bindAssistantProvider(provider));
      }
      return candidates;
    }
    for (const credential of credentials) {
      if (!credential.apiKey) continue;
      const provider = this.createProviderInstance(credential.platform as RuntimeLLMPlatform, credential, userId);
      if (provider) candidates.push(provider);
    }

    return candidates;
  }

  private static async throwIfProviderQuotaDisabled(): Promise<void> {
    const assistant = currentAssistant();
    const providers = assistant
      ? await quotaBlockedAssistantProviders([assistant.configuration.replyModel, ...assistant.configuration.fallbackModels].filter(model => model !== null))
      : await quotaDisabledAIProviders();
    if (providers.length) throw new LLMProviderQuotaError(providers);
  }

  /**
   * Execute a response-only LLM request against configured providers without
   * leaking a provider error into assistant text. Only upstream provider
   * failures are retried; application exceptions still fail immediately.
   */
  static async executeProviderCallWithFallback<T>(
    userId: number,
    callFn: (provider: LLMProvider) => Promise<T>,
    maxAttempts = 8,
  ): Promise<T> {
    assertConversationRequestActive();
    await assertAssistantFresh();
    const candidates = await this.createProviderCandidatesForUser(userId);
    if (candidates.length === 0) {
      await this.throwIfProviderQuotaDisabled();
      throw new Error('No active LLM API keys configured. Please ask an administrator to configure an AI provider.');
    }

    let lastError: unknown;
    const attempts = Math.min(Math.max(maxAttempts, 1), candidates.length);
    for (let index = 0; index < attempts; index += 1) {
      const provider = candidates[index];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const credentialId = (provider as any)._credentialId as number | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const platform = (provider as any)._platform as string | undefined;
      try {
        if (credentialId) await updateAdminCredentialLastUsed(credentialId);
        assertConversationRequestActive();
        const result = await callFn(provider);
        await assertAssistantFresh();
        assertConversationRequestActive();
        if (index > 0) {
          logger.info(
            { userId, platform, model: provider.defaultModel, attempt: index + 1 },
            '[LLMProviderFactory] Provider fallback succeeded',
          );
        }
        return result;
      } catch (error) {
        if (error instanceof ConversationRequestError) throw error;
        lastError = error;
        if (isProviderTimeoutError(error)) {
          logger.warn(
            { userId, platform, model: provider.defaultModel, attempt: index + 1 },
            '[LLMProviderFactory] Provider timed out; stopping fallback to avoid compounding a stalled response',
          );
          throw error instanceof Error ? error : new Error(String(error));
        }
        const rateLimited = isRateLimitError(error);
        const creditUnavailable = isProviderCreditError(error);
        const durableQuotaExceeded = isDurableProviderQuotaError(error);
        const shouldQuarantineCredential = creditUnavailable || durableQuotaExceeded;
        if (!isProviderResponseError(error) && !rateLimited && !creditUnavailable) throw error;
        if (credentialId && shouldQuarantineCredential) {
          const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
          const reason = creditUnavailable || message.includes('quota') || message.includes('billing')
            ? 'quota_exceeded'
            : message.includes('overloaded') || message.includes('service unavailable')
              ? 'service_overloaded'
              : 'rate_limit_429';
          try {
            await markAdminCredentialInactive(credentialId, reason);
            this.clearCache();
          } catch (credentialError) {
            logger.error({ err: credentialError, credentialId, platform }, '[LLMProviderFactory] Failed to quarantine unavailable credential');
          }
        }
        logger.warn(
          {
            userId,
            platform,
            model: provider.defaultModel,
            attempt: index + 1,
            remainingCandidates: attempts - index - 1,
            errorType: error instanceof Error ? error.name : typeof error,
            failureCategory: classifyLLMProviderFailure(error).category,
            failureStatus: classifyLLMProviderFailure(error).status,
            credentialQuarantined: Boolean(credentialId && shouldQuarantineCredential),
          },
          '[LLMProviderFactory] Provider call failed; trying next configured provider',
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('All configured AI providers failed to process the request.');
  }

  /**
   * Shared chat-completion entry point for support agents. Provider failures
   * are converted into typed retry signals, while a model override is reused
   * only when it is compatible with the candidate provider.
   */
  static async createChatCompletionWithFallback(
    userId: number,
    options: LLMChatOptions,
    maxAttempts = 8,
  ): Promise<LLMResponse> {
    try {
      return await this.executeProviderCallWithFallback(
        userId,
        async (provider) => {
          const providerName = provider.getProviderName();
          const requestedModel = options.model?.trim();
          const isCompatible = !requestedModel
            || providerName === 'custom_ai'
            || (providerName === 'openai' && /^(?:gpt-|o\d)/i.test(requestedModel))
            || (providerName === 'openrouter' && requestedModel.includes('/'))
            || (['gemini', 'vertex_ai'].includes(providerName) && /^(?:gemini|gemma)/i.test(requestedModel));
          const assistant = currentAssistant();
          const model = assistant ? provider.defaultModel : isCompatible && requestedModel ? requestedModel : provider.defaultModel;
      const parameters: LLMChatOptions = {...options,model};
          if (assistant) {
            // Do not overwrite internal classifier/extraction budgets with a customer reply-length control.
            const reply = /(?:reply|response|_agent$|assistant_follow_up)/i.test(String(options.loggingContext?.purpose || ''));
            if (reply) parameters.max_tokens=assistant.configuration.response.maxReplyTokens;
            delete parameters.temperature; delete parameters.top_p;
            if (!(providerName === 'openai' && /^(?:o\d|gpt-5)/i.test(model))) {
              if (assistant.configuration.response.temperature !== undefined) parameters.temperature=assistant.configuration.response.temperature;
              if (assistant.configuration.response.topP !== undefined) parameters.top_p=assistant.configuration.response.topP;
            }
            parameters.loggingContext={...options.loggingContext,purpose:options.loggingContext?.purpose || 'support',
              service:options.loggingContext?.service || 'Assistant',metadata:{...options.loggingContext?.metadata,assistant:assistant.provenance}};
          }
          const response = await provider.createChatCompletion(parameters);
          if (!response.success) {
            throw new LLMProviderResponseError(
              response.error || `${providerName} returned an unsuccessful response`,
              providerName,
              model,
            );
          }
          response.completion = response.completion || {};
          response.completion.provider = providerName;
          response.completion.model = response.completion.model || model;
          return response;
        },
        maxAttempts,
      );
    } catch (error) {
      if (error instanceof ConversationRequestError) throw error;
      return {
        success: false,
        error: isProviderResponseError(error)
          ? safeLLMProviderFailureMessage(error, error.provider)
          : error instanceof Error ? error.message : 'All configured AI providers failed',
      };
    }
  }

  /**
   * Get admin credentials from DB or cache
   */
  private static async getAdminCredentials(): Promise<AdminCredentials> {
    // Check cache
    if (adminCredentialCache && Date.now() - adminCredentialCache.timestamp < CACHE_TTL) {
      return adminCredentialCache.credentials;
    }

    try {
      // Fetch all credentials in parallel from admin_api_credentials
      const [openaiCred, geminiCred, vertexCred, openrouterCred, customAiCred] = await Promise.all([
        getActiveAdminCredential('openai'),
        getActiveAdminCredential('gemini'),
        getActiveAdminCredential('vertex_ai'),
        getActiveAdminCredential('openrouter'),
        getActiveAdminCredential('custom_ai'),
      ]);

      const credentials: AdminCredentials = {
        openai: openaiCred ? { 
          id: openaiCred.id,
          apiKey: openaiCred.apiKey, 
          model: openaiCred.config?.model as string | undefined,
          config: openaiCred.config,
        } : null,
        gemini: geminiCred ? {
          id: geminiCred.id,
          apiKey: geminiCred.apiKey,
          model: geminiCred.config?.model as string | undefined,
          config: geminiCred.config,
        } : null,
        vertex_ai: vertexCred ? {
          id: vertexCred.id,
          apiKey: vertexCred.apiKey,
          model: vertexCred.config?.model as string | undefined,
          config: vertexCred.config,
        } : null,
        openrouter: openrouterCred ? { 
          id: openrouterCred.id,
          apiKey: openrouterCred.apiKey, 
          model: (openrouterCred.config?.selectedModel || openrouterCred.config?.model) as string | undefined,
          config: openrouterCred.config,
        } : null,
        custom_ai: customAiCred ? {
          id: customAiCred.id,
          apiKey: customAiCred.apiKey,
          model: customAiCred.config?.model as string | undefined,
          baseURL: (customAiCred.config?.baseUrl || customAiCred.config?.baseURL) as string | undefined,
          config: customAiCred.config,
        } : null,
      };

      // Update cache
      adminCredentialCache = { credentials, timestamp: Date.now() };
      return credentials;
    } catch (error) {
      logger.error({ err: error }, '[LLMProviderFactory] Error fetching admin credentials');
      return { openai: null, gemini: null, vertex_ai: null, openrouter: null, custom_ai: null };
    }
  }

  /**
   * Clear credential cache (call when credentials are updated)
   */
  static clearCache(): void {
    adminCredentialCache = null;
  }

  /**
   * Create an LLM provider based on admin credentials with fallback support
   * Active credentials are ordered by integration priority.
   * On rate limit/quota errors, automatically falls back to next available key
   * @param userId - Optional user ID for tracking purposes
   */
  static async createProviderForUser(userId?: number): Promise<LLMProvider> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (process.env.NODE_ENV === 'test' && (process as any).__mockLLMProviderFactory) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (process as any).__mockLLMProviderFactory(userId);
    }
    const [provider] = await this.createProviderCandidatesForUser(userId || 0);
    if (provider) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const credentialId = (provider as any)._credentialId as number;
      await updateAdminCredentialLastUsed(credentialId);
      logger.info({ credentialId, platform: provider.getProviderName(), model: provider.defaultModel }, '[LLMProviderFactory] Selected LLM provider');
      return provider;
    }

    await this.throwIfProviderQuotaDisabled();
    // No credentials found - throw error
    throw new Error('No active LLM credentials configured. Add OpenAI, Gemini Developer API, Vertex AI, OpenRouter, or Custom AI in Admin > Integrations.');
  }

  /**
   * Handle rate limit error by marking current key as inactive and trying fallback
   * Returns a new provider if fallback is available, throws error otherwise
   * @param provider - The provider that hit rate limit
   * @param error - The error that occurred
   * @returns Object with new provider and deactivation info
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async handleRateLimitError(provider: LLMProvider, error: any): Promise<{ provider: LLMProvider; deactivatedKey: { platform: string; reason: string } | null }> {
    if (currentAssistant()) {
      await assertAssistantFresh();
      const candidates=await this.createProviderCandidatesForUser((provider as any)._userId || 0);
      const index=candidates.findIndex(p=>(p as any)._platform === (provider as any)._platform && p.defaultModel === provider.defaultModel);
      const fallback=index>=0 ? candidates[index+1] : undefined;
      if (!fallback) throw new Error('No explicitly approved assistant model fallback is available.');
      return {provider:fallback,deactivatedKey:null};
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (provider as any)._userId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const credentialId = (provider as any)._credentialId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const platform = (provider as any)._platform as AdminApiPlatform;
    
    if (!credentialId || !platform) {
      logger.error('[LLMProviderFactory] Cannot handle rate limit - missing provider metadata');
      throw error;
    }
    
    // Check if this is actually a rate limit error
    if (!isRateLimitError(error)) {
      throw error;
    }
    
    // Determine the specific reason
    const errorMessage = (error?.message || error?.error?.message || String(error)).toLowerCase();
    const errorCode = error?.status || error?.code || error?.error?.code;
    let reason = 'rate_limit';
    if (errorMessage.includes('quota') || errorMessage.includes('billing')) {
      reason = 'quota_exceeded';
    } else if (errorMessage.includes('429')) {
      reason = 'rate_limit_429';
    } else if (errorCode === 503 || errorCode === '503' || errorMessage.includes('service unavailable') || errorMessage.includes('high demand') || errorMessage.includes('overloaded')) {
      reason = 'service_overloaded';
    }
    
    logger.warn({ platform, credentialId, reason }, '[LLMProviderFactory] Rate limit hit for admin credential, marking as inactive');
    
    // Mark current credential as inactive with reason
    await markAdminCredentialInactive(credentialId, reason);
    
    const deactivatedKey = { platform, reason };
    
    // Clear cache to force fresh lookup
    this.clearCache();
    
    for (const nextCred of await getActiveLLMAdminCredentials()) {
      if (nextCred.id === credentialId) continue;
      const newProvider = this.createProviderInstance(nextCred.platform as RuntimeLLMPlatform, nextCred, userId || 0);
      if (!newProvider) continue;
      await updateAdminCredentialLastUsed(nextCred.id);
      logger.info({ credentialId: nextCred.id, platform: nextCred.platform, model: newProvider.defaultModel },
        '[LLMProviderFactory] Selected prioritized fallback');
      return { provider: newProvider, deactivatedKey };
    }
    
    // No active keys available at all
    throw new Error('All LLM API keys have hit rate limits or quota exceeded. Please contact an administrator to add more API keys.');
  }

  /**
   * Execute an LLM call with automatic fallback on rate limit errors
   * @param userId - User ID for tracking
   * @param callFn - Function that takes a provider and executes the LLM call
   * @param maxRetries - Maximum number of fallback attempts (default: 3)
   * @returns Result with data and any deactivated keys info
   */
  static async executeWithFallback<T>(
    userId: number,
    callFn: (provider: LLMProvider) => Promise<T>,
    maxRetries: number = 3
  ): Promise<{ result: T; deactivatedKeys: Array<{ platform: string; reason: string }> }> {
    let provider = await this.createProviderForUser(userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastError: any;
    const deactivatedKeys: Array<{ platform: string; reason: string }> = [];
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await assertAssistantFresh();
        const result = await callFn(provider);
        await assertAssistantFresh();
        return { result, deactivatedKeys };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        lastError = error;
        
        if (isRateLimitError(error)) {
          logger.warn({ attempt: attempt + 1 }, '[LLMProviderFactory] Rate limit on attempt, trying fallback');
          try {
            const fallbackResult = await this.handleRateLimitError(provider, error);
            provider = fallbackResult.provider;
            
            // Track deactivated key for notification
            if (fallbackResult.deactivatedKey) {
              deactivatedKeys.push(fallbackResult.deactivatedKey);
              logger.info({ platform: fallbackResult.deactivatedKey.platform, reason: fallbackResult.deactivatedKey.reason }, '[LLMProviderFactory] Admin API key deactivated');
            }
            
            continue; // Retry with new provider
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (fallbackError: any) {
            // Fallback failed, throw the original error with more context
            const errorWithDeactivations = new Error(`Rate limit exceeded and no fallback available: ${fallbackError.message}`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (errorWithDeactivations as any).deactivatedKeys = deactivatedKeys;
            throw errorWithDeactivations;
          }
        }
        
        // Not a rate limit error, throw immediately
        throw error;
      }
    }
    
    // Max retries reached
    const maxRetriesError = lastError || new Error('Max retries reached for LLM call');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (maxRetriesError as any).deactivatedKeys = deactivatedKeys;
    throw maxRetriesError;
  }

  /**
   * Get the default model based on admin credentials
   * Returns empty string if no model configured
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static async getDefaultModelForUser(userId?: number): Promise<string> {
    const [provider] = await this.createProviderCandidatesForUser(userId || 0);
    return provider?.defaultModel || '';
  }

  /**
   * Check if any LLM provider is configured (admin credentials)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static async hasUserCredentials(userId: number): Promise<boolean> {
    const adminCreds = await this.getAdminCredentials();
    return !!(adminCreds.openai?.apiKey || adminCreds.vertex_ai?.apiKey || adminCreds.gemini?.apiKey || adminCreds.openrouter?.apiKey);
  }

  /**
   * Check if admin has any LLM configured
   */
  static async hasAdminCredentials(): Promise<boolean> {
    const adminCreds = await this.getAdminCredentials();
    return !!(adminCreds.openai?.apiKey || adminCreds.vertex_ai?.apiKey || adminCreds.gemini?.apiKey || adminCreds.openrouter?.apiKey);
  }

  /**
   * Create an LLM provider based on PROVIDER environment variable
   * @deprecated Use createProviderForUser - this method throws an error
   */
  static createProvider(): LLMProvider {
    throw new Error('createProvider() is deprecated. Use createProviderForUser(userId) with admin credentials.');
  }

  /**
   * Get the default model to use
   * @deprecated Use getDefaultModelForUser - this method throws an error  
   */
  static getDefaultModel(): string {
    throw new Error('getDefaultModel() is deprecated. Use getDefaultModelForUser(userId) with admin credentials.');
  }

  /**
   * Get available providers (for UI/debugging)
   */
  static getAvailableProviders(): string[] {
    return ['openai', 'vertex_ai', 'gemini', 'openrouter', 'custom_ai'];
  }

  /**
   * Check if a specific provider is configured (admin-based)
   */
  static async isProviderConfigured(provider: 'openai' | 'openrouter' | 'custom_ai' | 'gemini' | 'vertex_ai'): Promise<boolean> {
    const adminCreds = await this.getAdminCredentials();
    if (provider === 'openai') {
      return !!adminCreds.openai?.apiKey;
    }
    if (provider === 'gemini') {
      return !!adminCreds.gemini?.apiKey;
    }
    if (provider === 'vertex_ai') {
      return !!adminCreds.vertex_ai?.apiKey;
    }
    if (provider === 'custom_ai') {
      return !!(adminCreds.custom_ai?.apiKey && adminCreds.custom_ai?.baseURL);
    }
    return !!adminCreds.openrouter?.apiKey;
  }
}

// Export the rate limit check function for use in provider implementations
export { isRateLimitError };
