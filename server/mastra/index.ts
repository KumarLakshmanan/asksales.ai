/**
 * Mastra Module Index
 * Drop-in replacement for server/langgraph/index.ts exports.
 * chatController can swap `from '../langgraph'` → `from '../mastra'`
 * and everything will keep working.
 */

// ── State ──────────────────────────────────────────────────────────────
export {
  type AgentState,
  type ICPProfile,
  type BrandToolkit,
  type LeadInputs,
  type ActionButton,
  type ToolResult,
  type PendingApproval,
  createInitialState,
  addUserMessage as addHumanMessage,
  addAssistantMessage as addAIMessage,
  AGENT_TYPES,
  AGENT_INFO,
  type AgentType,
} from './state.js';

// ── Orchestrator (replaces graph.ts) ───────────────────────────────────
export {
  processMessage,
  handleApproval,
  switchAgent,
  getConversationState,
  cleanup,
} from './orchestrator.js';

// createGraph / getCompiledGraph — not applicable (no StateGraph)
// initializeCheckpointer — not applicable (no PostgresSaver)

// ── Agent display names (re-export from shared agentPersonas) ──────────
export { getDisplayName as getAgentDisplayName } from './agentPersonas.js';

// ── Tools (re-export types consumed by chatController / tests) ─────────
export type { ToolContext } from './tools/toolRegistry.js';

// ── Context helpers (re-export for backward compat) ────────────────────
export {
  prepareContextForAgent,
  buildSupervisorContext,
  writeScratchpad,
  readScratchpad,
  buildScratchpadContext,
  selectMessagesForAgent,
  compressToolOutputs,
  shouldCompactBeforeProcessing,
  compactMessagesInline,
  estimateTokens,
  filterToolResultsForAgent,
} from './utils/contextManager.js';

// Stub exports that the LangGraph version had but Mastra doesn't need
export const routeToAgent = () => 'supervisor';
export const shouldContinue = () => true;

// toolMetadata / agentToolMapping — re-export from tools registry
export {
  toolMetadata,
  agentToolMapping,
} from './tools/toolRegistry.js';
