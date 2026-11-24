/**
 * OpenAI Service - Handles LLM calls for workflow input generation
 * Uses OpenAI GPT-4 for intelligent search parameter generation
 * Now extends LLMProvider for multi-provider support
 */

import OpenAI from 'openai';
import type { LLMStepConfig, ParsedCampaignData } from './types';
import { createLLMUsage } from '../../models/llmUsages/functions';
import type { LLMChatOptions, LLMResponse, LLMStreamOptions, LLMStreamResponse, UsageData, TokenCounts } from './LLMProvider';
import { LLMProvider } from './LLMProvider';
import { logger } from '../../utils/logger.js';
import { calculateMeteredLLMCost } from '../insights/PricingService.js';
import { currentUsageContext } from '../insights/UsageContext.js';
import { supportsCustomTemperature, needsMaxCompletionTokens } from '../../utils/llmConstants';
import { LLM_REQUEST_TIMEOUT_MS } from '../../utils/timingConstants.js';

// Backward compatibility - export as OpenAILoggingContext
export interface OpenAILoggingContext {
  userId: number;
  threadId?: number;
  workflowId?: string;
  purpose: string; // e.g., "icp_generation", "intent_detection", "content_creation"
  service: string; // e.g., "ICPGenerationService", "MetaPromptEngine"
  action?: string; // e.g., "generate_icp", "detect_intent"
  metadata?: Record<string, unknown>;
}



export interface LLMResult {
  success: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: Record<string, any>;
  error?: string;
  rawResponse?: string;
}

export class OpenAIService extends LLMProvider {
  private client: OpenAI | null;
  protected providerName = 'openai';
  readonly defaultModel: string;

  constructor(apiKey?: string, defaultModel?: string) {
    super();
    // Only use explicitly provided API key, no env fallback
    const key = apiKey;
    // Only use explicitly provided model, no default fallback
    this.defaultModel = defaultModel || '';
    
    if (!key) {
      // Do not throw here — instead mark as disabled so workflows can handle gracefully
      logger.warn('[OpenAIService] No API key provided; OpenAIService is disabled');
      this.client = null;
      this.disabled = true;
      return;
    }

    this.client = new OpenAI({
      apiKey: key,
      timeout: LLM_REQUEST_TIMEOUT_MS,
      // Provider fallback is handled centrally. SDK-level retries can otherwise
      // keep an approved widget action in "running" well beyond its lease.
      maxRetries: 0,
    });
    this.disabled = false;
  }

  /**
   * Get the default model configured for this service
   */
  getDefaultModel(): string {
    return this.defaultModel;
  }

