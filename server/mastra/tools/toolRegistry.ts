/**
 * Campaign tool registry.
 *
 * `toolMetadata` describes every tool the campaign specialists can be given
 * (owner agents, approval requirement, read/write effect). `agentToolMapping`
 * lists each specialist's tools for its system prompt. The executable tools and
 * their input schemas live beside this file in the `*Tools.ts` modules; each
 * agent's `getTools()` decides what is actually callable in a turn.
 *
 * @module tools
 */

import { AgentType, ICPProfile, BrandToolkit, CompanyProfile, LeadInput, type RunContext, type PendingApproval } from '../state';

/**
 * Tool metadata interface for tracking and configuration
 */
export interface ToolMeta {
  /** Unique tool name */
  name: string;
  /** Human-readable description for LLM */
  description: string;
  /** Agents that can use this tool */
  agents: AgentType[];
  /** Whether tool requires human approval before execution */
  requiresApproval: boolean;
  /** Only audited independent reads may overlap; unspecified tools are serial. */
  effect?: 'read' | 'write' | 'control';
  concurrencySafe?: boolean;
}

/**
 * Metadata registry for the Conversation Builder tools
 * Used for tool discovery, validation, and LLM prompting
 */
export const toolMetadata: Record<string, ToolMeta> = {
  // create_campaign_export, preview_outreach_retries and analyze_contact_files save a
  // derived snapshot/preview, so they are tagged write. They stay available on
  // answer-only turns (readOnlyCampaignTools) because they never send, import or
  // change campaign data.
  create_campaign_export:{name:'create_campaign_export',description:'Generate private campaign reports from one timestamped snapshot, with live progress and download actions.',agents:['orchestrator','outreach'],requiresApproval:false,effect:'write',concurrencySafe:false},
  get_campaign_export:{name:'get_campaign_export',description:'Read saved campaign export progress and authenticated download actions.',agents:['orchestrator','outreach'],requiresApproval:false,effect:'read',concurrencySafe:true},
  query_campaign_customers:{name:'query_campaign_customers',description:'Read canonical customer-level replies, native selections and recorded engagement.',agents:['orchestrator','outreach'],requiresApproval:false,effect:'read',concurrencySafe:true},
  query_campaign_history:{name:'query_campaign_history',description:'Read paged protected conversation history for a selected campaign audience.',agents:['orchestrator','outreach'],requiresApproval:false,effect:'read',concurrencySafe:true},
  preview_outreach_retries:{name:'preview_outreach_retries',description:'Prepare an eligibility review for existing outreach intents; sending requires the dashboard confirmation.',agents:['orchestrator','outreach'],requiresApproval:false,effect:'write',concurrencySafe:false},
  get_outreach_retry_preview:{name:'get_outreach_retry_preview',description:'Read retry exclusions, saved schedules and confirmed recovery progress.',agents:['orchestrator','outreach'],requiresApproval:false,effect:'read',concurrencySafe:true},
  get_outreach_preparation_options:{name:'get_outreach_preparation_options',description:'Read exact sending accounts, approved templates and imported audiences.',agents:['orchestrator','outreach'],requiresApproval:false,effect:'read',concurrencySafe:true},
  get_prepared_outreach:{name:'get_prepared_outreach',description:'Read an owned prepared draft and its saved submission receipt without sending.',agents:['orchestrator','outreach'],requiresApproval:false,effect:'read',concurrencySafe:true},
  prepare_outreach_campaign:{name:'prepare_outreach_campaign',description:'Save an imported audience and selected account/template/follow-ups into a draft and open its composer review. Never sends.',agents:['orchestrator','outreach'],requiresApproval:false,effect:'write',concurrencySafe:false},
  list_contact_workbooks:{name:'list_contact_workbooks',description:'Read owned saved contact workbook IDs with pagination.',agents:['orchestrator','lead_generation','outreach'],requiresApproval:false,effect:'read',concurrencySafe:true},
  analyze_contact_files:{name:'analyze_contact_files',description:'Create a derived contact workbook preview; no CRM import or sending.',agents:['orchestrator','lead_generation','outreach'],requiresApproval:false,effect:'write',concurrencySafe:false},
  get_dashboard_operation:{name:'get_dashboard_operation',description:'Read owned analysis/import progress and results.',agents:['orchestrator','lead_generation','outreach'],requiresApproval:false,effect:'read',concurrencySafe:true},
  review_contact_import:{name:'review_contact_import',description:'Open the exact ready audience for explicit dashboard import confirmation.',agents:['orchestrator','lead_generation','outreach'],requiresApproval:false,effect:'read',concurrencySafe:true},
  query_assistant_diagnostics:{name:'query_assistant_diagnostics',description:'Read saved assistant readiness, account assignments and diagnostics with settings links.',agents:['orchestrator','outreach'],requiresApproval:false,effect:'read',concurrencySafe:true},
  // ICP Tools
  generate_icp: {
    name: 'generate_icp',
    description: 'Generate an Ideal Customer Profile (ICP) based on user requirements. Use this when the user wants to define their target audience or start a new campaign.',
    agents: ['orchestrator', 'icp_generation'],
    requiresApproval: false,
  },
  save_business_profile: {
    name: 'save_business_profile',
    description: 'Save business profile information provided by the user during conversation. Use this when the user has shared their company details (name, industry, location, services) and wants to save it.',
    agents: ['orchestrator', 'icp_generation'],
    requiresApproval: false,
  },
  crawl_website: {
    name: 'crawl_website',
    description: 'Crawl a website URL to extract comprehensive business information from multiple pages (about, products, services, contact, case studies, docs, support, etc.). Automatically discovers and follows internal links to gather rich context. After crawling, the ICP agent should IMMEDIATELY use the data to generate an ICP profile — do NOT wait for user confirmation.',
    agents: ['orchestrator', 'supervisor', 'icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing'],
    requiresApproval: false,
  },
  
  // Lead Generation Tools
  list_available_workflows: {
    name: 'list_available_workflows',
    description: 'Recommend the best matching lead extraction workflow for each requested channel/platform using the ICP and user intent. Returns a match percentage and reason so the user can confirm before generate_lead_inputs.',
    agents: ['lead_generation'],
    requiresApproval: false,
  },
  generate_lead_inputs: {
    name: 'generate_lead_inputs',
    description: 'Generate search parameters and inputs for lead generation based on an existing ICP. Use this when the user wants to find leads and an ICP already exists.',
    agents: ['lead_generation'],
    requiresApproval: false,
  },
  estimate_lead_search_cost: {
    name: 'estimate_lead_search_cost',
    description: 'Read-only estimate of the credits and run time of the reviewed lead search, from past runs of the same scraper.',
    agents: ['lead_generation'],
    requiresApproval: false,
  },
  execute_lead_workflow: {
    name: 'execute_lead_workflow',
    description: 'Execute a lead generation workflow to scrape leads from platforms. Requires user approval before execution.',
    agents: ['lead_generation'],
    requiresApproval: true,
  },
  
  // Content Studio Tools
  select_brand_toolkit: {
    name: 'select_brand_toolkit',
    description: 'Select, create, or skip a brand toolkit. Use action: select with toolkit_id or toolkit_name to choose one, action: create to open the creation page, or action: skip to proceed without brand guidelines.',
    agents: ['content_studio'],
    requiresApproval: false,
  },
  get_brandtoolkits: {
    name: 'get_brandtoolkits',
    effect: 'read', concurrencySafe: true,
    description: 'Get all brand toolkits for the current user. Returns a list of brand toolkits with their IDs, names, colors, voice type, and default status. Call this to discover available brand toolkits before selecting one.',
    agents: ['content_studio'],
    requiresApproval: false,
  },
  get_brandtoolkit: {
    name: 'get_brandtoolkit',
    effect: 'read', concurrencySafe: true,
    description: 'Get detailed information about a specific brand toolkit by its ID. Returns full brand toolkit details including colors, fonts, voice type, CTAs, hashtags, and brand values.',
    agents: ['content_studio'],
    requiresApproval: false,
  },
  get_businessprofiles: {
    name: 'get_businessprofiles',
    effect: 'read', concurrencySafe: true,
    description: 'Get all business profiles for the current user. Returns a list of business profiles with their IDs, names, industries, and default status. Use this to understand the user\'s business context.',
    agents: ['content_studio', 'orchestrator', 'icp_generation', 'lead_generation', 'outreach', 'performance_marketing'],
    requiresApproval: false,
  },
  get_businessprofile: {
    name: 'get_businessprofile',
    effect: 'read', concurrencySafe: true,
    description: 'Get detailed information about a specific business profile by its ID. Returns full business profile details including company name, industry, description, target market, brand tone, and more.',
    agents: ['content_studio', 'orchestrator', 'icp_generation', 'lead_generation', 'outreach', 'performance_marketing'],
    requiresApproval: false,
  },
  generate_image: {
    name: 'generate_image',
    description: 'Generate an image using AI based on a text prompt. Use this for marketing images, ad creatives, social media graphics.',
    agents: ['content_studio'],
    requiresApproval: false,
  },
  generate_video: {
    name: 'generate_video',
    description: 'Generate a video using AI based on a text prompt. Use this for marketing videos, promotional clips.',
    agents: ['content_studio'],
    requiresApproval: false,
  },
  generate_image_from_image: {
    name: 'generate_image_from_image',
    description: 'Generate a new image based on an existing image and a text prompt. For image transformations.',
    agents: ['content_studio'],
    requiresApproval: false,
  },
  generate_video_from_image: {
    name: 'generate_video_from_image',
    description: 'Generate a video from a static image and a text prompt. Use to animate images.',
    agents: ['content_studio'],
    requiresApproval: false,
  },
  generate_social_media_post: {
    name: 'generate_social_media_post',
    description: 'Generate a comprehensive social media post including caption, keywords, hashtags. Use platform="all" to generate universal content that works across LinkedIn, Twitter, Facebook, and Instagram. This is the recommended approach - DO NOT ask users which platform they want.',
    agents: ['content_studio'],
    requiresApproval: false,
  },
  generate_social_chat_template: {
    name: 'generate_social_chat_template',
    description: 'Generate a direct message or chat template for social media platforms like LinkedIn, Instagram, Twitter DMs, or Facebook Messenger.',
    agents: ['content_studio'],
    requiresApproval: false,
  },
  
  // Outreach Tools
  generate_email_template: {
    name: 'generate_email_template',
    description: 'Generate an email marketing template for cold outreach, newsletters, or follow-ups.',
    agents: ['content_studio'],
    requiresApproval: false,
  },
  generate_sms_template: {
    name: 'generate_sms_template',
    description: 'Generate an SMS marketing template for short, direct messaging campaigns.',
    agents: ['content_studio'],
    requiresApproval: false,
  },
  generate_blog_post: {
    name: 'generate_blog_post',
    description: 'Generate a blog post with SEO optimization, structured sections, and optional featured image. Use this when the user wants to create blog content, articles, or long-form written content.',
    agents: ['content_studio'],
    requiresApproval: false,
  },
  send_outreach_messages: {
    name: 'send_outreach_messages',
    description: 'Send outreach messages (email, SMS, WhatsApp, Instagram DM, Facebook Messenger, LinkedIn DM, or Twitter/X DM) to selected leads. Requires user approval.',
    agents: ['outreach'],
    requiresApproval: true,
  },
  
  // Performance Marketing Tools
  research_ad_creatives: { name: 'research_ad_creatives', description: 'Collect competitor ad references; no provider mutations.', agents: ['performance_marketing'], requiresApproval: false },
  suggest_ad_creative_briefs: { name: 'suggest_ad_creative_briefs', description: 'Suggest creative concepts from saved competitor research and business facts.', agents: ['performance_marketing'], requiresApproval: false },
  get_ad_creative_research: { name: 'get_ad_creative_research', description: 'Read research status or reviewed creative brief inputs.', agents: ['performance_marketing'], requiresApproval: false },
  generate_ad: {
    name: 'generate_ad',
    description: 'Generate ad copy with creative concepts including headlines, captions, keywords. Supports generating multiple ad variations (1-5) in a single attempt via the number_of_variations parameter.',
    agents: ['content_studio', 'performance_marketing'],
    requiresApproval: false,
  },
  publish_meta_ads: {
    name: 'publish_meta_ads',
    description: 'Publish a campaign to Meta (Facebook/Instagram) Ads. Requires user approval.',
    agents: ['performance_marketing'],
    requiresApproval: true,
  },
  publish_ads: {
    name: 'publish_ads',
    description: 'Review and launch one campaign across Meta, Google, or both platforms. Requires one user approval.',
    agents: ['performance_marketing'],
    requiresApproval: true,
  },
  publish_google_ads: {
    name: 'publish_google_ads',
    description: 'Publish a campaign to Google Ads. Requires user approval.',
    agents: ['performance_marketing'],
    requiresApproval: true,
  },
  publish_social_post: {
    name: 'publish_social_post',
    description: 'Publish a saved post to Facebook, Instagram, YouTube, LinkedIn, or Twitter, including reviewed multi-target publishing. Requires user approval.',
    agents: ['content_studio', 'outreach'],
    requiresApproval: true,
  },
  generate_whatsapp_template: {
    name: 'generate_whatsapp_template',
    description: 'Generate a WhatsApp Business message template with interactive elements (buttons, headers, footers) based on marketing objectives.',
    agents: ['content_studio'],
    requiresApproval: false,
  },
  
  // Analytics Tools (unified)
  analytics_query: {
    name: 'analytics_query',
    effect: 'read', concurrencySafe: true,
    description: 'Read saved campaign/lead analytics or the canonical outreach report with delivery receipts, distinct responding recipients, failures, next retries, import/account/date filters and a dashboard link. Acceptance is not confirmed delivery. Defaults to this conversation; use all_owned only for an explicit account-wide request.',
    agents: ['performance_marketing', 'outreach', 'lead_generation','orchestrator'],
    requiresApproval: false,
  },

  // Data Query Tools
  stop_ads: {
    name: 'stop_ads', description: 'Request explicit confirmation to stop an exact saved paid campaign on selected platforms. Queued or gated does not mean provider-confirmed paused.',
    agents: ['performance_marketing'], requiresApproval: true,
  },
  query_ad_campaigns: {
    name: 'query_ad_campaigns',
    description: 'Read-only lookup of owned saved paid campaigns by exact ID or name with pagination. Resolve the exact campaign before changes. Status is last recorded, not live provider verification.',
    agents: ['performance_marketing'],
    requiresApproval: false,
  },
  query_leads: {
    name: 'query_leads',
    description: 'Query, search, or filter existing leads generated or saved in the database. Use this when the user asks for the list of lead names, leads with emails, phone numbers, or details about specific leads.',
    agents: ['lead_generation', 'outreach', 'performance_marketing'],
    requiresApproval: false,
  },
  query_icp_profiles: {
    name: 'query_icp_profiles',
    description: 'Query existing Ideal Customer Profiles (ICPs) created by the user. Use this when the user asks about previously defined target audiences or campaign criteria.',
    agents: ['icp_generation', 'lead_generation', 'orchestrator'],
    requiresApproval: false,
  },
  get_lead_shortlist: { name: 'get_lead_shortlist', description: 'Read the current owned campaign lead shortlist without searching or sending.', agents: ['lead_generation'], requiresApproval: false },
  revise_lead_shortlist: { name: 'revise_lead_shortlist', description: 'Revise only the current lead selection on explicit request; never scrape or send messages.', agents: ['lead_generation'], requiresApproval: false },
  query_scheduled_posts: { name: 'query_scheduled_posts', description: 'Read owned scheduled posts, exact asset IDs and scheduled times with pagination.', agents: ['content_studio'], requiresApproval: false },
  edit_saved_content: { name: 'edit_saved_content', description: 'Edit requested text on the same owned saved asset with version checks; invalidate approval and never publish.', agents: ['content_studio'], requiresApproval: false },
  change_scheduled_post: { name: 'change_scheduled_post', description: 'Cancel or reschedule one exact owned reviewed scheduled post on explicit request, never an entire campaign.', agents: ['content_studio'], requiresApproval: false },
  query_content_assets: {
    name: 'query_content_assets',
    description: 'Query generated content assets such as social posts, email templates, SMS templates, ads, or blog posts. Use this when the user asks to see or list previously generated content.',
    agents: ['content_studio', 'outreach', 'performance_marketing'],
    requiresApproval: false,
  },
  query_outreach_campaigns: {
    name: 'query_outreach_campaigns',
    description: 'Query outreach campaigns, tracking stats, or sent message history. Use this when the user asks about active outreach campaigns, sent count, delivery stats, or sent message logs.',
    agents: ['outreach', 'performance_marketing'],
    requiresApproval: false,
  },
  check_integration_status: {
    name: 'check_integration_status',
    description: 'Check platform connection and saved ad account selections. Meta returns saved account/Page choices; Google returns its configured customer only. Saved choices are not live eligibility confirmation or approval to publish.',
    agents: ['orchestrator', 'icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing'],
    requiresApproval: false,
  },
  
  // Agent Switching
  switch_agent: {
    name: 'switch_agent',
    description: "Switch the active agent to a specialized agent better suited for the user's request.",
    agents: ['orchestrator', 'supervisor'],
    requiresApproval: false,
  },
  suggest_switch_agents: {
    name: 'suggest_switch_agents',
    description: 'Suggest switching to one or more other agents when the current agent cannot proceed due to missing prerequisites (e.g., no leads for outreach, no ICP for lead gen). Use this to proactively guide the user to the right agent with a helpful message and action buttons.',
    agents: ['orchestrator', 'supervisor', 'icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing'],
    requiresApproval: false,
  },
  tasks_completed: {
    name: 'tasks_completed',
    description: "Signal that all assigned tasks have been completed successfully. Call this ONLY when ALL tasks the user requested from you are fully done — not after each individual reply or tool call. This triggers the pipeline to advance to the next agent if one is queued.",
    agents: ['lead_generation', 'content_studio', 'outreach', 'performance_marketing'],
    requiresApproval: false,
  },

  list_proposal_templates: {name:'list_proposal_templates',description:'List real proposal templates available to the seller.',agents:['outreach'],requiresApproval:false},
  list_proposal_catalog: {name:'list_proposal_catalog',description:'List tenant-approved proposal services with stable catalog IDs and exact prices.',agents:['outreach'],requiresApproval:false},
  list_proposals: {name:'list_proposals',description:'List or inspect owned saved proposals, their revisions, readiness, and review links.',agents:['outreach'],requiresApproval:false},
  create_proposal_draft: {name:'create_proposal_draft',description:'Create customer-specific proposal drafts for selected campaign leads without sending.',agents:['outreach'],requiresApproval:false},
  refine_proposal_draft: {name:'refine_proposal_draft',description:'Refine selected text in the same proposal draft while preserving approved details and pricing.',agents:['outreach'],requiresApproval:false},
  add_proposal_catalog_items: {name:'add_proposal_catalog_items',description:'Append exact approved services to an owned proposal draft by stable catalog ID and current revision.',agents:['outreach'],requiresApproval:false},
  create_proposal_revision: {name:'create_proposal_revision',description:'Create a full-fidelity draft revision of an exact owned proposal without changing its live customer link.',agents:['outreach'],requiresApproval:false},
  send_proposal: {name:'send_proposal',description:'Prepare a fingerprint-bound proposal delivery for explicit approval, then send once through the reviewed outreach channel.',agents:['outreach'],requiresApproval:true},
  // CRM Tools
  create_crm_reminder: {
    name: 'create_crm_reminder',
    description: 'Create a CRM reminder for a contact (e.g., meeting, follow-up, call, task). Use this when the conversation mentions scheduling a meeting, demo, call, or any time-based action that should be tracked.',
    agents: ['outreach', 'lead_generation', 'orchestrator'],
    requiresApproval: false,
  },
  update_pipeline_status: {
    name: 'update_pipeline_status',
    description: 'Update a contact to a stage key or name from the selected business profile’s saved CRM configuration. Stage types determine Won/Lost outcomes. Use only for an authorized change in deal stage.',
    agents: ['outreach', 'lead_generation', 'orchestrator'],
    requiresApproval: false,
  },
};

