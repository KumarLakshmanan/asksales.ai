import {
  getAllActiveAdminCredentials,
  updateAdminCredentialLastUsed,
} from '../../models/adminApiCredentials/functions.js';
import { createOpenAIUsage } from '../../models/openaiUsages/functions.js';
import { getInsightsRuntime } from '../insights/RuntimeService.js';
import { llmPricingSnapshot } from '../insights/PricingService.js';
import { configString, calculateCost, jsonRequest, type CredentialConfig } from './providerRequest.js';
import { assistantModelProviderLabels, platformAIQuotaMessage } from '../../../shared/assistantModelCatalog.js';
import { quotaDisabledAIProviders } from '../assistants/AssistantModelCatalogService.js';

export const AI_VISIBILITY_OBSERVATION_PROVIDERS = ['openai', 'gemini'] as const;
export type ObservationProvider = (typeof AI_VISIBILITY_OBSERVATION_PROVIDERS)[number];

export interface ProviderObservation {
  provider: ObservationProvider;
  model: string;
  fidelity: 'live_api';
  status: 'completed' | 'failed';
  answer?: string;
  citations: Array<{ url: string; title?: string }>;
  inputTokens?: number;
  outputTokens?: number;
  costCents: number;
  error?: string;
}

function uniqueCitations(
  values: Array<{ url?: unknown; title?: unknown }>,
): Array<{ url: string; title?: string }> {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (typeof value.url !== 'string' || !/^https?:\/\//i.test(value.url) || seen.has(value.url))
      return [];
    seen.add(value.url);
    return [
      {
        url: value.url,
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
      },
    ];
  });
}

const GROUNDING_REDIRECT_HOST = 'vertexaisearch.cloud.google.com';

/**
 * Gemini's Google Search grounding cites `vertexaisearch.cloud.google.com/grounding-api-redirect/…`
 * links instead of the pages themselves. Citation analysis compares domains, so follow each
 * redirect once to store the real page. A link that can't be resolved is kept as it was.
 */
export async function resolveGroundingRedirects(
  citations: Array<{ url: string; title?: string }>,
  fetcher: typeof fetch = fetch,
): Promise<Array<{ url: string; title?: string }>> {
  const resolved = await Promise.all(
    citations.map(async (citation) => {
      let host = '';
      try {
        host = new URL(citation.url).hostname;
      } catch {
        return citation;
      }
      if (host !== GROUNDING_REDIRECT_HOST) return citation;
      try {
        const response = await fetcher(citation.url, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(5_000),
        });
        const location = response.headers.get('location');
        const target = location ? new URL(location, citation.url) : null;
        return target && /^https?:$/.test(target.protocol) && target.hostname !== GROUNDING_REDIRECT_HOST
          ? { ...citation, url: target.href }
          : citation;
      } catch {
        return citation;
      }
    }),
  );
  return uniqueCitations(resolved);
}

/**
 * When a provider has no working direct key, its answers come from the same model family
 * through OpenRouter with web search on: OpenAI models use OpenAI's own search there, and
 * Gemini 3 models use Google's. Admins can change either model on the OpenRouter credential.
 */
const OPENROUTER_MODEL: Record<ObservationProvider, { key: string; fallback: string }> = {
  openai: { key: 'aiVisibilityOpenAiModel', fallback: 'openai/gpt-4.1-mini' },
  gemini: { key: 'aiVisibilityGeminiModel', fallback: 'google/gemini-3.1-flash-lite' },
};

function openRouterModel(provider: ObservationProvider, config: CredentialConfig) {
  const { key, fallback } = OPENROUTER_MODEL[provider];
  return configString(config, key, fallback);
}

/** OpenRouter reports the billed amount in US dollars; fall back to configured token rates. */
function openRouterCostCents(
  usage: Record<string, unknown>,
  config: CredentialConfig,
  inputTokens?: number,
  outputTokens?: number,
): number {
  const billedDollars = Number(usage.cost);
  return Number.isFinite(billedDollars) && billedDollars >= 0
    ? billedDollars * 100
    : calculateCost(config, inputTokens, outputTokens);
}

export class ProviderObservationService {
  async readiness() {
    const models = await Promise.all(AI_VISIBILITY_OBSERVATION_PROVIDERS.map(provider => this.getConfiguredModel(provider)));
    const quotaProviders = models.includes(null)
      ? await quotaDisabledAIProviders([...AI_VISIBILITY_OBSERVATION_PROVIDERS, 'openrouter'])
      : [];
    return AI_VISIBILITY_OBSERVATION_PROVIDERS.map((provider, index) => {
        const model = models[index];
        const affected = quotaProviders.filter(label => label === assistantModelProviderLabels[provider] || label === assistantModelProviderLabels.openrouter);
        const quotaBlocked = model === null && affected.length > 0;
        return {
          provider,
          model,
          configured: model !== null,
          status: model ? 'configured' : 'unavailable',
          quotaBlocked,
          reason: model
            ? 'It is asked in the next analysis. Whether it answers is known only once that analysis runs.'
            : quotaBlocked ? platformAIQuotaMessage(affected)
              : 'An AskSales administrator needs to add an API key for this AI engine before it can be asked.',
        };
    });
  }

