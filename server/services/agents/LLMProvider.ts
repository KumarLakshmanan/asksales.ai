/**
 * LLM Provider Base Class
 * Abstract interface for different LLM providers (OpenAI, OpenRouter, etc.)
 * Provides unified API for chat completions, streaming, and token metering
 */

import { traceLangfuseGeneration, type LangfuseGenerationContext } from '../../infrastructure/langfuse.js';
import type { InsightsAttribution } from '../../../shared/insightsBilling.js';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { currentConversationRequest } from '../ConversationRequestCoordinator.js';
import { insightChannel, insightProcess, newUsageContext, validConversationRef, withUsageContext, currentUsageContext } from '../insights/UsageContext.js';
import { calculateMeteredLLMCost, llmPricingSnapshot } from '../insights/PricingService.js';

// Logging context passed to API calls
export interface LLMLoggingContext {
  userId?: number;
  threadId?: number;
  workflowId?: string;
  purpose: string; // e.g., "icp_generation", "intent_detection", "content_creation"
  service: string; // e.g., "ICPGenerationService", "MetaPromptEngine"
  action?: string; // e.g., "generate_icp", "detect_intent"
  metadata?: Record<string, unknown>;
  insights?: InsightsAttribution;
}

// Chat completion options
export interface LLMChatOptions {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response_format?: any;
  loggingContext?: LLMLoggingContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any; // Allow additional provider-specific options
}

// Chat completion response
export interface LLMResponse {
  success: boolean;
  content?: string;
  error?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  completion?: any; // Full completion object for advanced use cases
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// Streaming options
export interface LLMStreamOptions {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  onChunk: (chunk: string, sequence: number) => void;
  onComplete: (fullContent: string) => void;
  onError?: (error: string) => void;
  loggingContext?: LLMLoggingContext;
}

// Streaming response
export interface LLMStreamResponse {
  success: boolean;
  error?: string;
}

// Token counts for cost calculation
export interface TokenCounts {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Usage data for logging
export interface UsageData {
  userId?: number;
  threadId?: number;
  workflowId?: string;
  purpose: string;
  service: string;
  action?: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  requestSummary?: string;
  metadata?: Record<string, unknown>;
  provider: string; // 'openai' | 'openrouter'
  providerCostUsd?: number;
}

/**
 * Abstract LLM Provider
 * All provider implementations must extend this class
 */
export abstract class LLMProvider {
  protected disabled: boolean = false;
  protected abstract providerName: string;

  /** Direct callers and all five providers share the same metering boundary. */
  constructor() {
    return new Proxy(this, {
      get(target, key, receiver) {
        const method = Reflect.get(target, key, receiver);
        if (key === 'createChatCompletion' || key === 'createChatCompletionStream') {
          return (options: LLMChatOptions | LLMStreamOptions) => target.meterCall(options,
            prepared => Reflect.apply(method as (...args: unknown[]) => unknown, receiver, [prepared]) as Promise<unknown>);
        }
        return typeof method === 'function' ? method.bind(receiver) : method;
      },
    });
  }

