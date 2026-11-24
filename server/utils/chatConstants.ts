/**
 * Chat & Context Window Constants
 * 
 * Centralised configuration for all chat-related limits, context windows,
 * and compaction settings. Import from here instead of hardcoding values.
 */

// ─── Message Loading Limits ─────────────────────────────────────────────────────

/** Number of recent messages loaded into agent state (use full context) */
export const AGENT_CONTEXT_MESSAGE_LIMIT = 200;
/** @deprecated Use AGENT_CONTEXT_MESSAGE_LIMIT */
export const LANGGRAPH_CONTEXT_MESSAGE_LIMIT = AGENT_CONTEXT_MESSAGE_LIMIT;

/** Number of messages fetched for ICP generation from a thread (use full context) */
export const ICP_GENERATION_MESSAGE_LIMIT = 200;

/** Number of last user messages used as context inside ICP agent system prompt (use full context) */
export const ICP_AGENT_CONTEXT_MESSAGE_LIMIT = 200;

/** Number of last user messages used as ICP service conversation context (use full context) */
export const ICP_SERVICE_CONTEXT_MESSAGE_LIMIT = 200;

/** Default message fetch limit when no explicit limit is provided */
export const DEFAULT_MESSAGE_FETCH_LIMIT = 100;

/** Limit used to fetch ALL messages (effectively unbounded) */
export const ALL_MESSAGES_LIMIT = 9999;

/** Number of messages to check for existing user messages in a thread */
export const EXISTING_MESSAGES_CHECK_LIMIT = 10;

// ─── Conversation Compaction ────────────────────────────────────────────────────

/** Auto-compact when message count >= this threshold (disabled — use context % only) */
export const COMPACTION_THRESHOLD = 9999;

/** Number of recent messages to keep uncompacted */
export const RECENT_MESSAGES_TO_KEEP = 20;

/** Auto-compact when context window usage exceeds this percentage */
export const AUTO_COMPACT_CONTEXT_PERCENT = 80;

/** Default maximum output tokens reserved for model responses */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Estimated system prompt + tool overhead tokens added per LLM call */
export const SYSTEM_PROMPT_OVERHEAD_TOKENS = 3000;

/** LLM temperature for compaction summarisation */
export const COMPACTION_LLM_TEMPERATURE = 0.3;

// ─── Inline Compaction Extraction Limits ───────────────────────────────────────

// ─── Token Counting Constants ──────────────────────────────────────────────────

/** Per-message overhead tokens (role, name, separators) */
export const PER_MESSAGE_OVERHEAD = 4;

/** Reply priming token cost */
export const REPLY_PRIMING_TOKENS = 3;

/** Per-message token overhead for budget-based loading */
export const BUDGET_MESSAGE_OVERHEAD = 4;

/** Max entries in the per-text token count cache */
export const TOKEN_CACHE_MAX_SIZE = 5000;

/** Threshold for using text vs hash as cache key */
export const TOKEN_CACHE_KEY_THRESHOLD = 200;

// ─── Compute Message Limit Constants ───────────────────────────────────────────

// ─── Compaction Service Constants ──────────────────────────────────────────────

/** Max actionable IDs per category to prevent metadata bloat */
export const MAX_COMPACTED_IDS_PER_CATEGORY = 200;

/** Max user messages to fetch multiplier for getRecentUserMessages */
export const USER_MESSAGE_FETCH_MULTIPLIER = 3;

// ─── Context Management (per CONTEXT_MANAGEMENT.md) ─────────────────────────

/** Maximum scratchpad entries per agent to prevent unbounded growth */
export const SCRATCHPAD_MAX_ENTRIES = 20;

/** Maximum characters for a single scratchpad entry */
export const SCRATCHPAD_ENTRY_MAX_CHARS = 500;

/** Token threshold (percentage of context window) to trigger pre-processing compaction */
export const PRE_PROCESSING_COMPACT_PERCENT = 70;

/**
 * Specialist agent context size is no longer a static message count constant.
 * Instead it is calculated at runtime based on the selected model's
 * `context_window` value provided by the @pydantic/genai-prices package
 * (used for billing). The context manager module is responsible for
 * converting the token window into an approximate message limit.
 */

/** Maximum tool result messages to keep in context per agent invocation */
export const AGENT_TOOL_RESULTS_LIMIT = 5;

/** Maximum characters for inline tool output in messages (compress longer ones) */
export const TOOL_OUTPUT_INLINE_MAX_CHARS = 2000;

/** Number of recent messages always kept verbatim during inline compaction */
export const INLINE_COMPACT_KEEP_RECENT = 10;

// ─── Per-Agent Message Limits ───────────────────────────────────────────────────

/**
 * Per-agent message limit multipliers.
 * Applied as a fraction of the dynamically calculated limit
 * to keep specialist agents focused on recent context.
 */
export const AGENT_LIMIT_MULTIPLIERS: Record<string, number> = {
  orchestrator: 1.0,          // Full context — needs conversation overview
  supervisor: 0.33,           // Small slice — routing decisions only
  icp_generation: 0.5,        // Medium — needs enough user input history
  lead_generation: 0.5,       // Medium — recent lead discussion
  content_studio: 0.5,        // Medium — recent content requests
  outreach: 0.5,              // Medium — campaign context
  performance_marketing: 0.5, // Medium — campaign metrics context
};

// ─── Workflow Cache ─────────────────────────────────────────────────────────────

/** TTL for workflow cache entries (24 hours) */
export const WORKFLOW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Maximum number of entries in workflow cache */
export const WORKFLOW_CACHE_MAX_SIZE = 10_000;

/**
 * Look up the context window size for a given model name.
 * Returns 128k for all models regardless of their native context window.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getContextWindowForModel(modelName: string): number {
  return 128_000;
}
