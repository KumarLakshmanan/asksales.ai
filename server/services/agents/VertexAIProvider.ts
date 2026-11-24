import { GoogleGenAI } from '@google/genai';
import { createLLMUsage } from '../../models/llmUsages/functions.js';
import { logger } from '../../utils/logger.js';
import { DEFAULT_VERTEX_MODEL, normalizeLLMModelName } from '../../utils/llmConstants.js';
import { calculateMeteredLLMCost } from '../insights/PricingService.js';
import { currentUsageContext } from '../insights/UsageContext.js';
import { LLM_REQUEST_TIMEOUT_MS } from '../../utils/timingConstants.js';
import {
  normalizeVertexLocation,
  parseVertexServiceAccountJson,
  type VertexServiceAccount,
} from '../../utils/vertexAuth.js';
import {
  LLMProvider,
  type LLMChatOptions,
  type LLMResponse,
  type LLMStreamOptions,
  type LLMStreamResponse,
  type TokenCounts,
  type UsageData,
} from './LLMProvider.js';

export interface VertexAIProviderConfig {
  location?: string;
  projectId?: string;
}

export interface VertexCredentialSummary {
  projectId: string;
  clientEmail: string;
  location: string;
}

function createVertexClient(
  serviceAccount: VertexServiceAccount,
  location: string,
): GoogleGenAI {
  return new GoogleGenAI({
    vertexai: true,
    project: serviceAccount.project_id,
    location,
    googleAuthOptions: {
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
  });
}

export function validateVertexCredentialConfiguration(
  serviceAccountJson: string,
  config: VertexAIProviderConfig = {},
): { serviceAccount: VertexServiceAccount; summary: VertexCredentialSummary } {
  const serviceAccount = parseVertexServiceAccountJson(serviceAccountJson);
  const location = normalizeVertexLocation(config.location);
  if (config.projectId && config.projectId !== serviceAccount.project_id) {
    throw new Error('Vertex AI projectId must match the service account project_id');
  }
  return {
    serviceAccount,
    summary: {
      projectId: serviceAccount.project_id,
      clientEmail: serviceAccount.client_email,
      location,
    },
  };
}

export class VertexAIProvider extends LLMProvider {
  protected providerName = 'vertex_ai';
  readonly defaultModel: string;
  private client: GoogleGenAI | null = null;
  private initError: string | null = null;
  private readonly summary: VertexCredentialSummary | null = null;

  constructor(
    serviceAccountJson: string,
    defaultModel?: string,
    config: VertexAIProviderConfig = {},
  ) {
    super();
    this.defaultModel = normalizeLLMModelName('vertex_ai', defaultModel || DEFAULT_VERTEX_MODEL);
    try {
      const validated = validateVertexCredentialConfiguration(serviceAccountJson, config);
      this.summary = validated.summary;
      this.client = createVertexClient(validated.serviceAccount, validated.summary.location);
    } catch (error) {
      this.disabled = true;
      this.initError = error instanceof Error ? error.message : 'Invalid Vertex AI credential';
    }
  }

  getCredentialSummary(): VertexCredentialSummary | null {
    return this.summary;
  }

  getInitializationError(): string | null {
    return this.initError;
  }

  async createChatCompletion(options: LLMChatOptions): Promise<LLMResponse> {
    if (this.disabled || !this.client) {
      return { success: false, error: this.initError || 'Vertex AI provider is not configured' };
    }

    return this.traceWithLangfuse(
      {
        model: options.model || this.defaultModel,
        messages: options.messages,
        temperature: options.temperature,
        maxTokens: options.max_tokens,
        loggingContext: options.loggingContext,
      },
      async () => {
        const startTime = Date.now();
        const model = normalizeLLMModelName('vertex_ai', options.model || this.defaultModel);
        try {
          const { systemInstruction, contents } = this.convertMessages(options.messages);
          const config: Record<string, unknown> = {
            temperature: options.temperature ?? 0.7,
            maxOutputTokens: options.max_tokens ?? 2000,
          };
          if (systemInstruction) config.systemInstruction = systemInstruction;
          if (options.response_format?.type === 'json_object') {
            config.responseMimeType = 'application/json';
          }
          if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const functionDeclarations = options.tools.map((tool: any) => ({
              name: tool.function?.name || tool.name,
              description: tool.function?.description || tool.description || '',
              parameters: this.convertSchemaToGemini(tool.function?.parameters || tool.parameters || {}),
            }));
            config.tools = [{ functionDeclarations }];
            config.toolConfig = {
              functionCallingConfig: {
                mode: options.tool_choice === 'none' ? 'NONE'
                  : options.tool_choice === 'required' ? 'ANY'
                  : 'AUTO',
              },
            };
          }

          const response = await this.withTimeout(
            this.client!.models.generateContent({ model, contents, config } as never),
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw = response as any;
          const parts = raw.candidates?.[0]?.content?.parts || [];
          let text = typeof raw.text === 'string'
            ? raw.text
            : parts.map((part: { text?: string }) => part.text || '').join('');
          const usage = raw.usageMetadata as {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            totalTokenCount?: number;
            cachedContentTokenCount?: number;
            thoughtsTokenCount?: number;
          } | undefined;
          const metering=currentUsageContext();
          if(metering){metering.cachedTokens=usage?.cachedContentTokenCount||0;metering.reasoningTokens=usage?.thoughtsTokenCount||0;}

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const functionCalls = parts.filter((part: any) => part.functionCall);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const toolCalls = functionCalls.length > 0 ? functionCalls.map((part: any, index: number) => ({
            id: `call_${Date.now()}_${index}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {}),
            },
            ...(part.thoughtSignature ? { _thoughtSignature: part.thoughtSignature } : {}),
          })) : undefined;

          if (options.response_format?.type === 'json_object' && text) {
            text = this.extractJson(text);
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
              provider: 'vertex_ai',
              metadata: this.summary ? { vertexLocation: this.summary.location } : undefined,
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
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error({ err: error, model }, '[VertexAIProvider] Chat completion failed');
          if (options.loggingContext) {
            await this.logUsage({
              userId: options.loggingContext.userId,
              threadId: options.loggingContext.threadId,
              workflowId: options.loggingContext.workflowId,
              purpose: options.loggingContext.purpose,
              service: options.loggingContext.service,
              action: options.loggingContext.action,
              model,
              durationMs,
              success: false,
              errorMessage,
              provider: 'vertex_ai',
            });
          }
          return { success: false, error: errorMessage };
        }
      },
    );
  }

  async createChatCompletionStream(options: LLMStreamOptions): Promise<LLMStreamResponse> {
    if (this.disabled || !this.client) {
      const error = this.initError || 'Vertex AI provider is not configured';
      options.onError?.(error);
      return { success: false, error };
    }

    const model = normalizeLLMModelName('vertex_ai', options.model || this.defaultModel);
    try {
      const { systemInstruction, contents } = this.convertMessages(options.messages);
      const stream = await this.withTimeout(this.client.models.generateContentStream({
        model,
        contents,
        config: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.max_tokens ?? 2000,
          ...(systemInstruction ? { systemInstruction } : {}),
        },
      } as never));
      let fullContent = '';
      let sequence = 0;
      for await (const chunk of stream) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = typeof (chunk as any).text === 'string' ? (chunk as any).text : '';
        if (!text) continue;
        fullContent += text;
        options.onChunk(text, sequence++);
      }
      options.onComplete(fullContent);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, model }, '[VertexAIProvider] Stream failed');
      options.onError?.(errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  async testConnection(): Promise<boolean> {
    if (this.disabled || !this.client) return false;
    try {
      const result = await this.withTimeout(this.client.models.generateContent({
        model: this.defaultModel,
        contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
        config: { temperature: 0, maxOutputTokens: 8 },
      } as never));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return typeof (result as any).text === 'string' && (result as any).text.length > 0;
    } catch {
      return false;
    }
  }

  protected async logUsage(data: UsageData): Promise<void> {
    if (!data.userId) return;
    try {
      const rawCostCents = await this.calculateCost(data.model, {
        promptTokens: data.promptTokens || 0,
        completionTokens: data.completionTokens || 0,
        totalTokens: data.totalTokens || 0,
      });
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
        estimatedCostCents: rawCostCents,
        durationMs: data.durationMs,
        responseSuccess: data.success ? 1 : 0,
        errorMessage: data.errorMessage,
        provider: 'vertex_ai',
      });
      if (rawCostCents > 0) {
        const originalCostCents = await this.calculateOriginalCost(data.model, {
          promptTokens: data.promptTokens || 0,
          completionTokens: data.completionTokens || 0,
          totalTokens: data.totalTokens || 0,
        });
        const { deductCreditsForLLMUsage } = await import('../CreditDeductionHooks.js');
        await deductCreditsForLLMUsage(data.userId, {
          model: data.model,
          provider: 'vertex_ai',
          purpose: data.purpose,
          service: data.service,
          estimatedCostCents: rawCostCents,
          originalCostCents,
          promptTokens: data.promptTokens,
          completionTokens: data.completionTokens,
          totalTokens: data.totalTokens,
          threadId: data.threadId || null,
        });
      }
    } catch (error) {
      logger.error({ err: error }, '[VertexAIProvider] Failed to log usage');
    }
  }

  private async calculateOriginalCost(model: string, tokens: TokenCounts): Promise<number> {
    return calculateMeteredLLMCost(model, tokens, true);
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Vertex AI request timed out')), LLM_REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private convertMessages(messages: Array<{ role: string; content: string; name?: string; tool_calls?: any[]; tool_call_id?: string }>) {
    let systemInstruction: { parts: Array<{ text: string }> } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contents: Array<{ role: string; parts: Array<Record<string, any>> }> = [];
    for (const message of messages) {
      if (message.role === 'system') {
        systemInstruction ??= { parts: [] };
        if (message.content) systemInstruction.parts.push({ text: message.content });
      } else if (message.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: message.name || message.tool_call_id || 'unknown',
              response: (() => {
                try { return JSON.parse(message.content); } catch { return { result: message.content }; }
              })(),
            },
          }],
        });
      } else if (message.tool_calls?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parts: Array<Record<string, any>> = message.content ? [{ text: message.content }] : [];
        for (const toolCall of message.tool_calls) {
          const part: Record<string, unknown> = {
            functionCall: {
              name: toolCall.function?.name,
              args: (() => {
                try {
                  return typeof toolCall.function?.arguments === 'string'
                    ? JSON.parse(toolCall.function.arguments)
                    : toolCall.function?.arguments;
                } catch { return {}; }
              })(),
            },
          };
          if (toolCall._thoughtSignature) part.thoughtSignature = toolCall._thoughtSignature;
          parts.push(part);
        }
        contents.push({ role: 'model', parts });
      } else {
        contents.push({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content || '' }],
        });
      }
    }
    return { systemInstruction, contents };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private convertSchemaToGemini(schema: Record<string, any>): Record<string, any> {
    if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const convert = (input: Record<string, any>): Record<string, any> => {
      const union = input.anyOf || input.oneOf;
      if (Array.isArray(union)) {
        const selected = union.find((value) => value?.type !== 'null');
        if (selected) return convert(selected);
      }
      const typeValue = Array.isArray(input.type)
        ? input.type.find((value: string) => value !== 'null')
        : input.type;
      const output: Record<string, unknown> = {
        ...(typeValue ? { type: String(typeValue).toUpperCase() } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.enum ? { enum: input.enum } : {}),
      };
      if (input.properties) {
        output.properties = Object.fromEntries(
          Object.entries(input.properties).map(([key, value]) => [key, convert(value as Record<string, unknown>)]),
        );
      }
      if (Array.isArray(input.required)) output.required = input.required;
      if (input.items) output.items = convert(input.items);
      return output;
    };
    return convert(schema);
  }

  private extractJson(value: string): string {
    const objectStart = value.indexOf('{');
    const objectEnd = value.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd >= objectStart) return value.slice(objectStart, objectEnd + 1);
    const arrayStart = value.indexOf('[');
    const arrayEnd = value.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd >= arrayStart) return value.slice(arrayStart, arrayEnd + 1);
    return value;
  }
}
