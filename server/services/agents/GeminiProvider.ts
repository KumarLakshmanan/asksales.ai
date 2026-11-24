/**
 * Gemini Provider - Google Generative Language API
 * Extends LLMProvider for Gemini chat completions via the Generative Language REST API.
 */

import { LLMProvider } from './LLMProvider';
import type {
  LLMChatOptions,
  LLMResponse,
  LLMStreamOptions,
  LLMStreamResponse,
  UsageData,
} from './LLMProvider';
import { createLLMUsage } from '../../models/llmUsages/functions';
import { logger } from '../../utils/logger.js';
import { DEFAULT_GEMINI_MODEL, normalizeLLMModelName } from '../../utils/llmConstants';
import { calculateMeteredLLMCost } from '../insights/PricingService.js';
import { currentUsageContext } from '../insights/UsageContext.js';
import { LLM_REQUEST_TIMEOUT_MS } from '../../utils/timingConstants';

// All Gemini models use v1beta API
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function getGeminiBaseUrl(_model: string): string {
  return GEMINI_BASE_URL;
}

export class GeminiProvider extends LLMProvider {
  private apiKey: string;
  protected providerName = 'gemini';
  readonly defaultModel: string;

  constructor(apiKey?: string, defaultModel?: string) {
    super();
    this.defaultModel = normalizeLLMModelName('gemini', defaultModel || DEFAULT_GEMINI_MODEL);

    if (!apiKey) {
      logger.warn('[GeminiProvider] No API key provided; GeminiProvider is disabled');
      this.apiKey = '';
      this.disabled = true;
      return;
    }

    this.apiKey = apiKey;
    this.disabled = false;
  }