  protected async meterCall<T extends LLMChatOptions | LLMStreamOptions, R>(options: T, work: (prepared: T) => Promise<R>): Promise<R> {
    const business = currentBusinessScope();
    if (!business) {
      await llmPricingSnapshot(options.model || this.defaultModel, this.providerName);
      return work(options);
    }
    if (options.loggingContext?.userId && options.loggingContext.userId !== business.userId)
      throw new Error('AI usage owner does not match the selected business.');
    const active = currentUsageContext();
    if (active && options.loggingContext?.metadata?._insightsAttemptId === active.attemptId && active.provider === this.providerName)
      return work(options);
    const request = currentConversationRequest();
    const supplied = options.loggingContext?.insights;
    let conversation = validConversationRef(supplied?.conversation);
    if (!conversation && request?.conversationId && request.conversationId > 0 && ['campaign', 'campaign_init'].includes(request.kind))
      conversation = { kind: 'workspace', id: request.conversationId };
    if (!conversation && request?.conversationId && request.conversationId > 0 && ['support_widget', 'widget'].includes(request.kind))
      conversation = { kind: 'widget', id: request.conversationId };
    if (!conversation && options.loggingContext?.threadId && options.loggingContext.threadId > 0)
      conversation = { kind: 'workspace', id: options.loggingContext.threadId };
    const purpose = options.loggingContext?.purpose || 'general_chat';
    const assistant = options.loggingContext?.metadata?.assistant as { assistantId?: string; channel?: string } | undefined;
    const context = newUsageContext({ ...supplied, provider: this.providerName, model: options.model || this.defaultModel,
      conversation, channel: supplied?.channel || insightChannel(options.loggingContext?.metadata?.channel || assistant?.channel),
      process: supplied?.process || insightProcess(purpose), operationId: supplied?.operationId || request?.requestId,
      agent: supplied?.agent || assistant?.assistantId,
    });
    context.pricing = await llmPricingSnapshot(context.model, context.provider);
    const prepared = { ...options, loggingContext: { ...options.loggingContext, userId: business.userId,
      purpose, service: options.loggingContext?.service || 'WorkspaceAI', insights: context,
      metadata: { ...options.loggingContext?.metadata, _insightsAttemptId: context.attemptId },
    } } as T;
    return withUsageContext(context, () => work(prepared));
  }
  
  /**
   * Default model to use for this provider
   */
  abstract readonly defaultModel: string;

  /**
   * Create a single chat completion
   */
  abstract createChatCompletion(options: LLMChatOptions): Promise<LLMResponse>;

  /**
   * Create a streaming chat completion
   */
  abstract createChatCompletionStream(options: LLMStreamOptions): Promise<LLMStreamResponse>;

  /**
   * Test connection to the provider
   */
  abstract testConnection(): Promise<boolean>;

  /**
   * Check if provider is disabled
   */
  isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Get provider name
   */
  getProviderName(): string {
    return this.providerName;
  }

  /**
   * Log usage to database
   * Protected method to be used by implementations
   */
  protected abstract logUsage(data: UsageData): Promise<void>;

  /**
   * Calculate cost in cents based on token usage
   * Protected method to be used by implementations
   */
  protected async calculateCost(model: string, tokens: TokenCounts): Promise<number> {
    return calculateMeteredLLMCost(model, tokens);
  }

  /**
   * Wrap a direct LLM API call with a Langfuse generation span.
   * Safe to call even when Langfuse is disabled — the fn() result is returned unchanged.
   *
   * @param options  Trace metadata (model, messages, loggingContext)
   * @param fn       The actual API call that returns an LLMResponse
   */
  protected async traceWithLangfuse(
    options: {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      maxTokens?: number;
      loggingContext?: LLMLoggingContext;
    },
    fn: () => Promise<LLMResponse>,
  ): Promise<LLMResponse> {
    const ctx = options.loggingContext;
    if (!ctx?.userId) return fn();

    const langfuseCtx: LangfuseGenerationContext = {
      userId:   ctx.userId,
      threadId: ctx.threadId,
      purpose:  ctx.purpose,
      service:  ctx.service,
      action:   ctx.action,
      provider: this.providerName,
    };

    // The tracing layer owns telemetry failures. Never replay a provider operation
    // from a generic catch: it may already have succeeded and incurred a charge.
    return traceLangfuseGeneration(
      { context: langfuseCtx, model: options.model, messages: options.messages,
        temperature: options.temperature, maxTokens: options.maxTokens },
      fn,
    );
  }

  /**
   * Generate a brief summary of the request for logging
   */
  protected generateRequestSummary(messages: Array<{ role: string; content: string }>): string {
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (lastUserMsg) {
      // Take first 100 chars of user message
      return lastUserMsg.content.substring(0, 100) + (lastUserMsg.content.length > 100 ? '...' : '');
    }
    return `${messages.length} messages`;
  }
}
