/**
 * Workflow Rules Engine
 * Determines which agents to suggest (and in what order) based on user intent and context.
 * 
 * Each rule defines:
 * - id: unique identifier
 * - description: human-readable description
 * - match: conditions that must be met (intent + optional context)
 * - workflow: ordered array of agent types to suggest as a linear workflow
 * 
 * Rules are evaluated top-to-bottom; the first matching rule wins.
 */

import { UserIntent } from './ICPGenerationService';

// Agent types used in workflows
export type WorkflowAgentType = 'lead_generation' | 'content_studio' | 'outreach' | 'performance_marketing';

// Context available for rule matching
export interface WorkflowContext {
  userIntent: UserIntent;
  hasLeads: boolean;            // user has leads in this thread or globally
  hasContent: boolean;          // user has generated content assets
  hasICP: boolean;              // ICP is available
  userMessage?: string;         // original user message (for keyword matching)
}

// A single workflow rule
export interface WorkflowRule {
  id: string;
  description: string;
  match: (ctx: WorkflowContext) => boolean;
  workflow: WorkflowAgentType[];
}

// Result of rule evaluation
export interface WorkflowResult {
  ruleId: string;
  description: string;
  workflow: WorkflowAgentType[];
}

/**
 * Ordered list of workflow rules.
 * Evaluated top-to-bottom — first match wins.
 */
const workflowRules: WorkflowRule[] = [
  // ──────────── OUTREACH SCENARIOS ────────────
  {
    id: 'outreach_no_leads',
    description: 'Outreach requested but no leads available — generate leads, create content, then outreach',
    match: (ctx) => ctx.userIntent === 'outreach' && !ctx.hasLeads,
    workflow: ['lead_generation', 'content_studio', 'outreach'],
  },
  {
    id: 'outreach_with_leads',
    description: 'Outreach requested and leads exist — create content then outreach',
    match: (ctx) => ctx.userIntent === 'outreach' && ctx.hasLeads,
    workflow: ['content_studio', 'outreach'],
  },

  // ──────────── PERFORMANCE MARKETING / ADS SCENARIOS ────────────
  {
    id: 'ads_publish_campaign',
    description: 'User wants to publish or run ads — create ad copy then performance marketing',
    match: (ctx) =>
      ctx.userIntent === 'performance_marketing' &&
      !!ctx.userMessage &&
      /\b(publish|run|launch|boost|promote|deploy)\b/i.test(ctx.userMessage),
    workflow: ['content_studio', 'performance_marketing'],
  },
  {
    id: 'ads_full_campaign_no_leads',
    description: 'Full ad campaign without leads — generate leads, create content, run ads',
    match: (ctx) =>
      ctx.userIntent === 'performance_marketing' && !ctx.hasLeads &&
      !!ctx.userMessage &&
      /\b(campaign|full|end.?to.?end|complete)\b/i.test(ctx.userMessage),
    workflow: ['lead_generation', 'content_studio', 'performance_marketing'],
  },
  {
    id: 'ads_creation_only',
    description: 'User wants to create ad copy or creatives — content studio only',
    match: (ctx) =>
      ctx.userIntent === 'performance_marketing' &&
      !!ctx.userMessage &&
      /\b(create|design|write|draft|generate)\b.*\b(ad|ads|creative|copy|banner)\b/i.test(ctx.userMessage),
    workflow: ['content_studio'],
  },
  {
    id: 'ads_default',
    description: 'Performance marketing default — create content then run ads',
    match: (ctx) => ctx.userIntent === 'performance_marketing',
    workflow: ['content_studio', 'performance_marketing'],
  },

  // ──────────── LEAD GENERATION SCENARIOS ────────────
  {
    id: 'lead_gen_local_search',
    description: 'User wants to find local businesses or places nearby — lead gen only (Google Maps + JustDial)',
    match: (ctx) =>
      ctx.userIntent === 'lead_generation' &&
      !!ctx.userMessage &&
      /\b(nearby|near\s?me|near\s|in\s\w+\s?(layout|area|city|town|district|locality|neighborhood)|restaurants?|hotels?|gyms?|shops?|stores?|salons?|clinics?|hospitals?|cafes?|bars?)\b/i.test(ctx.userMessage),
    workflow: ['lead_generation'],
  },
  {
    id: 'lead_gen_and_outreach',
    description: 'User wants leads AND outreach — lead gen, content, outreach workflow',
    match: (ctx) =>
      ctx.userIntent === 'lead_generation' &&
      !!ctx.userMessage &&
      /\b(outreach|send|sending|contact|reach\s?out|email|message|sms|whatsapp|letter|recruit|cold\s?call|follow.?up|dm|mail)\b/i.test(ctx.userMessage),
    workflow: ['lead_generation', 'content_studio', 'outreach'],
  },
  {
    id: 'lead_gen_and_ads',
    description: 'User wants leads AND ad targeting — lead gen then performance marketing',
    match: (ctx) =>
      ctx.userIntent === 'lead_generation' &&
      !!ctx.userMessage &&
      /\b(ads?|advertis|campaign|paid|ppc|boost)\b/i.test(ctx.userMessage),
    workflow: ['lead_generation', 'performance_marketing'],
  },
  {
    id: 'lead_gen_only',
    description: 'User wants to find or generate leads — lead gen only',
    match: (ctx) => ctx.userIntent === 'lead_generation',
    workflow: ['lead_generation'],
  },

  // ──────────── CONTENT CREATION SCENARIOS ────────────
  {
    id: 'content_and_publish_ads',
    description: 'Create content and publish as ads',
    match: (ctx) =>
      ctx.userIntent === 'content_creation' &&
      !!ctx.userMessage &&
      /\b(publish|run|boost|promote|ads?)\b/i.test(ctx.userMessage),
    workflow: ['content_studio', 'performance_marketing'],
  },
  {
    id: 'content_and_send',
    description: 'Create content and send via outreach',
    match: (ctx) =>
      ctx.userIntent === 'content_creation' &&
      !!ctx.userMessage &&
      /\b(send|sending|outreach|email|sms|whatsapp|instagram|message|distribute|letter|recruit|mail|dm)\b/i.test(ctx.userMessage),
    workflow: ['content_studio', 'outreach'],
  },
  {
    id: 'content_only',
    description: 'Create content — content studio only',
    match: (ctx) => ctx.userIntent === 'content_creation',
    workflow: ['content_studio'],
  },

  // ──────────── GENERAL / CATCH-ALL ────────────
  {
    id: 'general_full_workflow',
    description: 'General request mentioning a full workflow — all agents',
    match: (ctx) =>
      ctx.userIntent === 'general' &&
      !!ctx.userMessage &&
      /\b(full|complete|end.?to.?end|everything|all)\b/i.test(ctx.userMessage),
    workflow: ['lead_generation', 'content_studio', 'outreach', 'performance_marketing'],
  },
  {
    id: 'general_default',
    description: 'General request — suggest the single most relevant agent based on keywords',
    match: (ctx) => ctx.userIntent === 'general',
    workflow: [],  // empty means: fall back to score-based top-1 agent
  },
];

