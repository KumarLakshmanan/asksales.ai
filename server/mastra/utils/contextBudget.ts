import { countTokens } from '../../utils/tokenCounter.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, getContextWindowForModel } from '../../utils/chatConstants.js';
import { getModelContextWindow } from '../../services/GenAIPricingService.js';

export class ContextBudgetExceededError extends Error {
  constructor() { super('This conversation or attachment is too large to process safely. Please narrow the request or split the material into smaller parts. Pending reviews are unchanged.'); }
}

/** Count the full provider payload, including tool schemas and call arguments. */
export function assertContextFits(model: string, messages: unknown, tools?: unknown, outputTokens = DEFAULT_MAX_OUTPUT_TOKENS): void {
  const capacity = getModelContextWindow(model) ?? getContextWindowForModel(model);
  const inputTokens = countTokens(JSON.stringify({ messages, tools }), model);
  if (inputTokens + outputTokens + 512 > capacity) throw new ContextBudgetExceededError();
}