  async createChatCompletion(options: LLMChatOptions): Promise<LLMResponse> {
    if (this.disabled) {
      return { success: false, error: 'Gemini provider is not configured (missing API key)' };
    }

    return this.traceWithLangfuse(
      {
        model:          options.model || this.defaultModel,
        messages:       options.messages,
        temperature:    options.temperature,
        maxTokens:      options.max_tokens,
        loggingContext: options.loggingContext,
      },
      async () => {
    const startTime = Date.now();
    const model = normalizeLLMModelName('gemini', options.model || this.defaultModel);
    const apiBase = getGeminiBaseUrl(model);
    const isV1 = apiBase.includes('/v1') && !apiBase.includes('/v1beta');

    try {
      // Convert OpenAI-style messages to Gemini format
      const { systemInstruction, contents } = this.convertMessages(options.messages);

      const generationConfig: Record<string, unknown> = {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.max_tokens ?? 2000,
        };
      // responseMimeType is only supported in v1beta; skip for v1
      if (!isV1 && options.response_format?.type === 'json_object') {
        generationConfig.responseMimeType = 'application/json';
      }

      const body: Record<string, unknown> = {
        contents,
        generationConfig,
      };
      // systemInstruction only supported in v1beta; for v1 prepend it to the first user message
      if (systemInstruction && !isV1) {
        body.systemInstruction = systemInstruction;
      } else if (systemInstruction && isV1) {
        // Prepend system instruction as an initial user turn for v1 compatibility
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (body.contents as any[]).unshift({
          role: 'user',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parts: [{ text: `[System Instructions] ${systemInstruction.parts.map(part => part.text).join('\n\n')}` }],
        });
      }

      // Add function calling support if tools are provided
      if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const functionDeclarations = options.tools.map((t: any) => ({
          name: t.function?.name || t.name,
          description: t.function?.description || t.description || '',
          parameters: this.convertSchemaToGemini(t.function?.parameters || t.parameters || {}),
        }));
        body.tools = [{ functionDeclarations }];
        body.toolConfig = {
          functionCallingConfig: {
            mode: options.tool_choice === 'none' ? 'NONE'
              : options.tool_choice === 'required' ? 'ANY'
              : 'AUTO',
          },
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger.debug({ toolCount: functionDeclarations.length, toolNames: functionDeclarations.map((d: any) => d.name) },
          '[GeminiProvider] Sending tools with request');
      }

      const url = `${apiBase}/models/${model}:generateContent?key=${this.apiKey}`;
      const requestBody = JSON.stringify(body);
      logger.debug({ model, hasTools: !!body.tools, bodyLength: requestBody.length }, '[GeminiProvider] Sending request');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: { message?: string } };
        const errorMsg = errorData?.error?.message || `Gemini API error: ${response.status}`;
        logger.warn({ status: response.status, error: errorMsg, model }, '[GeminiProvider] API returned non-OK status');
        return { success: false, error: errorMsg };
      }

      const data = await response.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              functionCall?: { name: string; args: Record<string, any> };
              thoughtSignature?: string;
            }>;
          };
        }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number;
          cachedContentTokenCount?: number; thoughtsTokenCount?: number };
      };

      const parts = data.candidates?.[0]?.content?.parts || [];
      const usage = data.usageMetadata;
      const metering=currentUsageContext();
      if(metering){metering.cachedTokens=usage?.cachedContentTokenCount||0;metering.reasoningTokens=usage?.thoughtsTokenCount||0;}

      logger.debug({
        partsCount: parts.length,
        partTypes: parts.map(p => p.text ? 'text' : p.functionCall ? 'functionCall' : 'unknown'),
        candidateCount: data.candidates?.length,
        rawParts: JSON.stringify(parts).substring(0, 500),
      }, '[GeminiProvider] Response parts');

      // Extract text content
      let text = '';
      for (const part of parts) {
        if (part.text) text += part.text;
      }

      // Extract function calls and convert to OpenAI format
      // Preserve thoughtSignature for Gemini 3 models (required for multi-step function calling)
      const functionCalls = parts.filter(p => p.functionCall);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let toolCalls: any[] | undefined;
      if (functionCalls.length > 0) {
        toolCalls = functionCalls.map((p, i) => ({
          id: `call_${Date.now()}_${i}`,
          type: 'function',
          function: {
            name: p.functionCall!.name,
            arguments: JSON.stringify(p.functionCall!.args || {}),
          },
          // Carry the thoughtSignature so it can be sent back in the next turn
          ...(p.thoughtSignature ? { _thoughtSignature: p.thoughtSignature } : {}),
        }));
      }

      // Automatically strip markdown syntax if JSON response format was requested
      if (options.response_format?.type === 'json_object' && text) {
        const startIndex = text.indexOf('{');
        const endIndex = text.lastIndexOf('}');
        if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
          text = text.substring(startIndex, endIndex + 1);
        } else {
          const startArr = text.indexOf('[');
          const endArr = text.lastIndexOf(']');
          if (startArr !== -1 && endArr !== -1 && endArr >= startArr) {
            text = text.substring(startArr, endArr + 1);
          }
        }
      }

      const durationMs = Date.now() - startTime;

      if (options.loggingContext) {
        await this.logUsage({
          userId: options.loggingContext.userId,
          threadId: options.loggingContext.threadId,
          workflowId: options.loggingContext.workflowId,
          purpose: options.loggingContext.purpose,
          service: options.loggingContext.service,
          action: options.loggingContext.action,
          model,
          promptTokens: usage?.promptTokenCount,
          completionTokens: usage?.candidatesTokenCount,
          totalTokens: usage?.totalTokenCount,
          durationMs,
          success: true,
          provider: 'gemini',
        });
      }

      return {
        success: true,
        content: text || undefined,
        completion: {
          choices: [{
            message: {
              content: text || null,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
          }],
        },
        usage: usage ? {
          promptTokens: usage.promptTokenCount || 0,
          completionTokens: usage.candidatesTokenCount || 0,
          totalTokens: usage.totalTokenCount || 0,
        } : undefined,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, model }, '[GeminiProvider] Chat completion failed');

      if (options.loggingContext) {
        await this.logUsage({
          userId: options.loggingContext.userId,
          purpose: options.loggingContext.purpose,
          service: options.loggingContext.service,
          model,
          durationMs,
          success: false,
          errorMessage: errMsg,
          provider: 'gemini',
        });
      }

      return { success: false, error: errMsg };
    }
      }, // end traceWithLangfuse lambda
    ); // end traceWithLangfuse
  }

  async createChatCompletionStream(options: LLMStreamOptions): Promise<LLMStreamResponse> {
    if (this.disabled) {
      options.onError?.('Gemini provider is not configured');
      return { success: false, error: 'Gemini provider is not configured' };
    }

    const model = normalizeLLMModelName('gemini', options.model || this.defaultModel);

    try {
      const { systemInstruction, contents } = this.convertMessages(options.messages);

      const body: Record<string, unknown> = {
        contents,
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.max_tokens ?? 2000,
        },
      };
      if (systemInstruction) {
        body.systemInstruction = systemInstruction;
      }

      const url = `${getGeminiBaseUrl(model)}/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: { message?: string } };
        const errorMsg = errorData?.error?.message || `Gemini streaming error: ${response.status}`;
        options.onError?.(errorMsg);
        return { success: false, error: errorMsg };
      }

      if (!response.body) {
        options.onError?.('No response body');
        return { success: false, error: 'No response body' };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let sequence = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.substring(6)) as {
                candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
              };
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
              if (text) {
                fullContent += text;
                options.onChunk(text, sequence++);
              }
            } catch {
              // Skip unparseable SSE lines
            }
          }
        }
      }

      options.onComplete(fullContent);
      return { success: true };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, '[GeminiProvider] Stream failed');
      options.onError?.(errMsg);
      return { success: false, error: errMsg };
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${this.apiKey}`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async logUsage(data: UsageData): Promise<void> {
    if (!data.userId) return; // userId required for DB insert
    try {
      const rawCostCents = await this.calculateCost(data.model, {
        promptTokens: data.promptTokens || 0,
        completionTokens: data.completionTokens || 0,
      });
      const estimatedCostCents = rawCostCents;

      await createLLMUsage({
        userId: data.userId,
        threadId: data.threadId,
        workflowId: data.workflowId,
        purpose: data.purpose,
        service: data.service,
        action: data.action,
        model: data.model,
        promptTokens: data.promptTokens,
        completionTokens: data.completionTokens,
        totalTokens: data.totalTokens,
        estimatedCostCents,
        durationMs: data.durationMs,
        responseSuccess: data.success ? 1 : 0,
        errorMessage: data.errorMessage,
        provider: 'gemini',
      });

      // Deduct credits for this Gemini LLM call (pass raw fractional cents for accurate credit calculation)
      if (data.userId && rawCostCents > 0) {
        const rawOriginalCostCents = await this.calculateOriginalCost(data.model, {
          promptTokens: data.promptTokens || 0,
          completionTokens: data.completionTokens || 0,
        });
        const { deductCreditsForLLMUsage } = await import('../CreditDeductionHooks.js');
        await deductCreditsForLLMUsage(data.userId, {
          model: data.model,
          provider: 'gemini',
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
    } catch (error) {
      logger.error({ err: error }, '[GeminiProvider] Failed to log usage');
    }
  }

  async calculateCost(model: string, tokens: { promptTokens: number; completionTokens: number }): Promise<number> {
    return calculateMeteredLLMCost(model, tokens);
  }

  async calculateOriginalCost(model: string, tokens: { promptTokens: number; completionTokens: number }): Promise<number> {
    return calculateMeteredLLMCost(model, tokens, true);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private convertMessages(messages: Array<{ role: string; content: string; name?: string; tool_calls?: any[]; tool_call_id?: string }>): {
    systemInstruction: { parts: Array<{ text: string }> } | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contents: Array<{ role: string; parts: Array<Record<string, any>> }>;
  } {
    let systemInstruction: { parts: Array<{ text: string }> } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contents: Array<{ role: string; parts: Array<Record<string, any>> }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Memory and repair instructions supplement the agent contract; they
        // must not replace it just because they occur later in the request.
        systemInstruction ??= { parts: [] };
        if (msg.content) systemInstruction.parts.push({ text: msg.content });
      } else if (msg.role === 'tool') {
        // Tool result: Gemini expects functionResponse parts
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: msg.name || msg.tool_call_id || 'unknown',
              response: (() => {
                try { return JSON.parse(msg.content); } catch { return { result: msg.content }; }
              })(),
            },
          }],
        });
      } else if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant message with function calls
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parts: Array<Record<string, any>> = [];
        if (msg.content) parts.push({ text: msg.content });
        for (const tc of msg.tool_calls) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const part: Record<string, any> = {
            functionCall: {
              name: tc.function?.name,
              args: (() => {
                try { return typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function?.arguments; }
                catch { return {}; }
              })(),
            },
          };
          // Preserve thoughtSignature for Gemini 3 models (required for multi-step tool calling)
          if (tc._thoughtSignature) {
            part.thoughtSignature = tc._thoughtSignature;
          }
          parts.push(part);
        }
        contents.push({ role: 'model', parts });
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content || '' }],
        });
      }
    }

    return { systemInstruction, contents };
  }

  /**
   * Convert JSON Schema to Gemini-compatible schema format.
   * Gemini requires simple types (STRING, NUMBER, BOOLEAN, OBJECT, ARRAY, INTEGER)
   * and doesn't support union types, anyOf, oneOf, $ref, etc.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private convertSchemaToGemini(schema: Record<string, any>): Record<string, any> {
    if (!schema || typeof schema !== 'object') {
      return { type: 'OBJECT', properties: {} };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isOptional = (val: any): boolean => {
      if (!val || typeof val !== 'object') return false;
      if (Array.isArray(val.type) && val.type.includes('null')) return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (val.anyOf && val.anyOf.some((v: any) => v.type === 'null')) return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (val.oneOf && val.oneOf.some((v: any) => v.type === 'null')) return true;
      return false;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const normalizeType = (t: any): string => {
      if (Array.isArray(t)) {
        // Union type like ["string", "null"] — pick the non-null type
        const nonNull = t.filter((v: string) => v !== 'null');
        return (nonNull[0] || 'string').toUpperCase();
      }
      return String(t || 'string').toUpperCase();
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const convert = (s: Record<string, any>): Record<string, any> => {
      // Handle anyOf / oneOf — take the first non-null definition
      if (s.anyOf || s.oneOf) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const variants = (s.anyOf || s.oneOf) as any[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nonNull = variants.filter((v: any) => v.type !== 'null');
        if (nonNull.length > 0) {
          const result = convert(nonNull[0]);
          if (s.description) result.description = s.description;
          return result;
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: Record<string, any> = {};

      if (s.type) {
        result.type = normalizeType(s.type);
      }
      if (s.description) {
        result.description = s.description;
      }
      if (s.enum) {
        result.enum = s.enum;
      }
      if (s.properties) {
        result.properties = {};
        for (const [key, val] of Object.entries(s.properties)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result.properties[key] = convert(val as Record<string, any>);
        }
      }
      if (s.required) {
        // Filter out properties that allow null (optional fields)
        result.required = s.required.filter((reqKey: string) => {
          const prop = s.properties?.[reqKey];
          return prop ? !isOptional(prop) : true;
        });
        if (result.required.length === 0) {
          delete result.required;
        }
      }
      if (s.items) {
        result.items = convert(s.items);
      }

      // Remove unsupported keys
      delete result.$schema;
      delete result.additionalProperties;
      delete result.$ref;
      delete result.default;

      return result;
    };

    return convert(schema);
  }
}