/** Explicit read-only capabilities for answer-only turns; unknown tools fail closed. */
export { readOnlyCampaignTools } from './readOnlyCampaignTools.js';

export const agentToolMapping: Record<AgentType, string[]> = {
  orchestrator: ['create_campaign_export','get_campaign_export','query_campaign_customers','query_campaign_history','preview_outreach_retries','get_outreach_retry_preview','get_prepared_outreach','get_outreach_preparation_options','prepare_outreach_campaign','analytics_query','list_contact_workbooks','analyze_contact_files','get_dashboard_operation','review_contact_import','query_assistant_diagnostics','generate_icp', 'save_business_profile', 'switch_agent', 'crawl_website', 'create_crm_reminder', 'update_pipeline_status', 'query_icp_profiles', 'check_integration_status'],
  supervisor: ['switch_agent', 'crawl_website'], // Supervisor delegates, doesn't use tools directly
  icp_generation: ['generate_icp', 'crawl_website', 'save_business_profile', 'suggest_switch_agents', 'query_icp_profiles'],
  lead_generation: ['list_contact_workbooks','analyze_contact_files','get_dashboard_operation','review_contact_import','analytics_query', 'list_available_workflows', 'estimate_lead_search_cost', 'generate_lead_inputs', 'execute_lead_workflow', 'tasks_completed', 'crawl_website', 'suggest_switch_agents', 'create_crm_reminder', 'update_pipeline_status', 'query_leads', 'query_icp_profiles', 'check_integration_status', 'get_lead_shortlist', 'revise_lead_shortlist'],
  content_studio: [
    'get_brandtoolkits',
    'get_brandtoolkit',
    'get_businessprofiles',
    'get_businessprofile',
    'select_brand_toolkit',
    'generate_image',
    'generate_video',
    'generate_image_from_image',
    'generate_video_from_image',
    'generate_social_media_post',
    'generate_social_chat_template',
    'generate_email_template',
    'generate_sms_template',
    'generate_whatsapp_template',
    'generate_ad',
    'generate_blog_post',
    'publish_social_post',
    'tasks_completed',
    'crawl_website',
    'suggest_switch_agents',
    'query_content_assets',
    'query_scheduled_posts', 'edit_saved_content', 'change_scheduled_post',
    'check_integration_status',
  ],
  outreach: ['create_campaign_export','get_campaign_export','query_campaign_customers','query_campaign_history','preview_outreach_retries','get_outreach_retry_preview','get_prepared_outreach','get_outreach_preparation_options','prepare_outreach_campaign','list_contact_workbooks','analyze_contact_files','get_dashboard_operation','review_contact_import','query_assistant_diagnostics','analytics_query', 'list_proposal_templates', 'list_proposal_catalog', 'list_proposals', 'create_proposal_draft', 'refine_proposal_draft', 'add_proposal_catalog_items', 'create_proposal_revision', 'send_proposal', 'send_outreach_messages', 'tasks_completed', 'suggest_switch_agents', 'crawl_website', 'create_crm_reminder', 'update_pipeline_status', 'query_leads', 'query_content_assets', 'query_outreach_campaigns', 'check_integration_status', 'publish_social_post'],
  performance_marketing: ['research_ad_creatives', 'suggest_ad_creative_briefs', 'get_ad_creative_research', 'generate_ad', 'publish_ads', 'publish_meta_ads', 'publish_google_ads', 'stop_ads', 'analytics_query', 'tasks_completed', 'suggest_switch_agents', 'crawl_website', 'query_leads', 'query_ad_campaigns', 'query_outreach_campaigns', 'query_content_assets', 'check_integration_status'],
};

