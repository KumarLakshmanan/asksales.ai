/**
 * OpenRouter Provider
 * OpenRouter is OpenAI-compatible, so we use the OpenAI SDK with custom base URL
 * Supports multiple LLM providers through a single API
 */

import OpenAI from "openai";
import type { LLMChatOptions, LLMResponse, LLMStreamOptions, LLMStreamResponse, UsageData, TokenCounts } from "./LLMProvider";
import { LLMProvider } from "./LLMProvider";
import { createLLMUsage } from "../../models/llmUsages/functions";
import { logger } from "../../utils/logger.js";
import { calculateMeteredLLMCost, llmPricingSnapshot } from '../insights/PricingService.js';
import { currentUsageContext, newUsageContext, withUsageContext } from '../insights/UsageContext.js';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { normalizeLLMModelName } from "../../utils/llmConstants";
import { LLM_REQUEST_TIMEOUT_MS } from "../../utils/timingConstants.js";
import { INTENT_TIMEOUT_MS } from './intent/intentClassifierConfig.js';
import type { DecisionQuestions } from './intent/decisionContract.js';
import { parseOpenRouterAffordableOutputCap, safeLLMProviderFailureMessage } from './LLMProviderErrors.js';

const configuredOpenRouterMaxOutputTokens = Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS || 8192);
const OPENROUTER_MAX_OUTPUT_TOKENS = Number.isFinite(configuredOpenRouterMaxOutputTokens)
  ? Math.max(256, Math.min(32_768, Math.trunc(configuredOpenRouterMaxOutputTokens)))
  : 8192;

function boundOpenRouterOutput<T extends { max_tokens?: number }>(options: T): T {
  // An omitted limit lets OpenRouter reserve the model's full output budget
  // (e.g. 65,536 tokens), which can produce a 402 on a funded account.
  const requested = options.max_tokens;
  const maxTokens = typeof requested === 'number' && Number.isFinite(requested) && requested >= 1
    ? Math.min(Math.floor(requested), OPENROUTER_MAX_OUTPUT_TOKENS)
    : OPENROUTER_MAX_OUTPUT_TOKENS;
  return { ...options, max_tokens: maxTokens };
}

export class OpenRouterProvider extends LLMProvider {
  private client: OpenAI | null;
  protected providerName = "openrouter";
  readonly defaultModel: string;

  constructor(apiKey?: string, defaultModel?: string) {
    super();

    // Only use explicitly provided API key, no env fallback
    const key = apiKey;
    // Only use explicitly provided model, no default fallback
    this.defaultModel = normalizeLLMModelName("openrouter", defaultModel);

    if (!key) {
      logger.warn(
        "[OpenRouterProvider] No API key provided; OpenRouterProvider is disabled",
      );
      this.client = null;
      this.disabled = true;
      return;
    }

    // OpenRouter uses OpenAI SDK with custom base URL
    this.client = new OpenAI({
      apiKey: key,
      baseURL: "https://openrouter.ai/api/v1",
      timeout: LLM_REQUEST_TIMEOUT_MS,
      // The provider factory owns fallback; avoid multiplying this timeout with
      // hidden SDK retries while an approved widget is waiting for completion.
      maxRetries: 0,
      defaultHeaders: {
        "HTTP-Referer": process.env.CLIENT_URL || process.env.FRONTEND_URL,
        "X-Title": "Sales & Marketing Platform",
      },
    });
    this.disabled = false;
  }

  /**
   * Get the default model configured for this service
   */
  getDefaultModel(): string {
    return this.defaultModel;
  }

