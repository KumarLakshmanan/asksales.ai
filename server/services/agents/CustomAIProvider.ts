/**
 * Custom AI Provider
 * Supports any OpenAI-compatible API endpoint with a custom base URL.
 * Uses the OpenAI SDK with user-specified base URL (e.g., Azure OpenAI, local LLMs, vLLM, Ollama, etc.)
 */

import OpenAI from "openai";
import type {
  LLMChatOptions,
  LLMResponse,
  LLMStreamOptions,
  LLMStreamResponse,
  UsageData,
  TokenCounts,
} from "./LLMProvider";
import { LLMProvider } from "./LLMProvider";
import { createLLMUsage } from "../../models/llmUsages/functions";
import { calculateMeteredLLMCost } from "../insights/PricingService.js";
import { currentUsageContext } from '../insights/UsageContext.js';
import { logger } from "../../utils/logger.js";
import { LLM_REQUEST_TIMEOUT_MS } from "../../utils/timingConstants.js";

export class CustomAIProvider extends LLMProvider {
  private client: OpenAI | null;
  protected providerName = "custom_ai";
  readonly defaultModel: string;
  private baseURL: string;

  constructor(apiKey?: string, baseURL?: string, defaultModel?: string) {
    super();

    const key = apiKey;
    this.defaultModel = defaultModel || "";
    this.baseURL = baseURL || "";

    if (!key || !baseURL) {
      logger.warn(
        "[CustomAIProvider] Missing API key or base URL; CustomAIProvider is disabled",
      );
      this.client = null;
      this.disabled = true;
      return;
    }

    this.client = new OpenAI({
      apiKey: key,
      baseURL: baseURL,
      timeout: LLM_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    });
    this.disabled = false;
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async createChatCompletion(options: LLMChatOptions): Promise<LLMResponse> {
    return this.traceWithLangfuse(
      {
        model:          options.model,
        messages:       options.messages,
        temperature:    options.temperature,
        maxTokens:      options.max_tokens,
        loggingContext: options.loggingContext,
      },
      async () => {
    const startTime = Date.now();
    const { loggingContext, ...apiOptions } = options;

    try {
      if (this.disabled || !this.client) {
        if (loggingContext) {
          await this.logUsage({
            ...loggingContext,
            model: options.model,
            durationMs: Date.now() - startTime,
            success: false,
            errorMessage: "Custom AI client not configured",
            provider: this.providerName,
          });
        }
        return { success: false, error: "Custom AI client not configured" };
      }

      const completion = await this.client.chat.completions.create(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        apiOptions as any,
      );
      const rawContent = completion?.choices?.[0]?.message?.content;
      const toolCalls = completion?.choices?.[0]?.message?.tool_calls;

      const usage = completion?.usage;
      const promptTokens = usage?.prompt_tokens || 0;
      const completionTokens = usage?.completion_tokens || 0;
      const totalTokens = usage?.total_tokens || 0;
      const metering=currentUsageContext();
      if(metering){metering.cachedTokens=usage?.prompt_tokens_details?.cached_tokens||0;
        metering.reasoningTokens=usage?.completion_tokens_details?.reasoning_tokens||0;}

      if (loggingContext) {
        await this.logUsage({
          ...loggingContext,
          model: options.model,
          promptTokens,
          completionTokens,
          totalTokens,
          durationMs: Date.now() - startTime,
          success: true,
          requestSummary: this.generateRequestSummary(options.messages),
          provider: this.providerName,
        });
      }

      if (!rawContent && (!toolCalls || toolCalls.length === 0)) {
        return { success: false, error: "No message content returned" };
      }

      return {
        success: true,
        content: rawContent || undefined,
        completion,
        usage: { promptTokens, completionTokens, totalTokens },
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (loggingContext) {
        await this.logUsage({
          ...loggingContext,
          model: options.model,
          durationMs: Date.now() - startTime,
          success: false,
          errorMessage: error?.message || "Error creating chat completion",
          requestSummary: this.generateRequestSummary(options.messages),
          provider: this.providerName,
        });
      }
      return {
        success: false,
        error: error?.message || "Error creating chat completion",
      };
    }
      }, // end traceWithLangfuse lambda
    ); // end traceWithLangfuse
  }

  async createChatCompletionStream(
    options: LLMStreamOptions,
  ): Promise<LLMStreamResponse> {
    const startTime = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { loggingContext, onChunk, onComplete, onError, ...apiOptions } =
      options;

    try {
      if (this.disabled || !this.client) {
        const error = "Custom AI client not configured";
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
        model: options.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: options.messages as any,
        temperature: options.temperature,
        max_tokens: options.max_tokens,
        stream: true,
        stream_options: { include_usage: true },
      });

      let fullContent = "";
      let sequence = 0;
      let streamUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
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

      if (loggingContext) {
        const promptTokens = streamUsage?.prompt_tokens || Math.round(JSON.stringify(options.messages).length / 4);
        const completionTokens = streamUsage?.completion_tokens || Math.round(fullContent.length / 4);
        const totalTokens = streamUsage?.total_tokens || (promptTokens + completionTokens);
        await this.logUsage({
          ...loggingContext,
          model: options.model,
          promptTokens,
          completionTokens,
          totalTokens,
          durationMs: Date.now() - startTime,
          success: true,
          requestSummary: this.generateRequestSummary(options.messages),
          metadata: { ...loggingContext.metadata, streaming: true },
          provider: this.providerName,
        });
      }

      onComplete(fullContent);
      return { success: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      const errorMsg =
        error?.message || "Error creating streaming chat completion";
      if (loggingContext) {
        await this.logUsage({
          ...loggingContext,
          model: options.model,
          durationMs: Date.now() - startTime,
          success: false,
          errorMessage: errorMsg,
          requestSummary: this.generateRequestSummary(options.messages),
          provider: this.providerName,
        });
      }
      onError?.(errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      if (this.disabled || !this.client) {
        logger.warn(
          "[CustomAIProvider] Connection test skipped - client not configured",
        );
        return false;
      }

      if (!this.defaultModel) {
        logger.warn(
          "[CustomAIProvider] Connection test skipped - no model configured",
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
        "[CustomAIProvider] Connection test failed",
      );
      return false;
    }
  }

  protected async calculateOriginalCost(model: string, tokens: TokenCounts): Promise<number> {
    return calculateMeteredLLMCost(model, tokens, true);
  }

  protected async logUsage(data: UsageData): Promise<void> {
    if (!data.userId) return; // userId required for DB insert
    try {
      const tokenCounts = {
        promptTokens: data.promptTokens || 0,
        completionTokens: data.completionTokens || 0,
        totalTokens: data.totalTokens || 0,
      };
      const rawCostCents = await this.calculateCost(data.model, tokenCounts);

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
        estimatedCostCents: rawCostCents,
        requestSummary: data.requestSummary || null,
        responseSuccess: data.success ? 1 : 0,
        errorMessage: data.errorMessage || null,
        durationMs: data.durationMs,
        metadata: data.metadata || null,
      });

      // Deduct credits (pass raw fractional cents for accurate credit calculation)
      if (data.userId) {
        const { deductCreditsForLLMUsage } = await import(
          "../CreditDeductionHooks.js"
        );
        const rawOriginalCostCents = await this.calculateOriginalCost(data.model, tokenCounts);
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
      logger.error({ err: error }, "[CustomAIProvider] Failed to log usage");
    }
  }
}
