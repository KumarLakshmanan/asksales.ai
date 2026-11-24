/**
 * Shared agent state types — single source of truth.
 *
 * Phase 9.5: lifted out of `server/langgraph/state.ts` and
 * `server/mastra/state.ts` (which now re-export from here) so
 * `server/shared/agents/tabConfig.ts` can import `AgentType` without
 * depending on either runtime.
 *
 * The type union is intentionally identical to the previous local
 * declarations in `langgraph/state.ts` and `mastra/state.ts` —
 * no behavioural change, just deduplication.
 */

export type AgentType =
  | 'orchestrator'
  | 'supervisor'
  | 'icp_generation'
  | 'lead_generation'
  | 'content_studio'
  | 'outreach'
  | 'performance_marketing';

export const AGENT_TYPES: AgentType[] = [
  'orchestrator',
  'supervisor',
  'icp_generation',
  'lead_generation',
  'content_studio',
  'outreach',
  'performance_marketing',
];
