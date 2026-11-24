import type { AgentState, AgentType } from './state.js';
import { routerOutputSchema, type RouterOutput } from './routerSchema.js';

/** @deprecated Natural-language navigation is classified by runUnifiedRouter. */
export function routeNavigationFallback(_message: string): RouterOutput | null { return null; }
/** @deprecated Business intent must be interpreted by the AI, not phrase matching. */
export function routeCriticalBusinessJourney(_message: string, _currentAgent?: AgentType): RouterOutput | null { return null; }
/** Compatibility for legacy callers: preserve state when AI intent is unavailable. */
export function routeMessageFallback(
  _message: string,
  _state?: Pick<AgentState, 'currentAgent' | 'agentPipeline' | 'agentPipelineIndex'>,
): RouterOutput {
  return routerOutputSchema.parse({
    intent: 'meta', action: 'clarify', needsClarification: true,
    hiredAgents: [], mode: 'none', isAffirmative: false, isDomainMatch: false,
    navigationTarget: null, nextAgent: null, suggestAgents: false, recommendedAgents: [],
    response: "I couldn't interpret that request. Please try again; your campaign is unchanged.",
  });
}
