/**
 * Langfuse Observability Client
 *
 * Provides a lazily-initialised Langfuse client (Node.js SDK) and a factory for creating
 * LangChain CallbackHandlers that automatically attach traces to every LangChain/LangGraph
 * model invocation.
 *
 * All exported functions are no-ops when LANGFUSE_ENABLED is not "true" — the rest of the
 * application never needs to check the flag explicitly.
 *
 * Environment variables:
 *   LANGFUSE_ENABLED     - Set to "true" to activate tracing
 *   LANGFUSE_PUBLIC_KEY  - Project public key (pk-lf-…)
 *   LANGFUSE_SECRET_KEY  - Project secret key (sk-lf-…)
 *   LANGFUSE_HOST        - Optional custom host (default: https://cloud.langfuse.com)
 */

import { logger } from '../utils/logger.js';
import { redactLogValue } from '../utils/logRedaction.js';

const LANGFUSE_ENABLED = process.env.LANGFUSE_ENABLED === 'true';

// ── Types ──────────────────────────────────────────────────────────────────

/** Context for direct (non-LangChain) LLM generation tracing */
export interface LangfuseGenerationContext {
  userId: string | number;
  threadId?: string | number;
  purpose: string;
  service: string;
  action?: string;
  provider: string;
}

// ── Lazy-loaded Langfuse instances ─────────────────────────────────────────

/**
 * Phase 6.10 / TYPE-001: narrow the client shape to the surface area we
 * actually use. The full `langfuse` SDK ships a richer type but isn't
 * always available at compile-time, and we want this file to compile even
 * when `@types/langfuse` is missing. Keeping the structural type local
 * makes the dependency obvious.
 */
interface LangfuseClient {
  shutdownAsync(): Promise<void>;
  flushAsync(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trace(params: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}
let _langfuseClient: LangfuseClient | null = null;
let _initialized = false;

/**
 * Return the Langfuse client singleton, or null if disabled / not configured.
 * The client is initialised on first call.
 *
 * Phase 6.10: return type narrowed to `LangfuseClient | null` (see the
 * interface at the top of this file).
 */
export async function getLangfuseClient(): Promise<LangfuseClient | null> {
  if (!LANGFUSE_ENABLED) return null;
  if (_initialized) return _langfuseClient;

  _initialized = true;

  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const host = process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com';

  if (!secretKey || !publicKey) {
    logger.warn(
      '[Langfuse] LANGFUSE_ENABLED=true but LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY are missing. Tracing disabled.',
    );
    return null;
  }

  try {
    const { Langfuse } = await import('langfuse');
    _langfuseClient = new Langfuse({ secretKey, publicKey, baseUrl: host }) as unknown as LangfuseClient;
    logger.info('[Langfuse] Client initialised');
  } catch (err) {
    logger.error({ err }, '[Langfuse] Failed to initialise client');
  }

  return _langfuseClient;
}


/**
 * Wrap a direct (non-LangChain) LLM call with a Langfuse generation span.
 *
 * Usage:
 * ```typescript
 * const result = await traceLangfuseGeneration(
 *   { ...ctx, model: 'gpt-4o', messages },
 *   () => openaiClient.chat.completions.create(payload)
 * );
 * ```
 *
 * @param options  Trace metadata
 * @param fn       The async function that performs the actual LLM call
 * @returns        Whatever fn() returns, unchanged
 */
export async function traceLangfuseGeneration<TResult>(
  options: {
    context: LangfuseGenerationContext;
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
  },
  fn: () => Promise<TResult & {
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    content?: string;
  }>,
): Promise<TResult> {
  if (!LANGFUSE_ENABLED) return fn() as Promise<TResult>;

  // Traces are metadata-only. Capturing customer bodies needs a separate,
  // reviewed purpose/retention policy, rather than a global tracing toggle.
  const { context, model, temperature, maxTokens } = options;
  let generation: { end(data: unknown): unknown } | undefined;
  try {
    const lf = await getLangfuseClient();
    const trace = lf?.trace(redactLogValue({
      name: context.purpose,
      userId: String(context.userId),
      sessionId: `thread-${context.threadId ?? context.userId}`,
      metadata: { service: context.service, action: context.action,
        provider: context.provider, threadId: context.threadId },
    }));
    generation = trace?.generation(redactLogValue({
      name: `${context.service}/${context.purpose}`, model,
      modelParameters: { provider: context.provider,
        temperature: temperature ?? null, maxTokens: maxTokens ?? null },
    }));
  } catch {
    logger.warn('[Langfuse] Trace setup failed; operation will run without tracing');
  }
  // SDK failures, including asynchronous rejections, are strictly observational.
  const finish = async (data: unknown) => {
    try { await generation?.end(data); }
    catch { logger.warn('[Langfuse] Trace completion failed'); }
  };
  let result: TResult;
  try { result = await fn(); }
  catch (error) {
    await finish({ level: 'ERROR', statusMessage: 'Provider operation failed' });
    throw error;
  }
  const usage = (result as { usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }).usage;
  await finish({ usage: usage ? { promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens, totalTokens: usage.totalTokens } : undefined });
  return result;

}

/**
 * Flush all pending Langfuse events and shut down the client gracefully.
 * Call this in SIGTERM / SIGINT handlers to avoid losing buffered traces.
 */
export async function shutdownLangfuse(): Promise<void> {
  const lf = await getLangfuseClient();
  if (lf) {
    try {
      await lf.shutdownAsync();
      logger.info('[Langfuse] Flushed and shut down');
    } catch (err) {
      logger.error({ err }, '[Langfuse] Error during shutdown flush');
    }
  }
}
