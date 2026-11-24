/**
 * Mastra Content Studio Agent — Alex
 * Migrated to extend BaseAgent (Phase 1 refactoring).
 *
 * Unique logic preserved:
 *  - buildSystemPrompt()           — Alex's full content studio prompt (largest in system)
 *  - getTools()                    — full content tool registry (20 tools)
 *  - preProcess()                  — brand toolkit check, auto-selection, generic request detection
 *  - _handleToolResult()           — track updatedBrandToolkit, hasCompletedPrimaryWork, requiresApproval
 *  - _handleToolCall()             — guard premature tasks_completed
 *  - buildActionButtons()          — brand toolkit picker, approval, content type buttons
 *  - buildReturnState()            — return brandToolkit, requiresApproval, pendingApproval
 *
 * Backward-compatible export: runContentAgent(state) is still exported.
 */

import type { AgentState, ActionButton, BrandToolkit, CompanyProfile } from '../state.js';
import type { AgentType } from '../state.js';
import type { ToolContext } from '../tools/toolRegistry.js';
import type { ToolCallResult } from '../utils/toolCallingLoop.js';
import type { AgentRunResult } from './BaseAgent.js';
import {
  BaseAgent,
  hasSuccessfulWidgetContinuation,
  shouldAutoCompleteWidgetContinuation,
  type PreProcessResult,
} from './BaseAgent.js';
import {
  selectBrandToolkitTool,
  getBrandToolkitsTool,
  getBrandToolkitTool,
  getBusinessProfilesTool,
  getBusinessProfileTool,
  generateImageTool,
  generateVideoTool,
  generateImageFromImageTool,
  generateVideoFromImageTool,
  generateSocialMediaPostTool,
  generateSocialChatTemplateTool,
  generateBlogPostTool,
  publishSocialPostTool,
  generateWhatsappTemplateTool,
} from '../tools/contentTools.js';
import { generateEmailTemplateTool, generateSmsTemplateTool } from '../tools/outreachTools.js';
import { generateAdTool } from '../tools/adsTools.js';
import {
  ContentBrandContextError,
  brandContextSnapshot,
  formatContentBrandContext,
  resolveContentBrandContext,
} from '../../services/content/ContentBrandContextService.js';
import { crawlWebsiteTool } from '../tools/icpTools.js';
import { tasksCompletedTool, suggestSwitchAgentsTool } from '../tools/controlTools.js';
import { queryContentAssetsTool } from '../tools/dataQueryTools.js';
import { queryScheduledPostsTool, editSavedContentTool, changeScheduledPostTool } from '../tools/contentManagementTools.js';
import { checkIntegrationStatusTool } from '../tools/integrationTools.js';
import { webSocketEmitter } from '../../services/agents/WebSocketEmitter.js';
import { buildAgentContext } from '../utils/contextManager.js';
import { buildPipelineStatusPrompt } from '../utils/pipelinePrompt.js';
import { getToolDescriptionsForAgent } from '../tools/toolRegistry.js';
import { logger } from '../../utils/logger.js';
import { toolHasWidget } from '../../shared/toolWidgetMap.js';
import { executeSelectBrandToolkit } from '../tools/executors/contentExecutor.js';

// ── Content Action Buttons ────────────────────────────────────────────

const CONTENT_ACTION_BUTTONS: ActionButton[] = [
  { id: 'create_social_post', label: 'Social Post', action: 'GENERATE_SOCIAL_POST', type: 'primary' as const, data: { prompt: 'Create a social media post' } },
  { id: 'create_email', label: 'Email Template', action: 'GENERATE_EMAIL_TEMPLATE', type: 'primary' as const, data: { prompt: 'Create an email template' } },
  { id: 'create_sms', label: 'SMS Template', action: 'GENERATE_SMS_TEMPLATE', type: 'primary' as const, data: { prompt: 'Create an SMS template' } },
  { id: 'create_whatsapp', label: 'WhatsApp Template', action: 'GENERATE_WHATSAPP_TEMPLATE', type: 'primary' as const, data: { prompt: 'Create a WhatsApp template' } },
  { id: 'create_ad', label: 'Ad Copy', action: 'GENERATE_AD_COPY', type: 'primary' as const, data: { prompt: 'Create an ad copy' } },
  { id: 'create_blog', label: 'Blog Post', action: 'GENERATE_BLOG_POST', type: 'primary' as const, data: { prompt: 'Create a blog post' } },
  { id: 'create_image', label: 'Image', action: 'GENERATE_IMAGE', type: 'secondary' as const, data: { prompt: 'Generate a marketing image' } },
  { id: 'create_social_dm', label: 'Social DM', action: 'GENERATE_SOCIAL_MESSAGE', type: 'secondary' as const, data: { prompt: 'Create a social media DM template' } },
];

const CONTENT_GEN_TOOLS = [
  'generate_social_media_post', 'generate_social_chat_template',
  'generate_email_template', 'generate_sms_template',
  'generate_ad', 'generate_blog_post',
  'generate_image', 'generate_video',
  'generate_image_from_image', 'generate_video_from_image',
  'generate_whatsapp_template',
];

/** A generation review is a proposed action, not an already-generated asset. */
function generationReviewToRevise(state: AgentState) {
  const intent = state.intentAnalysis?.semanticRequest;
  if (intent?.contentOperation !== 'revise_review' || intent.generationReviewId === null) return undefined;
  const id = intent.generationReviewId;
  const review = [...(state.savedToolActions || [])]
    .filter(action => (action.userId === undefined || action.userId === state.userId)
      && (action.threadId === undefined || action.threadId === state.threadId)
      && action.widgetId === id)
    .sort((a, b) => b.widgetId - a.widgetId)[0];
  return review && ['active', 'draft'].includes(review.status) && CONTENT_GEN_TOOLS.includes(review.toolName)
    ? review : undefined;
}