/**
 * Evaluate workflow rules against the given context.
 * Returns the first matching rule's workflow, or null if no rules match.
 */
export function evaluateWorkflowRules(ctx: WorkflowContext): WorkflowResult | null {
  for (const rule of workflowRules) {
    if (rule.match(ctx)) {
      return {
        ruleId: rule.id,
        description: rule.description,
        workflow: rule.workflow,
      };
    }
  }
  return null;
}

/**
 * Convert a matched workflow into agent scores (for backward compatibility).
 * The first agent in the workflow gets score 100, subsequent agents get decreasing scores
 * but all above 70 to pass the existing threshold filter.
 */
export function workflowToScores(workflow: WorkflowAgentType[]): Record<string, number> {
  const scores: Record<string, number> = {};
  const allAgents: WorkflowAgentType[] = ['lead_generation', 'content_studio', 'outreach', 'performance_marketing'];

  for (let i = 0; i < workflow.length; i++) {
    // All workflow agents get scores >= 80 (above the 70 threshold)
    // Primary agent gets 100, others get 90, 85, 80
    scores[workflow[i]] = Math.max(80, 100 - i * 5);
  }

  // Non-workflow agents get score 0 (won't pass the >= 70 filter)
  for (const agent of allAgents) {
    if (!(agent in scores)) {
      scores[agent] = 0;
    }
  }

  return scores;
}