// Check if tool requires approval
export function toolRequiresApproval(toolName: string): boolean {
  return toolMetadata[toolName]?.requiresApproval ?? false;
}

// Get tools that require approval
export function getApprovalRequiredTools(): string[] {
  return Object.entries(toolMetadata)
    .filter(([_, meta]) => meta.requiresApproval)
    .map(([name]) => name);
}

/**
 * Generate a formatted tool description list for an agent's system prompt.
 * Pulls tool names and descriptions from toolMetadata based on agentToolMapping.
 * 
 * @param agentType - The agent type to generate descriptions for
 * @returns A formatted string listing each tool with its description
 */
export function getToolDescriptionsForAgent(agentType: AgentType): string {
  const toolNames = agentToolMapping[agentType] || [];
  return toolNames
    .map((name, i) => {
      const meta = toolMetadata[name];
      if (!meta) return `${i + 1}. ${name}`;
      return `${i + 1}. ${meta.name} - ${meta.description}`;
    })
    .join('\n');
}

// ========== Tool Context Interface ==========

/**
 * Context object passed to all tool executors
 * Contains user/thread identification and optional state data
 * 
 * @example
 * ```typescript
 * const context: ToolContext = {
 *   userId: 123,
 *   threadId: 456,
 *   icpProfile: currentState.icpProfile,
 *   brandToolkit: currentState.brandToolkit,
 * };
 * const tools = createTools(context);
 * ```
 */