  /**
   * Generate workflow inputs using LLM
   */
  async generateWorkflowInputs(config: LLMStepConfig, campaignData: ParsedCampaignData): Promise<LLMResult> {
    try {
      if (this.disabled || !this.client) {
        const errorMsg = 'OpenAI client not configured (missing OPENAI_API_KEY)';
        logger.error({ errorMsg: errorMsg }, '[OpenAIService]');
        return { success: false, error: errorMsg };
      }

      logger.info({ model: config.model }, '[OpenAIService] Generating inputs using');

      // Fill prompt template with campaign data
      const prompt = this.fillPromptTemplate(config.prompt_template, campaignData);

      logger.info({ count: prompt.length }, '[OpenAIService] Prompt length: characters');

      // Call OpenAI API
      const completionResp = await this.createChatCompletion({
        model: config.model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that generates JSON parameters for data scraping workflows. Always respond with valid JSON only, no explanations.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        response_format: { type: 'json_object' }, // Force JSON response
      });

      const rawResponse = completionResp.content;
      if (!rawResponse) {
        return {
          success: false,
          error: 'No response from OpenAI API',
        };
      }

      logger.info({ rawResponse: rawResponse }, '[OpenAIService] Raw response');

      // Parse JSON response
      try {
        const data = JSON.parse(rawResponse);
        logger.info('[OpenAIService] Parsed data');

        return {
          success: true,
          data,
          rawResponse,
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (parseError: any) {
        logger.error('[OpenAIService] Failed to parse JSON response');
        return {
          success: false,
          error: `Failed to parse JSON response: ${parseError.message}`,
          rawResponse,
        };
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[OpenAIService] Error calling OpenAI API');
      return {
        success: false,
        error: error.message || 'Unknown error calling OpenAI API',
      };
    }
  }

  /**
   * Fill prompt template with campaign data
   */
  private fillPromptTemplate(template: string, data: ParsedCampaignData): string {
    let filledPrompt = template;

    // Replace placeholders with campaign data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replacements: Record<string, any> = {
      campaign_name: data.campaign_name || 'Lead Generation Campaign',
      campaign_objective: data.campaign_objective || 'Generate qualified leads',
      target_audience: data.target_audience || 'business professionals',
      industry_vertical: data.industry_vertical || 'Technology',
      business_type: data.business_type || 'B2B',
      target_roles_titles: Array.isArray(data.target_roles_titles)
        ? data.target_roles_titles.join(', ')
        : data.target_roles_titles || 'professionals',
      interests: Array.isArray(data.interests)
        ? data.interests.join(', ')
        : data.interests || 'industry-specific topics',
      geography_locations: Array.isArray(data.geography_locations)
        ? data.geography_locations.join(', ')
        : data.geography_locations || 'United States',
      parsed_data: JSON.stringify(data, null, 2),
    };

    // Replace all {placeholder} patterns
    for (const [key, value] of Object.entries(replacements)) {
      const regex = new RegExp(`\\{${key}\\}`, 'g');
      filledPrompt = filledPrompt.replace(regex, String(value));
    }

    return filledPrompt;
  }

  /**
   * Validate LLM configuration
   */
  validateLLMConfig(config: LLMStepConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!config.model) {
      errors.push('model is required');
    }

    if (!config.prompt_template) {
      errors.push('prompt_template is required');
    }

    if (config.temperature < 0 || config.temperature > 2) {
      errors.push('temperature must be between 0 and 2');
    }

    if (config.max_tokens < 1) {
      errors.push('max_tokens must be positive');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Test LLM connection
   */
  async testConnection(): Promise<boolean> {
    try {
      if (this.disabled || !this.client) {
        logger.warn('[OpenAIService] Connection test skipped - OpenAI client not configured');
        return false;
      }

      if (!this.defaultModel) {
        logger.warn('[OpenAIService] Connection test skipped - No model configured');
        return false;
      }

      const completionResp = await this.createChatCompletion({
        model: this.defaultModel,
        messages: [{ role: 'user', content: 'Test connection' }],
        max_tokens: 10,
      });
      return !!completionResp.content;
    } catch (error) {
      logger.error({ err: error }, '[OpenAIService] Connection test failed');
      return false;
    }
  }

  /**
   * Create a single chat completion and return the raw message content.
   * This wraps the OpenAI client to protect against null/disabled states.
   * Automatically logs usage when loggingContext is provided.
   * Implements LLMProvider interface.
   */
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
        // Log failure if context provided
        if (loggingContext) {
          await this.logUsage({
            ...loggingContext,
            model: options.model,
            durationMs: Date.now() - startTime,
            success: false,
            errorMessage: 'OpenAI client not configured',
            provider: this.providerName,
          });
        }
        return { success: false, error: 'OpenAI client not configured' };
      }

      // Strip temperature for models that only support the default (e.g. o1, o3, o4-mini)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filteredOptions: any = { ...apiOptions };
      if (filteredOptions.temperature !== undefined && !supportsCustomTemperature(options.model)) {
        delete filteredOptions.temperature;
      }
      // Remap max_tokens → max_completion_tokens for models that require it (o1, o3, o4, gpt-5)
      if (filteredOptions.max_tokens !== undefined && needsMaxCompletionTokens(options.model)) {
        filteredOptions.max_completion_tokens = filteredOptions.max_tokens;
        delete filteredOptions.max_tokens;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let completion: any;
      try {
        completion = await this.client.chat.completions.create(filteredOptions);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (apiError: any) {
        // If the API rejects temperature (some models only support default=1), retry without it
        const isTemperatureError =
          apiError?.status === 400 &&
          typeof apiError?.message === 'string' &&
          apiError.message.toLowerCase().includes('temperature') &&
          filteredOptions.temperature !== undefined;
        // If the API rejects max_tokens (newer models require max_completion_tokens), remap and retry
        const isMaxTokensError =
          apiError?.status === 400 &&
          typeof apiError?.message === 'string' &&
          apiError.message.toLowerCase().includes('max_tokens') &&
          filteredOptions.max_tokens !== undefined;
        if (isTemperatureError) {
          logger.warn(
            { model: options.model },
            '[OpenAIService] Model does not support custom temperature — retrying without it',
          );
          delete filteredOptions.temperature;
          completion = await this.client.chat.completions.create(filteredOptions);
        } else if (isMaxTokensError) {
          logger.warn(
            { model: options.model },
            '[OpenAIService] Model requires max_completion_tokens — retrying with remapped param',
          );
          filteredOptions.max_completion_tokens = filteredOptions.max_tokens;
          delete filteredOptions.max_tokens;
          completion = await this.client.chat.completions.create(filteredOptions);
        } else {
          throw apiError;
        }
      }

      const rawContent = completion?.choices?.[0]?.message?.content;
      const toolCalls = completion?.choices?.[0]?.message?.tool_calls;
      
      // Extract usage information
      const usage = completion?.usage;
      const promptTokens = usage?.prompt_tokens || 0;
      const completionTokens = usage?.completion_tokens || 0;
      const totalTokens = usage?.total_tokens || 0;
      const metering=currentUsageContext();
      if(metering){metering.cachedTokens=usage?.prompt_tokens_details?.cached_tokens||0;
        metering.reasoningTokens=usage?.completion_tokens_details?.reasoning_tokens||0;}
      
      // Log successful call if context provided
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

      // Check if we have either content or tool calls
      if (!rawContent && (!toolCalls || toolCalls.length === 0)) {
        return { success: false, error: 'No message content returned' };
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
          errorMessage: error?.message || 'Error creating chat completion',
          requestSummary: this.generateRequestSummary(options.messages),
          provider: this.providerName,
        });
      }
      return { success: false, error: error?.message || 'Error creating chat completion' };
    }
      }, // end traceWithLangfuse lambda
    ); // end traceWithLangfuse
  }

  /**
   * Calculate original provider cost in cents (what we pay the API provider)
   */
  protected async calculateOriginalCost(model: string, tokens: TokenCounts): Promise<number> {
    return calculateMeteredLLMCost(model, tokens, true);
  }

  /**
   * Log OpenAI usage to database
   * Protected method implementing LLMProvider interface
   */
  protected async logUsage(data: UsageData): Promise<void> {
    if (!data.userId) return; // userId required for DB insert
    try {
      const rawCostCents = await this.calculateCost(data.model, {
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
      logger.info({ purpose: data.purpose, model: data.model, totalTokens0: data.totalTokens || 0 }, '[OpenAIService] Logged usage: - - tokens');

      // Calculate original provider cost for revenue tracking
      const rawOriginalCostCents = await this.calculateOriginalCost(data.model, {
        promptTokens: data.promptTokens || 0,
        completionTokens: data.completionTokens || 0,
        totalTokens: data.totalTokens || 0,
      });

      // Deduct credits for this API call (pass raw fractional cents for accurate credit calculation)
      if (data.userId) {
        const { deductCreditsForLLMUsage } = await import('../CreditDeductionHooks.js');
        await deductCreditsForLLMUsage(data.userId, {
          model: data.model, provider: data.provider, purpose: data.purpose,
          service: data.service, estimatedCostCents: rawCostCents, originalCostCents: rawOriginalCostCents,
          promptTokens: data.promptTokens,
          completionTokens: data.completionTokens,
          totalTokens: data.totalTokens,
          threadId: data.threadId || null,
        });
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[OpenAIService] Failed to log usage');
      // Don't throw - logging failure shouldn't break the main flow
    }
  }

  /**
   * Create a streaming chat completion that calls onChunk for each delta and onComplete when done.
   * This enables real-time response streaming to the frontend via WebSocket.
   * Automatically logs usage when loggingContext is provided.
   * Implements LLMProvider interface.
   */
  async createChatCompletionStream(options: LLMStreamOptions): Promise<LLMStreamResponse> {
    const startTime = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { loggingContext, onChunk, onComplete, onError, ...apiOptions } = options;

    try {
      if (this.disabled || !this.client) {
        const error = 'OpenAI client not configured';
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

      // Strip temperature for models that only support the default (e.g. o1, o3, o4-mini, gpt-5-mini)
      const streamTemp =
        options.temperature !== undefined && !supportsCustomTemperature(options.model)
          ? undefined
          : options.temperature;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let stream: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const streamParams: any = {
        model: options.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: options.messages as any,
        temperature: streamTemp,
        stream: true as const,
        stream_options: { include_usage: true },
      };

      // Remap max_tokens → max_completion_tokens for models that require it (o1, o3, o4, gpt-5)
      if (options.max_tokens !== undefined) {
        if (needsMaxCompletionTokens(options.model)) {
          streamParams.max_completion_tokens = options.max_tokens;
        } else {
          streamParams.max_tokens = options.max_tokens;
        }
      }

      try {
        stream = await this.client.chat.completions.create(streamParams);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (apiError: any) {
        const isTemperatureError =
          apiError?.status === 400 &&
          typeof apiError?.message === 'string' &&
          apiError.message.toLowerCase().includes('temperature') &&
          streamParams.temperature !== undefined;
        const isMaxTokensError =
          apiError?.status === 400 &&
          typeof apiError?.message === 'string' &&
          apiError.message.toLowerCase().includes('max_tokens') &&
          streamParams.max_tokens !== undefined;
        if (isTemperatureError) {
          logger.warn(
            { model: options.model },
            '[OpenAIService] Model does not support custom temperature — retrying stream without it',
          );
          streamParams.temperature = undefined;
          stream = await this.client.chat.completions.create(streamParams);
        } else if (isMaxTokensError) {
          logger.warn(
            { model: options.model },
            '[OpenAIService] Model requires max_completion_tokens — retrying stream with remapped param',
          );
          streamParams.max_completion_tokens = streamParams.max_tokens;
          delete streamParams.max_tokens;
          stream = await this.client.chat.completions.create(streamParams);
        } else {
          throw apiError;
        }
      }

      let fullContent = '';
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

      // Log successful streaming call if context provided
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
      const errorMsg = error?.message || 'Error creating streaming chat completion';
      // Log error if context provided
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
}