// ── System Prompt ──────────────────────────────────────────────────────

function buildContentSystemPrompt(state: AgentState): string {
  const toolDescriptions = getToolDescriptionsForAgent('content_studio');

  let prompt = `You're Alex, a creative content strategist. Be enthusiastic, conversational, and creative.

COMMUNICATION STYLE:
- Be enthusiastic and creative
- Use conversational language
- Share your creative process in a friendly way
- Celebrate good ideas and build on them

What you can help with:
- Social media posts (universal content that works across all platforms)
- Email templates that get opened and read
- SMS marketing messages
- WhatsApp Business templates using the \`generate_whatsapp_template\` tool
- Blog posts and long-form articles
- Social DMs and chat templates for direct outreach
- Creative concepts for visual content
- AI-generated images and videos
- Ad copy and creatives for Meta/Facebook Ads
- Direct social post publishing to Facebook, Instagram, YouTube, LinkedIn, or Twitter using the \`publish_social_post\` tool

**SOCIAL POST PUBLISHING & SCHEDULING:**
When the user asks you to publish a social media post/video or put it live on Facebook, Instagram, YouTube, LinkedIn, or Twitter:
1. Ensure you have the content asset ID (from previously generated content). If not found in recent history or context, ask the user or look up existing content assets using "query_content_assets".
2. Call the \`publish_social_post\` tool with the appropriate \`content_asset_id\`. For multiple Facebook or Instagram destinations, provide \`targets\`; the review widget lets the user adjust each account, caption, format, and network option before approval.
3. To schedule a post for later, pass the "scheduled_for" parameter as an ISO timestamp (e.g., "2026-07-15T09:00:00Z").
4. Inform the user that the post is ready to be reviewed and confirmed via the interactive Publish Social Post widget shown below the message bubble. They can modify captions, adjust platform destinations, or set a scheduling time inside the widget before confirming.

**INTEGRATION STATUS CHECK:**
- Before publishing social posts, ALWAYS call "check_integration_status" to check if the target platform is integrated.
- If a platform is not connected, inform the user and direct them to connect it in Settings → Integrations.

**EXISTING CONTENT AND CALENDAR MANAGEMENT:**
- Calendar questions (including tomorrow/this week) use query_scheduled_posts with timezone-qualified bounds; do not generate or publish. State the timezone if it is not known and ask for it when necessary.
- Resolve an exact owned asset ID before changing anything; query_content_assets supplies saved content and version. Ambiguous references require clarification, not a guess.
- Management defaults to current_campaign scope. Use all_owned only if the user explicitly requests content outside this campaign. Schedule changes must include the exact expected_version and expected_scheduled_for returned by query_scheduled_posts; never guess either value.
- Edit requests for an existing saved draft use edit_saved_content with its current expected_version and only the requested text fields. Never generate a replacement asset. Media remains unchanged, and the saved edit needs fresh approval before publishing.
- A pending generation review/card is NOT a saved content asset. Its review ID must never be used as asset_id. To revise an unexecuted review, call its original generation tool with the revised settings; this prepares a fresh review, not an asset edit. Preserve unchanged fields and exact quoted CTA text.
- Moving or cancelling a scheduled post uses change_scheduled_post only on explicit request and only after resolving its exact destination. This changes an existing reviewed schedule, not a campaign. A failed or ambiguous transition means nothing was changed; explain the error. Never claim provider deletion or a live publish.
- For a scheduled edit, explain it must first be cancelled; do not cancel implicitly as part of editing. Never call tasks_completed for a calendar lookup or saved-content management task.

**TOOL SAFETY RULES:**
- NEVER call a campaign execution tool ("publish_social_post") when the user is asking a question about existing data or integration status.
- If the user asks "show me the generated posts" → call query_content_assets, NOT publish_social_post.
- If the user asks "is my Facebook connected?" → call check_integration_status, NOT publish_social_post.
- When you call a tool that requires confirmation (like publish_social_post), the system will automatically render an interactive confirmation widget below the message bubble. Tell the user they can review and submit the action directly inside that widget.

**OUTREACH CAMPAIGN WORKFLOW:**
When user requests "create outreach campaign", "personalized outreach", or similar:
1. First check if Brand Toolkit is selected - if not, prompt for selection
2. Once Brand Toolkit is ready (or skipped), create ALL of these in order:
    a. Email template using generate_email_template
    b. SMS template using generate_sms_template
    c. WhatsApp template using generate_whatsapp_template
    d. Social media post using generate_social_media_post (generates universal content)
3. Present all content for review

**AD CAMPAIGN WORKFLOW:**
When user requests "create ads", "ad campaign", "ad creative", or similar:
1. First check if Brand Toolkit is selected - if not, prompt for selection
2. Once Brand Toolkit is ready (or skipped), use generate_ad tool to create ad creatives
3. Generate ad copy with headlines, descriptions, CTAs, and image prompts for Meta/Facebook
4. After ad creatives are ready, inform user they can proceed to Performance Marketing to publish

**CRITICAL - ALWAYS ASK BEFORE GENERATING:**
When the user first arrives or sends a general request like "create content", "help me with content", "I need content":
- DO NOT immediately call any generation tool
- Instead, ask what type of content they'd like with clear options
- Only call a generation tool when the user EXPLICITLY requests a specific content type

**TOOL SELECTION GUIDE — Use EXACTLY the right tool:**
| User says... | Tool to call |
|---|---|
| "social post", "caption", "LinkedIn post" | generate_social_media_post |
| "DM", "direct message", "chat template" | generate_social_chat_template |
| "email", "email template" | generate_email_template |
| "SMS", "text message" | generate_sms_template |
| "WhatsApp", "WhatsApp template", "WABA" | generate_whatsapp_template |
| "ad copy", "ad creative", "advertisement" | generate_ad |
| "blog post", "article" | generate_blog_post |
| "image", "AI image" (standalone) | generate_image |
| "video", "AI video" (standalone) | generate_video |
| "image variation" (with existing image) | generate_image_from_image |
| "animate this image" (with existing image) | generate_video_from_image |
| "publish post", "publish to facebook/instagram/youtube", "post this" | publish_social_post |

**CRITICAL DISTINCTIONS:**
- \`generate_social_media_post\` = public BROADCAST content (feed posts, stories, timelines). Use the platform explicitly requested by the user. Use platform='all' only for explicitly universal/multi-platform copy or when no specific platform is requested.
- \`generate_social_chat_template\` = PRIVATE DM/chat messages (direct inbox messages, outreach DMs). NEVER use for public posts.
- \`generate_ad\` = paid advertising copy (headlines, descriptions, CTAs for Meta/Google ads). NOT for social posts.
- For \`generate_ad\`, set number_of_variations to the user's exact requested ad-copy count (1–5). Do not confuse this with image_count or video_count.
- \`generate_blog_post\` = long-form written articles. NOT for social posts or emails.
- \`generate_image\` / \`generate_video\` = standalone media generation ONLY when user explicitly asks for just an image or video.
- \`generate_image_from_image\` / \`generate_video_from_image\` = ONLY when user provides an existing image URL.
- For text tools, accompanying image/video generation is opt-in. Set auto_generate_image/auto_generate_video=true only for media requested by the user, and keep the setting visible in the review. Do not add a standalone media call for the same companion asset.

**IMAGE/VIDEO GENERATION:**
For text content, default auto_generate_image=false and auto_generate_video=false. Enable companion media only when requested. SMS means text; an MMS image requires an explicit reviewed opt-in.
For generate_ad with ad_format=text, always set auto_generate_image=false and auto_generate_video=false even if the user did not separately say "no image".
Set include_image_prompt=true only when the user requests an image or image prompt. Preserve all explicit media exclusions.
Standalone image/video generation tools (generate_image, generate_video) are ONLY for when the user explicitly asks to create just an image or video on its own.
When the user accepts saved media defaults, omit provider/model from the tool arguments. The server resolves the configured provider and model and puts supported settings in the review; do not perform repeated lookups or ask the user for those defaults. Do not guess a cheapest model or unsupported resolution. Google selects Gemini/Vertex for images and Veo/Vertex for videos. OpenRouter provides multiple routed models: Seedream is ByteDance's image family and Seedance is ByteDance's video family. When the user names a provider or model, pass both provider and model fields to the media tool; never guess a model ID that was not offered by the tool or review widget.

**CRITICAL - CONTENT GENERATION REVIEW:**
Content-generation tools open an interactive review card before execution.
Call the appropriate tool ONCE as soon as you understand the requested content and can infer sensible defaults. For a request naming multiple content types, call each requested generation tool in the same tool-call response, preparing one review per type. Pending reviews for other types do not prevent preparing the remaining requested reviews. Preserve shared campaign identity and literal content requirements in every review.
Do NOT ask for a separate natural-language confirmation before calling a widget-backed tool; the review card is the single confirmation surface.
If the tool reports pendingWidget=true, clearly state that only the settings are prepared and that no content or media has been generated yet.

--- IMAGE GENERATION (generate_image / generate_image_from_image) ---
Prepare these settings for the review card:
- **prompt** (REQUIRED): The detailed image description
- **provider/model**: Saved image default, or an explicit Google/OpenRouter model override when requested
- **aspect_ratio**: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, or 21:9 (default: 1:1)
- **image_size**: 1K (1024px), 2K (2048px), or 4K (4096px) (default: 1K)
- **person_generation**: ALLOW_ALL, ALLOW_ADULT, or DONT_ALLOW (default: ALLOW_ALL)
- **include_brand_logo**: false when the user excludes logos, watermark, branding or text.
- **negative_prompt**: What to exclude from the image (optional)

--- VIDEO GENERATION (generate_video / generate_video_from_image) ---
Prepare these settings for the review card:
- **prompt** (REQUIRED): The detailed video description
- **provider/model**: Saved video default, or an explicit Google/OpenRouter model override (including Seedance) when requested
- **aspect_ratio**: 16:9 (landscape) or 9:16 (portrait) (default: 16:9)
- **resolution**: 720p or 1080p (default: 720p)
- **duration_seconds**: Use supported provider durations. Google Veo supports 4, 6 or 8 seconds; use 8 when unspecified. The review resolves saved provider capabilities.
- **number_of_videos**: Use the selected provider maximum (default: 1)
- **person_generation**: allow_adult or dont_allow (default: allow_adult)
- **include_brand_logo**: false when the user excludes logos, watermark, branding or text.
- **negative_prompt**: What to exclude (optional)
- **generate_audio**: Whether to include audio (default: false)

--- EMAIL TEMPLATE (generate_email_template) ---
Prepare these settings for the review card:
- **sender_business_name**: Exact business explicitly requested as sender for this campaign; do not substitute an unrelated workspace brand.
- **recipient_role** (REQUIRED): Who is the email for (e.g. CEO, Marketing Manager)
- **email_type**: cold_outreach, follow_up, newsletter, promotional, introduction, thank_you, invitation, announcement (default: cold_outreach)
- **tone**: professional, friendly, urgent, persuasive, formal, conversational (default: professional)
- **length**: short (2-3 sentences), medium (1-2 paragraphs), long (3+ paragraphs) (default: medium)
- **language**: Language for the email (default: English)
- **subject_line**: Custom subject line or auto-generate (optional)
- **include_personalization**: Include {{first_name}}, {{company_name}} variables (default: true)
- **include_unsubscribe**: Include unsubscribe link (default: true)
- **cta_text**: Custom CTA like "Book a Demo", "Learn More" (optional)
- **auto_generate_image**: Requested accompanying banner image (default: false)
- **include_image_prompt**: Requested image prompt for the email (default: false)
- **sequence_steps**: Number of emails when the user asks for a sequence or drip (e.g. "3-step sequence" → 3; default 1). Never describe several emails in content_instructions; the tool writes and saves one draft per step.
- **step_delay_days**: Days before each follow-up, from the previous email (e.g. "follow-ups 3 and 7 days apart" → [3, 7]).

--- SMS TEMPLATE (generate_sms_template) ---
Prepare these settings for the review card:
- **key_message** (REQUIRED): Main point to convey
- **sms_type**: promotional, transactional, reminder, follow_up, announcement (default: promotional)
- **tone**: professional, casual, urgent, friendly, promotional (default: professional)
- **language**: Language for the SMS (default: English)
- **urgency**: low, medium, high (default: medium)
- **call_to_action**: Desired action like "Visit our website", "Reply YES" (optional)
- **include_link**: Include a {{link}} placeholder (default: false)
- **include_personalization**: Include {{first_name}} variable (default: false)
- **auto_generate_image**: Requested MMS image (default: false)
- **include_image_prompt**: Requested MMS image prompt (default: false)

--- SOCIAL MEDIA POST (generate_social_media_post) ---
Preserve the user's requested platform. Prepare these settings for the review card:
- **topic** (REQUIRED): What the post is about
- **tone**: professional, casual, funny, inspirational, informative, provocative (default: professional)
- **length**: short (1-2 lines), medium (3-5 lines), long (6+ lines) (default: medium)
- **language**: Language for the post (default: English)
- **post_format**: text, carousel, story, reel (default: text)
- **include_emojis**: Include emojis (default: true)
- **include_cta**: Include call-to-action (default: true)
- **hashtags**: Include hashtags (default: true)
- **number_of_hashtags**: How many hashtags (1-30, default: 5)
- **number_of_posts**: For a content plan, calendar or series ("30-day Instagram plan", "a week of LinkedIn posts"), the number of separate posts (1-30, e.g. 30 for 30 days). Call generate_social_media_post ONCE with this count; the server writes, checks and saves each post separately against the platform limit (Instagram 2,200, X 280, LinkedIn 3,000 characters per post). Never put several posts or a whole plan into one caption, and never write the plan only as chat text when the user asked you to create it. For more than 30 posts, prepare 30 and say the rest can be generated next.
- **auto_generate_image**: Requested accompanying image (default: false)
- **auto_generate_video**: Auto-generate an AI video (default: false)

--- SOCIAL DM / CHAT MESSAGE (generate_social_chat_template) ---
Prepare these settings for the review card:
- **platform** (REQUIRED): linkedin, instagram, twitter, messenger
- **cta_text**: Exact requested CTA including punctuation; never paraphrase.
- **content_instructions**: Preserve all requirements, including fictional designation, tone and exclusions.
- **objective** (REQUIRED): Goal of the message
- **message_style**: introduction, follow_up, pitch, thank_you, cold_outreach, networking, partnership (default: introduction)
- **tone**: professional, friendly, casual, persuasive, witty, empathetic (default: professional)
- **language**: Language for the message (default: English)
- **urgency**: low, medium, high (default: low)
- **recipient_context**: Context about the recipient (optional)
- **include_personalization**: Include template variables (default: true)
- **include_follow_ups**: Generate follow-up variations (default: false)
- **number_of_follow_ups**: How many follow-ups (1-5, default: 2)
- **auto_generate_image**: Requested accompanying image (default: false)

--- AD COPY (generate_ad) ---
Prepare these settings for the review card:
- **platform** (REQUIRED): meta, google, or linkedin
- **objective**: awareness, traffic, engagement, leads, sales, app_installs (default: traffic)
- **ad_format**: image, carousel, video, text (default: image)
- **tone**: professional, casual, urgent, inspiring, informative, bold (default: professional)
- **language**: Language for the ad (default: English)
- **cta_type**: learn_more, shop_now, sign_up, book_now, contact_us, download (default: learn_more)
- **headline**: Custom headline or auto-generate (optional)
- **description_text**: Custom primary text or auto-generate (optional)
- **target_audience**: Target audience for optimization (optional)
- **include_image_prompt**: Requested image prompt for the ad (default: false)
- **auto_generate_image**: Auto-generate ad image (default: false)
- **auto_generate_video**: Auto-generate ad video (default: false)

--- BLOG POST (generate_blog_post) ---
Prepare these settings for the review card:
- **topic** (REQUIRED): The blog post topic or title idea
- **tone**: professional, casual, informative, inspirational, conversational, authoritative (default: professional)
- **length**: short (500-800 words), medium (1000-1500 words), long (2000-3000 words) (default: medium)
- **language**: Language for the blog (default: English)
- **target_audience**: Description of the target audience (optional)
- **seo_keywords**: SEO keywords to incorporate (optional)
- **include_meta_description**: Generate SEO meta description (default: true)
- **include_image_prompt**: Requested featured image prompt (default: false)
- **auto_generate_image**: Requested featured image (default: false)

**REVIEW WORKFLOW (applies to ALL content tools):**
1. When the user requests a specific content type, infer reasonable defaults from the ICP and Brand Toolkit and call the matching tool exactly once.
2. The tool creates the review card; do not create a second settings summary or ask for confirmation in chat.
3. Tell the user to adjust the card if needed and select "Confirm and run" there.
4. A pending review is not a completed generation. Only say content was created after the tool returns an actual completed result.

**BRAND TOOLKIT WORKFLOW:**
- If Brand Toolkit is ALREADY SELECTED (shown in context below), USE IT immediately without asking
- If user says "use toolkit X" or "select toolkit X" or mentions a specific toolkit name:
  1. IMMEDIATELY call select_brand_toolkit with action: "select" and toolkit_name: "<name user mentioned>"
  2. After selection, proceed to generate content with action buttons
- If NO Brand Toolkit is selected and user requests content WITHOUT mentioning a toolkit:
  1. Call get_brandtoolkits to list available toolkits
  2. If only 1 toolkit exists, auto-select it using select_brand_toolkit
  3. If multiple toolkits exist, present the list and ask the user to choose one, create a new one, or skip
  4. If no toolkits exist, offer to create one or skip
- After toolkit selection, IMMEDIATELY proceed to generate the requested content
- NEVER ask about toolkit selection more than once - if you've already asked, proceed to content generation

**DATA FETCHING - USE TOOLS, NOT PRE-LOADED CONTEXT:**
- Use get_brandtoolkits to list all brand toolkits and get_brandtoolkit to get details of a specific one
- Use get_businessprofiles to list all business profiles and get_businessprofile to get details of a specific one
- Call these tools when you need business context or brand details for content personalization
- Do NOT assume data is pre-loaded in the context — always fetch fresh data using these tools when needed

YOUR TOOLS - YOU MUST USE THESE:
${toolDescriptions}

CRITICAL RULES:
- Specific content request → call the tool once to open its prefilled review card.
- General request → present content type options first (DO NOT call any tool).
- NEVER write content in your response — ALWAYS use tools.
- Preserve the requested platform; never replace a specific platform with 'all'.
- For email, blogs, social posts, DMs and ads, copy an exact requested CTA verbatim into cta_text, including its punctuation. Put ALL other active writing constraints (such as calm practical tone, no emoji, no unverified claims, recipient placeholders, and audience details) in content_instructions. A general tone enum or brand default must not replace these instructions. Populate email_body_points from the actual task rather than leaving it blank when details are available. For email placeholders use {{first_name}} or {{full_name}} for the recipient and {{company_name}} for their organization, regardless of industry. Never invent custom template variable names.
- Default auto_generate_image=false and include_image_prompt=false. Enable only when requested.
- Standalone generate_image/generate_video are ONLY for explicit image/video-only requests.
- Infer tone from Brand Toolkit's brandTone, target audience from ICP's targetAudience, industry from ICP's industry.
- While a review card is pending, never say content was generated or prepared; say the settings are ready for review.
- After actual generation: "Here's what I created. Let me know if you'd like changes."

QUESTIONS POLICY:
- Infer tone from Brand Toolkit's brandTone, target audience from ICP's targetAudience, industry from ICP's industry.
- Do not ask a confirmation question when a review widget can collect and confirm the settings.
- Ask only for a genuinely required value that cannot be inferred and is required by the tool schema.
- After actual generation, say "Here's what I created. Let me know if you'd like changes."

**WEBSITE CRAWLING RULES:**
- If the user provides a website URL, call crawl_website to fetch the content
- The crawl_website tool ONLY adds website content to the conversation context — it does NOT trigger any other action
- After crawling, present a summary of what you learned from the website to the user
- You CAN access websites using the crawl_website tool — NEVER say you cannot browse or access websites

**DATA QUERIES:**
- If the user asks about previously generated content, posts, emails, SMS, ad copies, or blogs, call the "query_content_assets" tool.
- NEVER generate new content when the user is asking about content that already exists.
- Respond with a clear markdown table or list summarizing the query results.

**TASK COMPLETION:**
When you have completed ALL the tasks the user asked you to do (e.g., generated all requested templates, content, or ad creatives), ask the user: "Are you satisfied with the results, or would you like any changes?" and WAIT for their response. Only call tasks_completed after the user confirms they are satisfied.
NEVER call tasks_completed after selecting a brand toolkit, showing settings, or asking for approval. Only call it after the requested content has actually been generated AND the user confirmed satisfaction.`;

  prompt += `

RESPONSIBILITY BOUNDARY:
- Content Studio may report only content and media resources returned by its tools.
- NEVER claim that ad accounts are connected, campaign drafts exist, budgets or dates are configured, landing pages or policies are verified, or Meta/Google are ready. Those checks belong to the Performance Marketing Agent and require its actual tool or provider receipts.
- A planned handoff is not a completed handoff. Do not say another agent has taken over unless tasks_completed succeeds or the system advances the pipeline.`;

  // Pipeline context
  prompt += buildPipelineStatusPrompt(state, {
    workLabel: 'content generation',
    handoffExample: nextName => `I've generated the outreach templates for your email campaign and saved them to your library. They are looking great! Let me hand you over to ${nextName} who will set up the sequence and help you send these out. ${nextName}, over to you!`,
  });

  // Dynamic context
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contextInfo = buildAgentContext(state as any, {
    businessInstruction: 'Use business context to personalize content.',
    icpInstruction: 'Use ICP for understanding target audience.',
    brandLabel: 'BRAND TOOLKIT',
    brandIncludeColors: true,
    brandInstruction: 'Follow these brand guidelines in all content.',
    userInstruction: "Be creative and match Alex's conversational style.",
  });

  if (contextInfo) prompt += `\n\n--- CONTEXT ---${contextInfo}`;

  return prompt;
}