export interface ToolContext {
  /** Validated semantic interpretation of this turn; never execution consent. */
  intentAnalysis?: import('../routerSchema.js').RouterOutput;
  /** Database user ID */
  userId: number;
  /** Chat thread ID */
  threadId: number;
  /** Durable widget receipt when execution originated from an inline widget. */
  widgetId?: number;
  /** Optional workflow session ID */
  workflowId?: string;
  /** Correlation identity inherited from the isolated orchestration run. */
  runContext?: RunContext;
  /** Current ICP profile (if generated) */
  icpProfile?: ICPProfile | null;
  /** Selected brand toolkit (if any) */
  brandToolkit?: BrandToolkit | null;
  /** Tenant-owned approved business profile used for this generation turn. */
  companyProfile?: CompanyProfile | null;
  /** Complete prompt block resolved from the authoritative business + brand records. */
  brandContextPrompt?: string;
  /** Immutable business/brand context and provenance for generated-asset persistence. */
  brandContextSnapshot?: Record<string, unknown>;
  /** Generated lead inputs (if any) */
  leadInputs?: LeadInput[];
  /** Recent conversation messages for context */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conversationHistory?: any[];
  /** Account/thread-owned reviews loaded by ThreadService; defaults, never approval. */
  savedToolActions?: Array<{
    widgetId: number;
    toolName: string;
    status: string;
    formValues: Record<string, unknown>;
    submittedValues?: Record<string, unknown> | null;
    userId?: number;
    threadId?: number;
  }>;
  /** Selected workflow IDs for execution */
  selectedWorkflows?: string[];
  /** The awaiting approval, read-only context (never consent). */
  pendingApproval?: PendingApproval | null;
  /** Exact lead selection bound to this campaign turn. */
  selectedLeadIds?: number[];
}