  /** OpenRouter alpha Decisions contract (not OpenAI chat-completions). */
  async createIntentDecisions(state: unknown, questions: DecisionQuestions, loggingContext: LLMChatOptions['loggingContext']): Promise<unknown> {
    const client = this.client;
    if (!client || this.disabled) throw new Error('Intent classifier credential unavailable');
    const business=currentBusinessScope();
    const context=business?newUsageContext({provider:'openrouter',model:this.defaultModel,process:'routing',
      conversation:loggingContext?.insights?.conversation,channel:loggingContext?.insights?.channel,
      contactId:loggingContext?.insights?.contactId,agent:loggingContext?.insights?.agent}):undefined;
    if(context)context.pricing=await llmPricingSnapshot(this.defaultModel,'openrouter');
    const execute=async()=>{
    const started = Date.now();
    let usage: { input_tokens?: number; output_tokens?: number; cost?: number } = {};
    let resolvedModel = this.defaultModel;
    let success = false;
    try {
      const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${client.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'AskSales Intent Classifier' },
        body: JSON.stringify({ model: this.defaultModel, state, questions }),
        signal: AbortSignal.timeout(INTENT_TIMEOUT_MS),
      });
      // Never log upstream bodies: they may contain customer data or credentials.
      if (!response.ok) throw new Error(`Intent classifier HTTP ${response.status}`);
      const result = await response.json() as { model?: string; usage?: typeof usage };
      if (result.usage) usage = result.usage;
      if (typeof result.model === 'string') resolvedModel = result.model;
      success = true;
      return result;
    } finally {
      const inputTokens = Number.isSafeInteger(usage.input_tokens) && usage.input_tokens! >= 0 ? usage.input_tokens! : 0;
      const outputTokens = Number.isSafeInteger(usage.output_tokens) && usage.output_tokens! >= 0 ? usage.output_tokens! : 0;
      // Provider-reported cost is authoritative. Version's published price is
      // used only if optional usage.cost is absent. Do not apply chat-model pricing.
      const costUsd = typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0
        ? usage.cost : inputTokens * 0.042 / 1_000_000;
      if(context?.pricing) context.pricing={...context.pricing,source:'provider_reported',sourceReference:'openrouter_alpha_decisions_usage',
        model:resolvedModel,marginPercentage:0,providerCostUsd:costUsd.toFixed(10),chargedCostUsd:costUsd.toFixed(10)};
      if (loggingContext||business) await this.logUsage({
        ...loggingContext,userId:loggingContext?.userId||business?.userId,purpose:loggingContext?.purpose||'intent_classification',
        service:loggingContext?.service||'IntentClassifier',model:resolvedModel,provider:'openrouter',
        promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens,
        durationMs: Date.now() - started, success,
        errorMessage: success ? undefined : 'Decisions request unavailable',
        metadata: { endpoint: 'alpha/decisions', classifierCostUsd: costUsd, requestedModel: this.defaultModel },
      });
    }
    };
    return context?withUsageContext(context,execute):execute();
  }

  /**
   * Create a single chat completion
   */
  async createChatCompletion(options: LLMChatOptions): Promise<LLMResponse> {
    const boundedOptions = boundOpenRouterOutput(options);
    return this.traceWithLangfuse(
      {
        model:          boundedOptions.model,
        messages:       boundedOptions.messages,
        temperature:    boundedOptions.temperature,
        maxTokens:      boundedOptions.max_tokens,
        loggingContext: boundedOptions.loggingContext,
      },
      async () => {
    const startTime = Date.now();
    const { loggingContext, ...apiOptions } = boundedOptions;
    // These short JSON verification tasks need a visible answer. Keep reasoning
    // bounded so it cannot consume the output budget. Apply the gateway
    // option here, not to other providers which may reject OpenRouter fields.
    if (['knowledge_extractive_repair', 'response_grounding', 'campaign_email_reply_verification'].includes(loggingContext?.purpose || '') && !apiOptions.reasoning) {
      apiOptions.reasoning = { effort: 'low' };
    }

    try {
      if (this.disabled || !this.client) {
        // Log failure if context provided
        if (loggingContext) {
          await this.logUsage({
            ...loggingContext,
            model: options.model,
            durationMs: Date.now() - startTime,
            success: false,
            errorMessage: "OpenRouter client not configured",
            provider: this.providerName,
          });
        }
        return { success: false, error: "OpenRouter client not configured" };
      }

      let completion;
      try {
        completion = await this.client.chat.completions.create(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          apiOptions as any,
        );
      } catch (error) {
        const requestedMaxTokens = boundedOptions.max_tokens;
        const affordableCap = typeof requestedMaxTokens === 'number'
          ? parseOpenRouterAffordableOutputCap(error, requestedMaxTokens)
          : null;
        if (!affordableCap) throw error;

        logger.info({
          model: options.model,
          requestedMaxTokens,
          retryMaxTokens: affordableCap,
        }, '[OpenRouterProvider] Retrying once with the reported affordable output cap');
        completion = await this.client.chat.completions.create({
          ...apiOptions,
          max_tokens: affordableCap,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
      }
      const rawContent = completion?.choices?.[0]?.message?.content;
      const toolCalls = completion?.choices?.[0]?.message?.tool_calls;
      const hasVisibleAnswer = typeof rawContent === 'string' && rawContent.trim().length > 0;
      const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

      // Extract usage information
      const usage = completion?.usage;
      const promptTokens = usage?.prompt_tokens || 0;
      const completionTokens = usage?.completion_tokens || 0;
      const totalTokens = usage?.total_tokens || 0;
      const metering=currentUsageContext();
      if(metering){metering.cachedTokens=usage?.prompt_tokens_details?.cached_tokens||0;
        metering.reasoningTokens=usage?.completion_tokens_details?.reasoning_tokens||0;}
      const reportedUsd = (usage as { cost?: unknown } | undefined)?.cost;

      const hasAnswer = hasVisibleAnswer || hasToolCalls;
      const emptyAnswerError = 'OpenRouter returned no visible completion content. Please retry or use another configured provider.';

      // An HTTP success with no visible response is still a failed completion.
      if (loggingContext) {
        await this.logUsage({
          ...loggingContext,
          model: options.model,
          promptTokens,
          completionTokens,
          totalTokens,
          providerCostUsd: typeof reportedUsd==='number'&&Number.isFinite(reportedUsd)&&reportedUsd>=0?reportedUsd:undefined,
          durationMs: Date.now() - startTime,
          success: hasAnswer,
          errorMessage: hasAnswer ? undefined : emptyAnswerError,
          requestSummary: this.generateRequestSummary(boundedOptions.messages),
          provider: this.providerName,
        });
      }

      // Check if we have either content or tool calls
      if (!hasAnswer) {
        logger.warn({
          purpose: loggingContext?.purpose,
          model: options.model,
          finishReason: completion?.choices?.[0]?.finish_reason,
          maxTokens: boundedOptions.max_tokens,
          completionTokens,
          reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
        }, '[OpenRouterProvider] Completion returned no visible answer');
        return { success: false, error: emptyAnswerError };
      }

      return {
        success: true,
        content: rawContent || undefined,
        completion,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
        },
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      // Log error if context provided
      if (loggingContext) {
        await this.logUsage({
          ...loggingContext,
          model: options.model,
          durationMs: Date.now() - startTime,
          success: false,
          errorMessage: safeLLMProviderFailureMessage(error, this.providerName),
          requestSummary: this.generateRequestSummary(boundedOptions.messages),
          provider: this.providerName,
        });
      }
      return {
        success: false,
        error: safeLLMProviderFailureMessage(error, this.providerName),
      };
    }
      }, // end traceWithLangfuse lambda
    ); // end traceWithLangfuse
  }

  /**
   * Create a streaming chat completion
   */
  async createChatCompletionStream(
    options: LLMStreamOptions,
  ): Promise<LLMStreamResponse> {
    const boundedOptions = boundOpenRouterOutput(options);
    const startTime = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { loggingContext, onChunk, onComplete, onError, ...apiOptions } =
      boundedOptions;

    try {
      if (this.disabled || !this.client) {
        const error = "OpenRouter client not configured";
        // Log failure if context provided
        if (loggingContext) {
          await this.logUsage({
            ...loggingContext,
            model: options.model,
            durationMs: Date.now() - startTime,
            success: false,
            errorMessage: error,
            provider: this.providerName,
          });
        }
        onError?.(error);
        return { success: false, error };
      }

      const stream = await this.client.chat.completions.create({
        model: boundedOptions.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: boundedOptions.messages as any,
        temperature: boundedOptions.temperature,
        max_tokens: boundedOptions.max_tokens,
        stream: true,
        stream_options: { include_usage: true },
      });

      let fullContent = "";
      let sequence = 0;
      let streamUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;cost?:number;
        prompt_tokens_details?:{cached_tokens?:number};completion_tokens_details?:{reasoning_tokens?:number} } | null = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          onChunk(delta, sequence++);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((chunk as any).usage) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          streamUsage = (chunk as any).usage;
        }
      }

      const streamedMetering=currentUsageContext();
      if(streamedMetering){streamedMetering.cachedTokens=streamUsage?.prompt_tokens_details?.cached_tokens||0;
        streamedMetering.reasoningTokens=streamUsage?.completion_tokens_details?.reasoning_tokens||0;}

      if (fullContent.trim().length === 0) {
        const error = 'OpenRouter returned no visible completion content. Please retry or use another configured provider.';
        if (loggingContext) {
          const promptTokens = streamUsage?.prompt_tokens || Math.round(JSON.stringify(boundedOptions.messages).length / 4);
          const completionTokens = streamUsage?.completion_tokens || 0;
          await this.logUsage({
            ...loggingContext,
            model: options.model,
            promptTokens,
            completionTokens,
            totalTokens: streamUsage?.total_tokens || promptTokens + completionTokens,
            providerCostUsd:typeof streamUsage?.cost==='number'&&Number.isFinite(streamUsage.cost)&&streamUsage.cost>=0?streamUsage.cost:undefined,
            durationMs: Date.now() - startTime,
            success: false,
            errorMessage: error,
            requestSummary: this.generateRequestSummary(boundedOptions.messages),
            metadata: { ...loggingContext.metadata, streaming: true },
            provider: this.providerName,
          });
        }
        onError?.(error);
        return { success: false, error };
      }

      // Log successful streaming call if context provided
      if (loggingContext) {
        const promptTokens = streamUsage?.prompt_tokens || Math.round(JSON.stringify(boundedOptions.messages).length / 4);
        const completionTokens = streamUsage?.completion_tokens || Math.round(fullContent.length / 4);
        const totalTokens = streamUsage?.total_tokens || (promptTokens + completionTokens);
        await this.logUsage({
          ...loggingContext,
          model: options.model,
          promptTokens,
          completionTokens,
          totalTokens,
          providerCostUsd:typeof streamUsage?.cost==='number'&&Number.isFinite(streamUsage.cost)&&streamUsage.cost>=0?streamUsage.cost:undefined,
          durationMs: Date.now() - startTime,
          success: true,
          requestSummary: this.generateRequestSummary(boundedOptions.messages),
          metadata: { ...loggingContext.metadata, streaming: true },
          provider: this.providerName,
        });
      }

      onComplete(fullContent);
      return { success: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      const errorMsg = safeLLMProviderFailureMessage(error, this.providerName);
      // Log error if context provided
      if (loggingContext) {
        await this.logUsage({
          ...loggingContext,
          model: options.model,
          durationMs: Date.now() - startTime,
          success: false,
          errorMessage: errorMsg,
          requestSummary: this.generateRequestSummary(boundedOptions.messages),
          provider: this.providerName,
        });
      }
      onError?.(errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Test connection to OpenRouter
   */
  async testConnection(): Promise<boolean> {
    try {
      if (this.disabled || !this.client) {
        logger.warn(
          "[OpenRouterProvider] Connection test skipped - OpenRouter client not configured",
        );
        return false;
      }

      if (!this.defaultModel) {
        logger.warn(
          "[OpenRouterProvider] Connection test skipped - No model configured",
        );
        return false;
      }

      const response = await this.createChatCompletion({
        model: this.defaultModel,
        messages: [{ role: "user", content: "Test connection" }],
        max_tokens: 10,
      });
      return response.success;
    } catch (error) {
      logger.error(
        { err: error },
        "[OpenRouterProvider] Connection test failed",
      );
      return false;
    }
  }

  /**
   * Calculate original provider cost in cents
   */
  protected async calculateOriginalCost(model: string, tokens: TokenCounts): Promise<number> {
    return calculateMeteredLLMCost(model, tokens, true);
  }

  /**
   * Log usage to database
   */
  protected async logUsage(data: UsageData): Promise<void> {
    if (!data.userId) return; // userId required for DB insert
    try {
      const decisionCost = data.metadata?.endpoint === 'alpha/decisions' && typeof data.metadata.classifierCostUsd === 'number'
        ? data.metadata.classifierCostUsd * 100 : undefined;
      const reportedCost=typeof data.providerCostUsd==='number'&&Number.isFinite(data.providerCostUsd)&&data.providerCostUsd>=0
        ? data.providerCostUsd:undefined;
      const pricing=currentUsageContext()?.pricing;
      const reportedChargeCents=reportedCost===undefined?undefined:reportedCost*100*(1+(pricing?.marginPercentage||0)/100);
      if(pricing&&reportedCost!==undefined)currentUsageContext()!.pricing={...pricing,source:'provider_reported',sourceReference:'openrouter_usage_cost',
        providerCostUsd:reportedCost.toFixed(10),chargedCostUsd:(reportedChargeCents!/100).toFixed(10)};
      const rawCostCents = decisionCost ?? reportedChargeCents ?? await this.calculateCost(data.model, {
        promptTokens: data.promptTokens || 0,
        completionTokens: data.completionTokens || 0,
        totalTokens: data.totalTokens || 0,
      });
      const estimatedCostCents = rawCostCents;

      await createLLMUsage({
        userId: data.userId,
        threadId: data.threadId || null,
        workflowId: data.workflowId || null,
        model: data.model,
        provider: data.provider,
        purpose: data.purpose,
        service: data.service,
        action: data.action || null,
        promptTokens: data.promptTokens || null,
        completionTokens: data.completionTokens || null,
        totalTokens: data.totalTokens || null,
        estimatedCostCents,
        requestSummary: data.requestSummary || null,
        responseSuccess: data.success ? 1 : 0,
        errorMessage: data.errorMessage || null,
        durationMs: data.durationMs,
        metadata: data.metadata || null,
      });
      logger.info(
        {
          purpose: data.purpose,
          model: data.model,
          totalTokens0: data.totalTokens || 0,
        },
        "[OpenRouterProvider] Logged usage: - - tokens",
      );

      // Deduct credits for this API call (pass raw fractional cents for accurate credit calculation)
      if (data.userId) {
        const rawOriginalCostCents = decisionCost ?? (reportedCost===undefined?undefined:reportedCost*100) ?? await this.calculateOriginalCost(data.model, {
          promptTokens: data.promptTokens || 0,
          completionTokens: data.completionTokens || 0,
          totalTokens: data.totalTokens || 0,
        });
        const { deductCreditsForLLMUsage } = await import(
          "../CreditDeductionHooks.js"
        );
        await deductCreditsForLLMUsage(data.userId, {
          model: data.model,
          provider: data.provider,
          purpose: data.purpose,
          service: data.service,
          estimatedCostCents: rawCostCents,
          originalCostCents: rawOriginalCostCents,
          promptTokens: data.promptTokens,
          completionTokens: data.completionTokens,
          totalTokens: data.totalTokens,
          threadId: data.threadId || null,
        });
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, "[OpenRouterProvider] Failed to log usage");
    }
  }
}