// ── ContentAgent class ─────────────────────────────────────────────────

class ContentAgent extends BaseAgent {
  readonly agentType: AgentType = 'content_studio';
  readonly thinkingMessage = 'Alex is brewing creative ideas...';
  protected readonly widgetCompletionTools = CONTENT_GEN_TOOLS;

  // Per-run mutable state
  private _updatedBrandToolkit: BrandToolkit | undefined;
  private _updatedCompanyProfile: CompanyProfile | undefined;
  private _hasCompletedPrimaryWork = false;
  private _requiresApproval = false;
  private _managementOnly = false;
  private _readOnlyManagement = false;
  private _cancelOnlyManagement = false;
  private _reviewRevision: ReturnType<typeof generationReviewToRevise>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _pendingApproval: any = null;

  protected get intentDomain(): string {
    return 'content creation, ad design, writing posts, or drafting emails/SMS templates';
  }

  buildSystemPrompt(state: AgentState): string {
    const prompt = buildContentSystemPrompt(state);
    return this._reviewRevision
      ? `${prompt}\n\nCURRENT REVIEW REVISION: Review #${this._reviewRevision.widgetId} has not executed. Prepare revised settings using ${this._reviewRevision.toolName}; do not query or edit a saved asset. Prior settings: ${JSON.stringify(this._reviewRevision.submittedValues || this._reviewRevision.formValues)}`
      : prompt;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTools(_toolContext: ToolContext): Record<string, any> {
    if (this._managementOnly) return {
      query_content_assets: queryContentAssetsTool,
      query_scheduled_posts: queryScheduledPostsTool,
      ...(this._readOnlyManagement ? {
        check_integration_status: checkIntegrationStatusTool,
        get_brandtoolkits: getBrandToolkitsTool, get_brandtoolkit: getBrandToolkitTool,
        get_businessprofiles: getBusinessProfilesTool, get_businessprofile: getBusinessProfileTool,
      } : {}),
      ...(this._readOnlyManagement ? {} : { change_scheduled_post: changeScheduledPostTool }),
      ...(this._readOnlyManagement || this._cancelOnlyManagement ? {} : { edit_saved_content: editSavedContentTool }),
    };
    const tools = {
      select_brand_toolkit: selectBrandToolkitTool,
      get_brandtoolkits: getBrandToolkitsTool,
      get_brandtoolkit: getBrandToolkitTool,
      get_businessprofiles: getBusinessProfilesTool,
      get_businessprofile: getBusinessProfileTool,
      generate_image: generateImageTool,
      generate_video: generateVideoTool,
      generate_image_from_image: generateImageFromImageTool,
      generate_video_from_image: generateVideoFromImageTool,
      generate_social_media_post: generateSocialMediaPostTool,
      generate_social_chat_template: generateSocialChatTemplateTool,
      generate_email_template: generateEmailTemplateTool,
      generate_sms_template: generateSmsTemplateTool,
      generate_whatsapp_template: generateWhatsappTemplateTool,
      generate_ad: generateAdTool,
      generate_blog_post: generateBlogPostTool,
      publish_social_post: publishSocialPostTool,
      tasks_completed: tasksCompletedTool,
      crawl_website: crawlWebsiteTool,
      suggest_switch_agents: suggestSwitchAgentsTool,
      query_content_assets: queryContentAssetsTool,
      query_scheduled_posts: queryScheduledPostsTool,
      edit_saved_content: editSavedContentTool,
      change_scheduled_post: changeScheduledPostTool,
      check_integration_status: checkIntegrationStatusTool,
    };
    return this._reviewRevision
      ? Object.fromEntries(Object.entries(tools).filter(([name]) => name === this._reviewRevision?.toolName))
      : tools;
  }

  /**
   * Pre-process: reset state, handle brand toolkit auto-selection,
   * and detect generic content requests to short-circuit with options menu.
   */
  protected async preProcess(state: AgentState): Promise<PreProcessResult> {
    const { userId, threadId } = state;

    // Reset per-run state
    this._updatedBrandToolkit = state.brandToolkit ?? undefined;
    this._updatedCompanyProfile = state.companyProfile ?? undefined;
    this._hasCompletedPrimaryWork = hasSuccessfulWidgetContinuation(state, CONTENT_GEN_TOOLS);
    this._requiresApproval = false;
    this._pendingApproval = null;
    this._readOnlyManagement = state.intentAnalysis?.action === 'question';
    this._cancelOnlyManagement = state.intentAnalysis?.action === 'cancel';
    this._reviewRevision = !this._readOnlyManagement && !this._cancelOnlyManagement
      ? generationReviewToRevise(state) : undefined;
    // A semantic router can conservatively label a request that first locates
    // an existing asset as content management even when the requested outcome
    // is a new publication review. Keep publish_social_post available for that
    // compound flow; reschedule/cancel/edit-only turns remain isolated below.
    const newPublicationRequested = state.intentAnalysis?.semanticRequest?.contentOperation === 'publish_new';
    this._managementOnly = this._readOnlyManagement
      || (state.intentAnalysis?.contentManagementRequested === true && !newPublicationRequested && !this._reviewRevision)
      || (state.intentAnalysis?.action === 'cancel' && state.intentAnalysis.cancellationScope === 'scheduled_post');
    if (this._managementOnly) {
      this._requiresApproval = state.requiresApproval ?? false;
      this._pendingApproval = state.pendingApproval ?? null;
      this._hasCompletedPrimaryWork = false;
      return {};
    }

    try {
      const resolved = await resolveContentBrandContext(userId, {
        businessProfileId: state.companyProfile?.id,
        brandToolkitId: state.brandToolkit?.id,
      });
      const toolkit = {
        ...resolved.brandToolkit,
        __brandContextPrompt: formatContentBrandContext(resolved),
        __brandContextSnapshot: brandContextSnapshot(resolved),
      } as unknown as BrandToolkit;
      const business = resolved.businessProfile;
      const companyProfile = {
        ...business,
        companyName: business.companyName || business.businessName || business.name || '',
        primaryMarket: business.targetMarket || undefined,
        targetRegions: [],
        keyBuyerRoles: [],
        businessGoals: [],
        preferredChannels: [],
        platforms: [],
      } as unknown as CompanyProfile;
      this._updatedBrandToolkit = toolkit;
      this._updatedCompanyProfile = companyProfile;
      // BaseAgent builds the prompt and tool context after preProcess. Updating
      // this turn's state makes the freshly resolved context available now,
      // rather than one turn later.
      state.brandToolkit = toolkit;
      state.companyProfile = companyProfile;
    } catch (error) {
      if (error instanceof ContentBrandContextError) {
        return {
          earlyResponse: `${error.message} Content generation is paused until approved brand context is available.`,
          earlyActionButtons: [
            {
              id: 'open_brand_toolkit',
              label: 'Open Brand Toolkit',
              action: 'CREATE_BRAND_TOOLKIT',
              type: 'primary',
            },
          ],
          earlyState: {
            brandToolkit: null,
            companyProfile: state.companyProfile,
          },
        };
      }
      // BaseAgent treats a thrown preProcess as optional and carries on. Brand
      // context is mandatory for generation, so stop the turn here instead of
      // letting Alex prepare content without the approved business and brand.
      logger.error({ err: error, userId, threadId }, '[Content Agent] Brand context could not be loaded; generation paused');
      return {
        earlyResponse: 'I could not load your approved business and brand details just now, so I have not prepared or generated any content. Please try again in a moment.',
        earlyActionButtons: [],
        earlyState: {
          brandToolkit: state.brandToolkit,
          companyProfile: state.companyProfile,
          requiresApproval: state.requiresApproval,
          pendingApproval: state.pendingApproval,
          tasksCompleted: false,
        },
      };
    }

    const hasBrandToolkit = !!state.brandToolkit;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolkitSkipped = (state.brandToolkit as any)?.skipped === true;

    // Detect first entry to content agent
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isFirstContentEntry = !state.messages.slice(0, -1).some((msg: any) =>
      msg.agentType === 'content_studio' && msg.role === 'assistant'
    );

    // Reuse the validated model decision; do not classify words a second time.
    const isToolkitSelection = state.intentAnalysis?.semanticRequest?.brandToolkit === 'select';
    const wantsToSkip = state.intentAnalysis?.semanticRequest?.brandToolkit === 'skip';

    // Skip brand toolkit selection
    if (wantsToSkip && !hasBrandToolkit) {
      const skipMsg = `No problem! I'll create content without specific brand guidelines.\n\nWhat would you like me to create for you?`;
      return {
        earlyResponse: skipMsg,
        earlyActionButtons: CONTENT_ACTION_BUTTONS,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        earlyState: { brandToolkit: { skipped: true } as any },
      };
    }

    // On first entry without toolkit, auto-select single or prompt for multiple
    if (!hasBrandToolkit && !toolkitSkipped && !isToolkitSelection && isFirstContentEntry) {
      const toolContext: ToolContext = {
        userId, threadId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        icpProfile: state.icpProfile as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        brandToolkit: state.brandToolkit as any,
      };
      try {
        const listResult = await executeSelectBrandToolkit({ action: 'list' }, toolContext);
        if (listResult.success && listResult.output) {
          const { hasToolkits, toolkits } = listResult.output;

          if (hasToolkits && toolkits?.length === 1) {
            // Auto-select the only toolkit
            const selectResult = await executeSelectBrandToolkit(
              { action: 'select', toolkitId: toolkits[0].id }, toolContext
            );
            const tk = selectResult.output?.selectedToolkit || selectResult.output?.toolkit;
            if (selectResult.success && tk) {
              this._updatedBrandToolkit = tk;
              logger.info({ toolkitName: tk.name }, '[Content Agent] Auto-selected single toolkit');
            }
          } else if (hasToolkits && toolkits?.length > 1) {
            // Multiple toolkits — present picker
            const toolkitButtons: ActionButton[] = [
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ...toolkits.slice(0, 5).map((tk: any) => ({
                id: `toolkit_${tk.id}`,
                label: tk.name,
                action: 'SELECT_BRAND_TOOLKIT' as const,
                type: 'primary' as const,
                data: { action: 'select', toolkit_id: tk.id },
              })),
              { id: 'create_brand_toolkit', label: 'Create New Toolkit', action: 'CREATE_BRAND_TOOLKIT', type: 'secondary' as const, data: { action: 'create' } },
              { id: 'skip_brand_toolkit', label: 'Skip for Now', action: 'SKIP_BRAND_TOOLKIT', type: 'secondary' as const, data: { action: 'skip' } },
            ];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const listStr = toolkits.map((t: any, i: number) => `${i + 1}. **${t.name}**${t.isDefault ? ' (default)' : ''}`).join('\n');
            const pickMsg = `Hey! I found ${toolkits.length} brand toolkits. Which one would you like to use for content creation?\n\n${listStr}\n\nYou can also create a new toolkit or skip to proceed without brand guidelines.`;
            webSocketEmitter.emitAgentStatus(userId, 'content_studio', 'completed', undefined, undefined, threadId);
            return {
              earlyResponse: pickMsg,
              earlyActionButtons: toolkitButtons,
            };
          } else {
            // No toolkits — offer to create or skip
            const noTkMsg = `Hey! I'd love to help you create amazing content!\n\n${listResult.output.message || "You don't have a brand toolkit yet. Would you like to create one for consistent styling, or skip for now?"}`;
            webSocketEmitter.emitAgentStatus(userId, 'content_studio', 'completed', undefined, undefined, threadId);
            return {
              earlyResponse: noTkMsg,
              earlyActionButtons: [
                { id: 'create_brand_toolkit', label: 'Create Brand Toolkit', action: 'CREATE_BRAND_TOOLKIT', type: 'primary' as const, data: { action: 'create' } },
                { id: 'skip_brand_toolkit', label: 'Skip for Now', action: 'SKIP_BRAND_TOOLKIT', type: 'secondary' as const, data: { action: 'skip' } },
              ],
            };
          }
        }
      } catch (err) {
        logger.warn({ err }, '[Content Agent] Brand toolkit check failed');
      }
    }

    // Let Alex interpret the requested content in context and ask a focused
    // question when needed. A keyword list cannot recognize paraphrases.

    // Pass updated toolkit to the run loop via resolvedUserIntent = '' (no-op)
    return {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected _handleToolResult(toolName: string, toolResult: any): void {
    if (toolName === 'select_brand_toolkit' && toolResult.success && toolResult.output?.toolkit) {
      this._updatedBrandToolkit = toolResult.output.toolkit;
    }
    if (CONTENT_GEN_TOOLS.includes(toolName) && toolResult.success && !toolResult.pendingWidget) {
      this._hasCompletedPrimaryWork = true;
    }
    if (toolName === 'publish_social_post' && toolResult.requiresApproval) {
      this._requiresApproval = true;
      this._pendingApproval = { toolName, args: toolResult.output?.args };
    }
  }

  protected _handleToolCall(toolName: string, args?: Record<string, unknown>): boolean {
    if (this._reviewRevision) return toolName === this._reviewRevision.toolName;
    if (this._cancelOnlyManagement && this._managementOnly && !['query_content_assets', 'query_scheduled_posts'].includes(toolName)) {
      return toolName === 'change_scheduled_post' && args?.action === 'cancel';
    }
    if (this._managementOnly && toolName === 'tasks_completed') return false;
    if (toolName === 'tasks_completed' && !this._hasCompletedPrimaryWork) {
      logger.info('[Content Agent] Blocking premature tasks_completed');
      return false;
    }
    return true;
  }

  protected async postProcess(state: AgentState, result: AgentRunResult): Promise<AgentRunResult> {
    if (shouldAutoCompleteWidgetContinuation(state, CONTENT_GEN_TOOLS, result.toolResults)) {
      const nextAgent = state.agentPipeline?.[(state.agentPipelineIndex ?? 0) + 1];
      const nextLabel = nextAgent === 'performance_marketing'
        ? 'the Performance Marketing Agent'
        : nextAgent === 'outreach'
          ? 'the Outreach Agent'
          : 'the next specialist';
      return {
        ...result,
        serverAuthored: true,
        text: `The approved ${state.widgetContinuation!.toolName.replace(/_/g, ' ')} action completed successfully and its durable resources are saved with the IDs reported above. I’m handing the existing campaign to ${nextLabel} for the remaining verified checks. No send, publish, activation, account-readiness, or spend claim has been made.`,
      };
    }
    return result;
  }

  protected buildActionButtons(state: AgentState, toolResults: ToolCallResult[]): ActionButton[] {
    if (this._managementOnly) return [];

    if (this._requiresApproval && this._pendingApproval?.toolName && !toolHasWidget(this._pendingApproval.toolName)) {
      return [
        { id: 'content_approve', label: 'Approve & Publish', action: 'approve_tool', type: 'primary' as const },
        { id: 'content_cancel', label: 'Cancel', action: 'reject_tool', type: 'danger' as const },
      ];
    }

    if (toolResults.length === 0) {
      // No tools called — might be a brand toolkit prompt from LLM
      // Return empty (async LLM check not possible here; keep clean)
      return [];
    }

    // Check if last tool result was brand toolkit listing
    const lastBtResult = [...toolResults].reverse().find(r => r.toolName === 'select_brand_toolkit');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const btOutput = (lastBtResult as any)?.output;
    if (btOutput && !btOutput.selected && !btOutput.skipped) {
      const toolkits = btOutput.toolkits as Array<{ id: number; name: string }>;
      if (toolkits?.length > 0) {
        const buttons: ActionButton[] = toolkits.slice(0, 3).map(tk => ({
          id: `toolkit_${tk.id}`, label: tk.name, action: 'SELECT_BRAND_TOOLKIT',
          type: 'primary' as const, data: { action: 'select', toolkit_id: tk.id },
        }));
        buttons.push({ id: 'skip_brand_toolkit', label: 'Skip (No Brand)', action: 'SKIP_BRAND_TOOLKIT', type: 'secondary' as const, data: { action: 'skip' } });
        return buttons;
      }
    }

    return [];
  }

  protected buildReturnState(_state: AgentState, _result: AgentRunResult): Partial<AgentState> {
    return {
      ...(this._managementOnly ? { currentAgent: _state.currentAgent, tasksCompleted: false } : {}),
      brandToolkit: this._updatedBrandToolkit,
      companyProfile: this._updatedCompanyProfile,
      requiresApproval: this._requiresApproval,
      pendingApproval: this._pendingApproval,
    };
  }

  // Override the toolContext injected to runToolCallingLoop to include updatedBrandToolkit
  // This is done by overriding the run method slightly to pass updated toolkit
  async run(state: AgentState): Promise<Partial<AgentState>> {
    // BaseAgent.run() will call preProcess which sets this._updatedBrandToolkit
    const result = await super.run(state);
    return result;
  }

  protected _fallbackResponse(): string {
    return `I'm ready to help you create amazing content! What would you like me to create?`;
  }
}

// ── Singleton instance ─────────────────────────────────────────────────


// ── Backward-compatible export ─────────────────────────────────────────

export function createContentAgent(): BaseAgent {
  return new ContentAgent();
}

export async function runContentAgent(state: AgentState): Promise<Partial<AgentState>> {
  return createContentAgent().run(state);
}
