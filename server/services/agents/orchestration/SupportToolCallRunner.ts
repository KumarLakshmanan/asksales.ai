import { orderedToolCalls, parseToolArguments, type FunctionToolCall } from '../../../utils/orderedToolCalls.js';
import type { SubAgentResult } from '../subagents/index.js';

// These adapters only retrieve independent records. Payment state, booking
// helpers, delegation and published required actions remain sequential.
const independentReads = new Set(['get_hotel_info', 'get_payment_methods', 'get_ticket_status', 'get_conversation_proposals']);

export async function* runSupportToolCalls(
  calls: FunctionToolCall[],
  execute: (name: string, args: Record<string, unknown>) => Promise<SubAgentResult>,
  options: { requiredAction?: string; normalize?: (name: string, args: Record<string, unknown>) => Record<string, unknown> } = {},
) {
  for await (const { call: tc, result } of orderedToolCalls(calls,
    call => !options.requiredAction && independentReads.has(call.function.name), async call => {
      const startedAt = Date.now();
      let args: Record<string, unknown>;
      try { args = parseToolArguments(call.function.arguments); }
      catch {
        return { args: {}, durationMs: Date.now() - startedAt, out: { toolResults: [{ name: call.function.name,
          result: { success: false, code: 'invalid_arguments', error: 'Tool arguments must be a valid JSON object.' } }] } as SubAgentResult };
      }
      args = options.normalize?.(call.function.name, args) || args;
      // The dispatch callback retains SafeToolExecutor's leaf authorization,
      // schema, exact approval, privacy and idempotency checks.
      const out = await execute(call.function.name, args);
      return { args, out, durationMs: Date.now() - startedAt };
    })) yield { tc, ...result };
}