  async getConfiguredModel(provider: ObservationProvider): Promise<string | null> {
    const credential = (await getAllActiveAdminCredentials(provider)).find((item) =>
      item.apiKey?.trim(),
    );
    if (credential?.apiKey) {
      const fallback = provider === 'openai' ? 'gpt-4.1-mini' : 'gemini-2.5-flash';
      return configString(credential.config as CredentialConfig, 'model', fallback);
    }
    const openRouter = (await getAllActiveAdminCredentials('openrouter')).find((item) =>
      item.apiKey?.trim(),
    );
    return openRouter?.apiKey
      ? `${openRouterModel(provider, openRouter.config as CredentialConfig)} via openrouter`
      : null;
  }

  async collect(
    provider: ObservationProvider,
    prompt: string,
    locale: string,
    context: { userId: number; auditId: number },
  ): Promise<ProviderObservation> {
    const direct = (await getAllActiveAdminCredentials(provider)).filter((credential) =>
      Boolean(credential.apiKey),
    );
    const openRouter = (await getAllActiveAdminCredentials('openrouter')).filter((credential) =>
      Boolean(credential.apiKey),
    );
    // Direct keys first; OpenRouter answers when there is none or every direct key fails.
    const attempts = [
      ...direct.map((credential) => ({ credential, transport: 'direct_api' as const })),
      ...openRouter.map((credential) => ({ credential, transport: 'openrouter' as const })),
    ];
    if (!attempts.length) {
      return {
        provider,
        model: 'unconfigured',
        fidelity: 'live_api',
        status: 'failed',
        citations: [],
        costCents: 0,
        error: `${provider} API credential is not configured.`,
      };
    }
    const failures: string[] = [];
    let lastFailure: ProviderObservation | null = null;
    for (const [credentialIndex, { credential, transport }] of attempts.entries()) {
      const startedAt = Date.now();
      let observation: ProviderObservation;
      const config = credential.config as CredentialConfig;
      const requestedModel =
        transport === 'openrouter'
          ? openRouterModel(provider, config)
          : configString(config, 'model', provider === 'openai' ? 'gpt-4.1-mini' : 'gemini-2.5-flash');
      try {
        if ((await getInsightsRuntime()).pricingGuardEnabled)
          await llmPricingSnapshot(requestedModel, transport === 'openrouter' ? 'openrouter' : provider);
        if (transport === 'openrouter')
          observation = await this.viaOpenRouter(provider, credential.apiKey, config, prompt, locale);
        else if (provider === 'openai')
          observation = await this.openAi(
            credential.apiKey,
            credential.config as CredentialConfig,
            prompt,
            locale,
          );
        else
          observation = await this.gemini(
            credential.apiKey,
            credential.config as CredentialConfig,
            prompt,
            locale,
          );
      } catch (error) {
        const message = error instanceof Error ? error.message : `${provider} request failed`;
        failures.push(message);
        observation = {
          provider,
          model: transport === 'openrouter' ? `${requestedModel} via openrouter` : requestedModel,
          fidelity: 'live_api',
          status: 'failed',
          citations: [],
          costCents: 0,
          error: message,
        };
        lastFailure = observation;
      }
      await Promise.allSettled([
        updateAdminCredentialLastUsed(credential.id),
        createOpenAIUsage({
          userId: context.userId,
          model: observation.model,
          provider,
          purpose: 'ai_visibility_provider_observation',
          service: 'AIVisibilityAudit',
          action: `Audit ${context.auditId} provider observation`,
          promptTokens: observation.inputTokens,
          completionTokens: observation.outputTokens,
          totalTokens: (observation.inputTokens || 0) + (observation.outputTokens || 0),
          estimatedCostCents: observation.costCents,
          requestSummary: `AI Visibility ${provider} observation (${locale})`,
          responseSuccess: observation.status === 'completed' ? 1 : 0,
          errorMessage: observation.error,
          durationMs: Date.now() - startedAt,
          metadata: {
            auditId: context.auditId,
            fidelity: observation.fidelity,
            citationCount: observation.citations.length,
            credentialAttempt: credentialIndex + 1,
            credentialCount: attempts.length,
            transport,
          },
        }),
      ]);
      if (observation.status === 'completed') return observation;
    }
    return {
      ...(lastFailure || {
        provider,
        model: 'unknown',
        fidelity: 'live_api' as const,
        citations: [],
        costCents: 0,
      }),
      status: 'failed',
      error: [...new Set(failures)].join(' | ') || `${provider} request failed`,
    };
  }

