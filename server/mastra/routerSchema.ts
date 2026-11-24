import { z } from 'zod';
import {dashboardOperationKinds} from './dashboardOperationPolicy.js';

/** Semantic interpretation of a turn, never execution authorization. */
export const semanticRequestSchema = z.object({
  status: z.enum(['none', 'campaign_actions']),
  taskRelation: z.enum(['new', 'follow_up', 'unspecified']),
  contentOperation: z.enum(['none', 'generate', 'revise_review', 'manage_saved', 'publish_new']),
  generationReviewId: z.number().int().positive().nullable(),
  brandToolkit: z.enum(['none', 'select', 'skip']),
  outreachOperation: z.enum(['none', 'campaign', 'proposal']),
  dashboardOperation:z.enum(dashboardOperationKinds).optional().describe('Read saved campaign reports/assistant diagnostics, analyze owned uploaded contact files, inspect operation progress, or open an import review. Never execution consent.'),
  scope: z.enum(['current_campaign', 'all_owned', 'unspecified']),
  lead: z.object({
    requirements: z.string().max(12000).nullable(),
    limit: z.number().int().positive().max(100000).nullable(),
    location: z.string().max(300).nullable(),
    searchVariants: z.boolean(),
    strategySelection: z.object({
      status: z.enum(['none', 'selected', 'ambiguous']),
      workflowIds: z.array(z.string().min(1).max(200)).max(20),
    }).optional(),
  }),
  generation: z.object({
    image: z.boolean().nullable(),
    video: z.boolean().nullable(),
    format: z.enum(['text', 'image', 'video', 'carousel']).nullable(),
    variationCount: z.number().int().min(1).max(5).nullable(),
    exactCta: z.string().max(2000).nullable(),
    length: z.enum(['short', 'medium', 'long']).nullable().default(null),
    lengthIntent: z.enum(['preserve', 'set', 'unspecified']).optional(),
  }),
  paidCampaignSelection: z.object({
    kind: z.enum(['unspecified', 'single', 'multiple', 'ambiguous']),
    campaignIds: z.array(z.string().min(1).max(200)).max(50),
    platforms: z.array(z.enum(['meta', 'google'])).nullable(),
  }),
});

export type SemanticRequest = z.infer<typeof semanticRequestSchema>;

export const routerOutputSchema = z.object({
  // Optional for internal explicit UI events and legacy state, required from
  // live model responses by parseRouterResponse. Never persisted as consent.
  semanticRequest: semanticRequestSchema.optional(),
  excludedAgents: z.array(z.enum(['icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing'])).default([]).describe('Agents explicitly excluded from the requested work. A prohibition on sending or spending does not exclude preparation by that agent.'),
  needsClarification: z.boolean().default(false).describe('The requested next action is ambiguous. Ask one focused question and select no agent.'),
  clarification: z.object({
    requiredField: z.string().trim().min(1).max(100).nullable(),
    answersQuestionId: z.string().uuid().nullable(),
  }).nullable().optional(),
  action: z.enum(['new_task', 'continue', 'revise', 'question', 'switch_agent', 'cancel', 'clarify']).optional(),
  cancellationScope: z.enum(['campaign', 'scheduled_post', 'review', 'operation', 'unspecified']).default('unspecified').describe('For cancellation only: campaign requires an explicit request to stop the whole campaign plan; never infer campaign from cancelling one post, review or operation.'),
  cancellationReviewId: z.string().max(250).nullable().default(null).describe('Exact review identity from current context: widget:<widgetId> or approval:<requestId>. Null when not specified or unclear. Never invent IDs.'),
  contentManagementRequested: z.boolean().default(false).describe('The request reads or edits existing saved content or schedules, rather than generating new content or publishing a new post.'),
  leadCatalogRequested: z.boolean().default(false),
  leadCatalogShowAll: z.boolean().default(false).describe('With leadCatalogRequested: true only when the latest message explicitly asks to see all, every or the full list of strategies. Asking which strategy to use, or for recommendations or the best fit, is false.'),
  leadSettingsRequested: z.boolean().default(false).describe('Prepare or revise lead-search settings for review only, never approval or execution. False for explanations, status, catalog browsing or a bare continue.'),
  leadShortlistRequested: z.boolean().default(false).describe('Read or refine the already saved current lead shortlist. Excluding categories or keeping IDs in existing results is shortlist work, NOT changing future search settings.'),
  savedDataLookup: z.boolean().default(true).describe('For an action=question turn: false ONLY when the answer is pure advice, explanation, an example or wording that needs no stored record, status, count, analytics or connection fact. True when unsure and for every other action.'),
  leadReviewApproval: z.boolean().default(false).describe('The latest user message itself explicitly and unconditionally approves the reviewed saved lead set for outreach handoff, in any language. False for questions, conditions, negation, quoted or reported approval, general satisfaction, or a bare continue. Never send or search approval.'),
  leadChannels: z.array(z.enum(['instagram', 'facebook', 'twitter', 'linkedin', 'justdial', 'google_maps'])).default([]),
  intent: z.enum(['conversational', 'task', 'meta', 'navigation']).describe(
    'Classification of user intent: conversational (chat/pleasantries/greetings/single-word confirmations), task (scraping, generating content/templates/ads, querying database/lists), meta (cancellation, clear, reset, pipelines, list agents), or navigation (explicit requests to open a tab/screen).'
  ),
  hiredAgents: z.array(z.enum([
    'icp_generation',
    'lead_generation',
    'content_studio',
    'outreach',
    'performance_marketing',
  ])).describe('Specialist agents requested or implied by the message. Exclude negated agents.'),
  mode: z.enum(['hire_agent', 'hire_team', 'none']).describe(
    'Routing mode: hire_agent if exactly 1 agent is selected, hire_team if 2+ agents are selected, none otherwise.'
  ),
  isAffirmative: z.boolean().describe(
    'True if the user is confirming, agreeing, proceeding, or asking to continue/start the campaign or next step.'
  ),
  isDomainMatch: z.boolean().describe(
    'True if the request falls directly within the domain of the current active agent.'
  ),
  navigationTarget: z.object({
    tabType: z.enum(['leads', 'icp', 'content-image', 'content-video', 'content-email', 'content-sms', 'content-social', 'content-adcopy', 'content-blog', 'content-studio', 'outreach', 'ads', 'analytics', 'overview', 'search', 'campaigns', 'brandtoolkit']),
    tabLabel: z.string(),
  }).nullable().describe('If intent is navigation, identify the correct UI tab to open.'),
  response: z.string().describe(
    'Conversational response from the coordinator (supervisor). Warm, empathetic, collaborative, and human-like.'
  ),
  nextAgent: z.enum([
    'icp_generation',
    'lead_generation',
    'content_studio',
    'outreach',
    'performance_marketing',
  ]).nullable().describe('The agent type to route the user to next. Null if staying with supervisor/coordinator.'),
  suggestAgents: z.boolean().describe(
    'True only when the user explicitly asks for agent recommendations or suggestions.'
  ),
  recommendedAgents: z.array(z.enum([
    'icp_generation',
    'lead_generation',
    'content_studio',
    'outreach',
    'performance_marketing',
  ])).describe('List of recommended agents if suggestAgents is true.'),
});

export type RouterOutput = z.infer<typeof routerOutputSchema>;