  private async openAi(
    apiKey: string,
    config: CredentialConfig,
    prompt: string,
    locale: string,
  ): Promise<ProviderObservation> {
    const model = configString(config, 'model', 'gpt-4.1-mini');
    const data = await jsonRequest('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: `Answer for a user whose locale is ${locale}. Use current web sources where available.\n\n${prompt}`,
        tools: [{ type: 'web_search_preview' }],
      }),
    });
    const output = Array.isArray(data.output)
      ? (data.output as Array<Record<string, unknown>>)
      : [];
    const content = output.flatMap((item) =>
      Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : [],
    );
    const answer =
      typeof data.output_text === 'string'
        ? data.output_text
        : content
            .map((item) => (typeof item.text === 'string' ? item.text : ''))
            .filter(Boolean)
            .join('\n');
    const annotations = content.flatMap((item) =>
      Array.isArray(item.annotations) ? (item.annotations as Array<Record<string, unknown>>) : [],
    );
    const citations = uniqueCitations(
      annotations.map((item) => ({ url: item.url, title: item.title })),
    );
    const usage = (data.usage || {}) as Record<string, unknown>;
    const inputTokens = Number(usage.input_tokens || 0) || undefined;
    const outputTokens = Number(usage.output_tokens || 0) || undefined;
    return {
      provider: 'openai',
      model,
      fidelity: 'live_api',
      status: 'completed',
      answer,
      citations,
      inputTokens,
      outputTokens,
      costCents: calculateCost(config, inputTokens, outputTokens),
    };
  }

  private async viaOpenRouter(
    provider: ObservationProvider,
    apiKey: string,
    config: CredentialConfig,
    prompt: string,
    locale: string,
  ): Promise<ProviderObservation> {
    const requestedModel = openRouterModel(provider, config);
    const data = await jsonRequest('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://asksales.ai',
        'X-Title': 'AskSales AI Visibility',
      },
      body: JSON.stringify({
        model: requestedModel,
        messages: [
          {
            role: 'user',
            content: `Answer for a user whose locale is ${locale}. Use current web sources where available.\n\n${prompt}`,
          },
        ],
        // The provider's own search where OpenRouter supports it, otherwise OpenRouter's.
        plugins: [{ id: 'web', max_results: 5 }],
        max_tokens: 1600,
      }),
    });
    const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : [];
    const message = (choices[0]?.message || {}) as Record<string, unknown>;
    const answer = typeof message.content === 'string' ? message.content : '';
    if (!answer.trim()) throw new Error(`OpenRouter returned no ${provider} answer.`);
    const annotations = Array.isArray(message.annotations)
      ? (message.annotations as Array<Record<string, unknown>>)
      : [];
    const citations = await resolveGroundingRedirects(
      uniqueCitations(
        annotations.map((annotation) => {
          const citation = (annotation.url_citation || {}) as Record<string, unknown>;
          return { url: citation.url, title: citation.title };
        }),
      ),
    );
    const usage = (data.usage || {}) as Record<string, unknown>;
    const inputTokens = Number(usage.prompt_tokens || 0) || undefined;
    const outputTokens = Number(usage.completion_tokens || 0) || undefined;
    const servedModel =
      typeof data.model === 'string' && data.model.trim() ? data.model.trim() : requestedModel;
    return {
      provider,
      model: `${servedModel} via openrouter`,
      fidelity: 'live_api',
      status: 'completed',
      answer,
      citations,
      inputTokens,
      outputTokens,
      costCents: openRouterCostCents(usage, config, inputTokens, outputTokens),
    };
  }

  private async gemini(
    apiKey: string,
    config: CredentialConfig,
    prompt: string,
    locale: string,
  ): Promise<ProviderObservation> {
    const model = configString(config, 'model', 'gemini-2.5-flash');
    const data = await jsonRequest(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `Locale: ${locale}\n${prompt}` }] }],
          tools: [{ google_search: {} }],
        }),
      },
    );
    const candidates = Array.isArray(data.candidates)
      ? (data.candidates as Array<Record<string, unknown>>)
      : [];
    const candidate = candidates[0] || {};
    const content = (candidate.content || {}) as Record<string, unknown>;
    const parts = Array.isArray(content.parts)
      ? (content.parts as Array<Record<string, unknown>>)
      : [];
    const answer = parts
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
    const grounding = (candidate.groundingMetadata || {}) as Record<string, unknown>;
    const chunks = Array.isArray(grounding.groundingChunks)
      ? (grounding.groundingChunks as Array<Record<string, unknown>>)
      : [];
    const citations = await resolveGroundingRedirects(
      uniqueCitations(
        chunks.map((chunk) => {
          const web = (chunk.web || {}) as Record<string, unknown>;
          return { url: web.uri, title: web.title };
        }),
      ),
    );
    const usage = (data.usageMetadata || {}) as Record<string, unknown>;
    const inputTokens = Number(usage.promptTokenCount || 0) || undefined;
    const outputTokens = Number(usage.candidatesTokenCount || 0) || undefined;
    return {
      provider: 'gemini',
      model,
      fidelity: 'live_api',
      status: 'completed',
      answer,
      citations,
      inputTokens,
      outputTokens,
      costCents: calculateCost(config, inputTokens, outputTokens),
    };
  }
}

export const providerObservationService = new ProviderObservationService();
