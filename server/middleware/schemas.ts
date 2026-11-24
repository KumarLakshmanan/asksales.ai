import { WORKSPACE_TYPE_VALUES, APPLICATION_USE_VALUES, BRAND_IMAGE_LIMITS } from '../../shared/workspaceOnboarding.js';
/**
 * Route Validation Schemas
 * 
 * Zod schemas for validating request bodies, query params, and path params
 * on the most critical API routes.
 */

import { z } from 'zod';
import { passwordFitsBcrypt } from '../../shared/passwords.js';
import { LEAD_STATUSES } from '../../shared/leadStatus.js';
import {validateAutomationDefinition,type AutomationDefinition} from '../../shared/crmAutomations.js';

// AUTH-003: Password strength schema — at least 8 chars with 1 upper, 1 lower, 1 number, 1 special
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

// Top 200 most common passwords (RFC-style blocklist). Keep this list small to avoid log bloat.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty', 'qwerty123', 'abc123', 'letmein', 'welcome', 'monkey', 'dragon',
  '111111', '1234567', 'sunshine', 'princess', 'admin', 'admin123', 'root',
  'toor', 'passw0rd', 'iloveyou', 'trustno1', '000000', '1q2w3e4r', 'qwertyuiop',
  'admin1234', 'P@ssw0rd', 'p@ssw0rd', 'Passw0rd', 'changeme', 'Welcome1', 'welcome1',
  'login', 'starwars', 'passwd', 'hello', 'charlie', 'donald', 'football', 'baseball',
]);

export const passwordSchema = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(PASSWORD_REGEX, 'Password must include uppercase, lowercase, number, and special character')
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'Password is too common')
  .refine(passwordFitsBcrypt, 'Password must fit within 72 UTF-8 bytes; some characters use more than one byte');

// ── Auth Schemas ──────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: passwordSchema,
  name: z.string().trim().min(1, 'Name is required').max(255),
  company: z.string().max(255).optional(),
}).strict();

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
}).strict();

export const googleSignInSchema = z.object({
  credential: z.string().min(100).max(10000),
}).strict();

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
}).strict();

export const resetPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be a 6-digit code'),
  newPassword: passwordSchema,
}).strict();

export const verifyEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  otp: z.string().regex(/^\d{6}$/, 'Verification OTP must be a 6-digit code'),
}).strict();

export const resendVerificationSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
}).strict();

// ── Lead Schemas ──────────────────────────────────────────────────────────────

export const createLeadSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(500),
  firstName: z.string().trim().max(255).optional().nullable(),
  lastName: z.string().trim().max(255).optional().nullable(),
  fullName: z.string().max(500).optional().nullable(),
  email: z.string().email('Invalid email').optional().or(z.literal('')).nullable(),
  phone: z.string().max(50).optional().nullable(),
  company: z.string().max(500).optional().nullable(),
  title: z.string().max(500).optional().nullable(),
  role: z.string().max(500).optional().nullable(),
  headline: z.string().max(1000).optional().nullable(),
  location: z.union([
    z.string().max(1000),
    z.record(z.string(), z.unknown()),
  ]).optional().nullable(),
  website: z.string().max(2000).optional().nullable(),
  linkedin: z.string().max(2000).optional().nullable(),
  linkedinUrl: z.string().max(2000).optional().nullable(),
  linkedinUsername: z.string().max(255).optional().nullable(),
  twitter: z.string().max(2000).optional().nullable(),
  twitterUrl: z.string().max(2000).optional().nullable(),
  twitterHandle: z.string().max(255).optional().nullable(),
  instagram: z.string().max(2000).optional().nullable(),
  instagramUrl: z.string().max(2000).optional().nullable(),
  instagramHandle: z.string().max(255).optional().nullable(),
  facebook: z.string().max(2000).optional().nullable(),
  facebookUrl: z.string().max(2000).optional().nullable(),
  profileId: z.string().max(255).optional().nullable(),
  whatsapp: z.string().max(50).optional().nullable(),
  industry: z.string().max(255).optional().nullable(),
  companyDescription: z.string().max(10000).optional().nullable(),
  companySize: z.string().max(100).optional().nullable(),
  companyDomain: z.string().max(2000).optional().nullable(),
  source: z.string().max(255).optional().nullable(),
  status: z.enum(LEAD_STATUSES).optional().nullable(),
  leadStatus: z.enum(LEAD_STATUSES).optional().nullable(),
  score: z.number().int().min(0).max(100).optional().nullable(),
  fitScore: z.number().int().min(0).max(100).optional().nullable(),
  relevanceScore: z.number().int().min(0).max(100).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  tags: z.array(z.string()).optional().nullable(),
  customFields: z.record(z.string(), z.unknown()).optional().nullable(),
  threadId: z.union([z.string(), z.number()]).optional(),
  campaignId: z.union([z.string(), z.number()]).optional(),
}).strip();

export const updateLeadSchema = createLeadSchema.partial().strip();

export const bulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1, 'At least one ID is required'),
});

export const bulkUpdateSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1, 'At least one ID is required'),
  updates: z.object({
    status: z.enum(LEAD_STATUSES).optional(),
    leadStatus: z.enum(LEAD_STATUSES).optional(),
    score: z.number().int().min(0).max(100).optional().nullable(),
    tags: z.array(z.string().trim().min(1).max(100)).max(50).optional().nullable(),
    notes: z.string().max(5000).optional().nullable(),
    assignedTo: z.number().int().positive().optional().nullable(),
  }).strict().refine((value) => Object.keys(value).length > 0, 'At least one update is required'),
}).strict();

export const verifyLeadsSchema = z.object({
  threadId: z.union([z.string(), z.number()]).optional(),
  executionId: z.union([z.string(), z.number()]).optional(),
  verifications: z.record(
    z.string().regex(/^\d+$/, 'Lead ID must be numeric'),
    z.object({
      status: z.enum(['pending', 'approved', 'rejected']),
      rejectionReason: z.string().trim().max(1000).optional(),
    }).strict(),
  ).refine((value) => Object.keys(value).length <= 500, 'A maximum of 500 leads can be verified at once'),
  stats: z.object({
    total: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  }).optional(),
}).strict();

export const enrichLeadsSchema = z.object({
  leadIds: z.array(z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]))
    .min(1, 'At least one lead is required')
    .max(100, 'A maximum of 100 leads can be enriched at once'),
  threadId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).optional(),
}).strict();

// ── Content Schemas ───────────────────────────────────────────────────────────

export const generateContentSchema = z.object({
  type: z.enum(['email', 'sms', 'social_post', 'ad_copy', 'social_message']),
  prompt: z.string().min(1, 'Prompt is required').max(10000),
  brandToolkitId: z.number().int().positive().optional(),
  templateId: z.number().int().positive().optional(),
  platform: z.string().max(100).optional(),
  tone: z.string().max(100).optional(),
  language: z.string().max(50).optional(),
}).passthrough();

// ── Chat Schemas ──────────────────────────────────────────────────────────────

export const sendMessageSchema = z.object({
  message: z.string().min(1, 'Message is required').max(50000).optional(),
  content: z.string().min(1).max(50000).optional(),
  threadId: z.union([z.string(), z.number()]).optional(),
  attachments: z.array(z.object({
    fileId: z.number().int().positive(),
  }).strict()).max(5).optional(),
  agentType: z.enum([
    'orchestrator', 'supervisor', 'icp_generation', 'lead_generation',
    'content_studio', 'outreach', 'performance_marketing',
  ]).optional(),
}).passthrough().refine((value) => Boolean(value.message || value.content), {
  message: 'Message is required',
});

// ── Outreach Schemas ──────────────────────────────────────────────────────────

export const sendOutreachSchema = z.object({
  leadId: z.number().int().positive(),
  leadName: z.string().trim().max(510).optional(),
  channel: z.enum(['email', 'sms']),
  message: z.string().trim().min(1).max(50000),
  subject: z.string().max(500).optional(),
  imageUrl: z.string().max(2000).optional().nullable(),
  videoUrl: z.string().max(2000).optional().nullable(),
  businessProfileId: z.number().int().positive().optional().nullable(),
  brandToolkitId: z.number().int().positive().optional().nullable(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
}).strict();

export const startOutreachSchema = z.object({
  workflowId: z.string().uuid(),
  useContentStudio: z.boolean().optional().default(false),
  followUpDelayHours: z.number().min(1).max(24 * 30).optional(),
}).strict();

// ── Common Param Schemas ──────────────────────────────────────────────────────

export const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'ID must be a number').transform(Number),
});

export const threadIdParamSchema = z.object({
  threadId: z.string().regex(/^\d+$/, 'Thread ID must be a number').transform(Number),
});

const chatTabThreadIdSchema = z.string()
  .regex(/^\d+$/, 'Thread ID must be a number')
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value) && value > 0, 'Thread ID must be a positive safe integer');

export const chatTabThreadParamSchema = z.object({
  id: chatTabThreadIdSchema,
}).strict();

export const chatTabParamSchema = chatTabThreadParamSchema.extend({
  tabId: z.string().trim().min(1).max(100),
}).strict();

export const userThreadIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'User ID must be a number').transform(Number),
  threadId: z.string().regex(/^\d+$/, 'Thread ID must be a number').transform(Number),
});

// ── Support / Admin Auth Schemas ────────────────────────────────────────────

export const supportLoginSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordSchema,
}).strict();

export const resetMemberPasswordSchema = z.object({
  newPassword: passwordSchema,
}).strict();

export const adminLoginSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(1, 'Password is required'),
});

export const adminResetPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be a 6-digit code'),
  newPassword: passwordSchema,
}).strict();

export const addCreditsSchema = z.object({
  amount: z.number().positive('Amount must be positive').max(1_000_000, 'Max 1,000,000 credits per call'),
  reason: z.string().min(3, 'Reason is required').max(500),
}).strict();

export const adminBootstrapSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(12, 'Bootstrap password must be at least 12 characters'),
  name: z.string().min(1, 'Name is required').max(255),
}).strict();

export const adminCreateSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: passwordSchema,
  name: z.string().min(1, 'Name is required').max(255),
}).strict();

export const adminUpdateSchema = z.object({
  email: z.string().email('Invalid email address').optional(),
  name: z.string().min(1).max(255).optional(),
  role: z.enum(['admin', 'super_admin']).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

// ── Setup / Profile Schemas ───────────────────────────────────────────────────

export const setupCompleteSchema = z.object({
  hasBusinessProfile: z.boolean().optional(),
  hasBrandToolkit: z.boolean().optional(),
}).strict();

// ── Chat Schemas (extended) ───────────────────────────────────────────────────

export const createThreadSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  businessProfileId: z.coerce.number().int().positive().optional(),
  agentType: z.string().max(100).optional(),
  threadId: z.union([z.string(), z.number()]).optional(),
}).passthrough();

export const threadIcpSchema = z.object({
  icp: z.unknown().optional(),
}).passthrough();

export const threadCompactSchema = z.object({}).strict();

const chatTabTypeSchema = z.enum([
  'overview', 'search', 'icp', 'agentchoose', 'leads', 'lead-inputs',
  'outreach', 'analytics', 'campaigns', 'ads', 'leadconfig',
  'content-studio', 'performancemarketing', 'contentpreview',
  'socialpostpreview', 'brandtoolkit', 'emailtemplate', 'smstemplate',
  'socialchattemplate', 'blogpost', 'crm', 'support', 'proposals',
  'content-image', 'content-video', 'content-email', 'content-sms', 'content-whatsapp',
  'content-social', 'content-social-message', 'content-adcopy', 'content-blog',
]);

const persistedTabDataSchema = z.record(z.string(), z.unknown()).refine(
  (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 200_000,
  'tabData must be no larger than 200 KB',
);

const persistedChatTabSchema = z.object({
  tabId: z.string().trim().min(1).max(100),
  tabType: chatTabTypeSchema,
  tabLabel: z.string().min(1).max(255),
  tabOrder: z.number().int().min(0).max(49).default(0),
  isActive: z.boolean().default(false),
  tabData: persistedTabDataSchema.optional().default({}),
}).strict();

export const updateThreadSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  businessId: z.number().int().positive().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one thread field is required',
});

export const saveChatTabSchema = persistedChatTabSchema;

export const replaceChatTabsSchema = z.object({
  tabs: z.array(persistedChatTabSchema).max(50),
}).strict();

export const chatTabsActiveSchema = z.object({
  activeTabId: z.string().trim().min(1).max(100),
}).strict();

export const agentApproveSchema = z.object({
  threadId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .transform((value) => Number(value)),
  approved: z.boolean(),
  requestId: z.union([z.string().min(1).max(255), z.number().int().positive()])
    .transform((value) => String(value)),
  toolName: z.string().min(1).max(255),
  overrides: z.record(z.string(), z.unknown()).optional(),
}).strict();
/** @deprecated Use agentApproveSchema */
export const langGraphApproveSchema = agentApproveSchema;

export const agentSwitchAgentSchema = z.object({
  threadId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .transform(value => Number(value)).pipe(z.number().int().positive()),
  targetAgent: z.enum(['icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing']),
}).passthrough();
/** @deprecated Use agentSwitchAgentSchema */
export const langGraphSwitchAgentSchema = agentSwitchAgentSchema;

export const agentActionSchema = z.object({
  threadId: z.union([z.string(), z.number()]).optional(),
  action: z.string().min(1).max(200),
  value: z.string().max(10000).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  sourceMessageId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .transform((value) => Number(value))
    .optional(),
  buttonId: z.string().min(1).max(255).optional(),
}).passthrough();
/** @deprecated Use agentActionSchema */
export const langGraphActionSchema = agentActionSchema;

// ── Content Studio Schemas ────────────────────────────────────────────────────

const contentGovernanceSchemaFields = {
  businessProfileId: z.number().int().positive().optional(),
  brandToolkitId: z.number().int().positive().optional(),
  templateId: z.number().int().positive().optional(),
};

export const contentStudioPlanSchema = z.object({
  brief: z.string().min(1).max(10000),
  ...contentGovernanceSchemaFields,
  platform: z.string().max(100).optional(),
  cadence: z.string().max(100).optional(),
}).passthrough();

export const contentStudioAdCopySchema = z.object({
  icp_id: z.number().int().positive(),
  platform: z.enum(['google', 'facebook', 'linkedin', 'twitter', 'instagram']),
  variations: z.number().int().min(1).max(10).optional(),
}).passthrough();

// Compatibility accepts the old topic/content_type naming. The selected
// canonical channel schema validates all remaining fields before generation.
export const contentStudioGenerateSchema = z.object({
  prompt: z.string().trim().min(1).max(20000).optional(),
  topic: z.string().trim().min(1).max(20000).optional(),
  type: z.string().trim().min(1).max(100).optional(),
  content_type: z.string().trim().min(1).max(100).optional(),
  icp_id: z.number().int().positive().optional(),
  icpId: z.number().int().positive().optional(),
  thread_id: z.number().int().positive().optional(),
  threadId: z.number().int().positive().optional(),
  tone: z.string().trim().max(100).optional(),
  ...contentGovernanceSchemaFields,
}).passthrough().superRefine((body, ctx) => {
  if (!body.prompt && !body.topic) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['prompt'], message: 'prompt or topic is required' });
  if (!body.type && !body.content_type) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'type or content_type is required' });
  for (const [oldKey, key] of [['content_type', 'type'], ['icp_id', 'icpId'], ['thread_id', 'threadId']] as const) {
    if (body[oldKey] !== undefined && body[key] !== undefined && body[oldKey] !== body[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${oldKey} and ${key} must match when both are supplied` });
  }
});

export const contentStudioCreativesSchema = z.object({
  prompt: z.string().min(1).max(20000),
  ...contentGovernanceSchemaFields,
  platform: z.string().max(100).optional(),
}).passthrough();

export const contentStudioOutreachCopySchema = z.object({
  outreach_type: z.enum(['email', 'sms', 'dm']),
  lead_ids: z.array(z.number().int().positive()).min(1).max(1000),
  purpose: z.enum(['introduction', 'follow_up']).optional(),
  tone: z.string().max(100).optional(),
  conversation_history: z.array(z.object({
    role: z.enum(['assistant', 'user']),
    content: z.string().max(20000),
    subject: z.string().max(500).optional(),
  })).max(100).optional(),
  custom_prompt: z.string().max(5000).optional(),
  icp_id: z.number().int().positive().optional(),
  thread_id: z.number().int().positive().optional(),
  brand_toolkit_id: z.number().int().positive().optional(),
}).passthrough();

export const contentStudioMetaPromptSchema = z.object({
  prompt: z.string().min(1).max(20000),
}).passthrough();

export const contentStudioPromptVariationsSchema = z.object({
  prompt: z.string().min(1).max(20000),
  count: z.number().int().positive().max(20).optional(),
}).passthrough();

const mediaReferenceSchema = z.object({
  base64Data: z.string().min(1).max(30_000_000).optional(),
  data: z.string().min(1).max(30_000_000).optional(),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
}).refine((image) => Boolean(image.base64Data || image.data), {
  message: 'Reference image data is required',
});

export const contentStudioEmailSchema = z.object({
  prompt: z.string().trim().min(1).max(20000),
  ...contentGovernanceSchemaFields,
  icpId: z.number().int().positive().optional(),
  tone: z.string().trim().max(100).optional(),
  cta: z.string().trim().max(500).optional(),
  includeImagePrompt: z.boolean().optional(),
  threadId: z.number().int().positive().optional(),
  persist: z.boolean().optional(),
}).strict();

export const contentStudioSmsSchema = z.object({
  prompt: z.string().min(1).max(20000),
  maxCharacters: z.union([z.literal(160), z.literal(320)]).optional(),
  includeOptOut: z.boolean().optional(),
  ...contentGovernanceSchemaFields,
  icpId: z.number().int().positive().optional(),
  threadId: z.number().int().positive().optional(),
  persist: z.boolean().optional(),
}).strict();

export const contentStudioSocialSchema = z.object({
  mediaGeneration: z.object({ image: z.boolean(), video: z.boolean() }).strict().optional(),
  prompt: z.string().min(1).max(20000),
  platform: z.enum(['all', 'facebook', 'instagram', 'linkedin', 'twitter', 'youtube']),
  referenceImage: mediaReferenceSchema.optional(),
  ...contentGovernanceSchemaFields,
  icpId: z.number().int().positive().optional(),
  postType: z.string().trim().max(100).optional(),
  threadId: z.number().int().positive().optional(),
  persist: z.boolean().optional(),
}).strict();

export const contentStudioSocialMessageSchema = z.object({
  prompt: z.string().min(1).max(20000),
  platform: z.enum(['all', 'facebook', 'instagram', 'linkedin', 'twitter', 'whatsapp']),
  leadId: z.number().int().positive().optional(),
  ...contentGovernanceSchemaFields,
  icpId: z.number().int().positive().optional(),
  threadId: z.number().int().positive().optional(),
  persist: z.boolean().optional(),
}).strict();

export const contentStudioAdCopyContentSchema = z.object({
  mediaGeneration: z.object({ image: z.boolean(), video: z.boolean() }).strict().optional(),
  landingPageUrl: z.string().url().refine((value) => /^https:\/\//i.test(value), 'Use an HTTPS landing page').optional(),
  prompt: z.string().min(1).max(20000),
  platform: z.enum(['all', 'facebook', 'instagram', 'linkedin', 'twitter', 'google', 'meta']),
  ...contentGovernanceSchemaFields,
  icpId: z.number().int().positive().optional(),
  threadId: z.number().int().positive().optional(),
  persist: z.boolean().optional(),
}).strict();

export const contentStudioBlogSchema = z.object({
  prompt: z.string().min(1).max(20000),
  stage: z.enum(['outline', 'article']).optional(),
  editorial: z.object({
    outline: z.string().trim().max(15000).optional(),
    outlineApproved: z.boolean().optional(),
    seoTitle: z.string().trim().max(70).optional(),
    metaDescription: z.string().trim().max(170).optional(),
    slug: z.string().max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$|^$/).optional(),
    focusKeyword: z.string().trim().max(120).optional(),
    sourceUrls: z.array(z.string().url().max(2000).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }, 'Use an HTTPS URL without credentials.')).max(10).optional(),
    internalLinks: z.array(z.string().url().max(2000).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }, 'Use an HTTPS URL without credentials.')).max(10).optional(),
  }).strict().optional(),
  ...contentGovernanceSchemaFields,
  icpId: z.number().int().positive().optional(),
  threadId: z.number().int().positive().optional(),
  tone: z.string().trim().max(100).optional(),
  wordCount: z.union([
    z.number().int().min(200).max(5000),
    z.string().regex(/^\d+$/).transform(Number).refine((value) => value >= 200 && value <= 5000),
  ]).optional(),
  persist: z.boolean().optional(),
}).strict();

export const contentStudioMagicPromptSchema = z.object({
  currentPrompt: z.string().max(10000).optional(),
  prompt: z.string().max(10000).optional(),
  contentType: z.string().trim().min(1).max(100).optional(),
  chatContext: z.string().max(10000).optional(),
  icpId: z.number().int().positive().optional(),
  ...contentGovernanceSchemaFields,
  threadId: z.number().int().positive().optional(),
  platform: z.string().trim().max(100).optional(),
  intent: z.string().max(500).optional(),
}).strict().refine((data) => Boolean(data.currentPrompt?.trim() || data.prompt?.trim()), {
  message: 'A prompt is required',
  path: ['currentPrompt'],
}).transform(({ prompt, ...data }) => ({
  ...data,
  currentPrompt: data.currentPrompt || prompt,
}));

export const contentStudioEnhancePromptSchema = z.object({
  prompt: z.string().min(1).max(10000),
  ...contentGovernanceSchemaFields,
  contentType: z.string().trim().max(100).optional(),
  icpId: z.number().int().positive().optional(),
  platform: z.string().trim().max(100).optional(),
  tone: z.string().trim().max(100).optional(),
}).passthrough();

const contentStudioMediaBaseSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  provider: z.enum(['google', 'openrouter']).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  ...contentGovernanceSchemaFields,
  title: z.string().trim().max(500).optional(),
  threadId: z.number().int().positive().optional(),
  icpId: z.number().int().positive().optional(),
  assetId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).optional(),
  saveToAssets: z.boolean().optional().default(false),
  sourceType: z.string().trim().max(100).optional(),
  sourceTitle: z.string().trim().max(500).optional(),
  sourceCaption: z.string().max(10000).optional(),
  channel: z.string().trim().max(100).optional(),
  style: z.string().trim().max(100).optional(),
  aspectRatio: z.string().trim().max(20).optional(),
  seed: z.number().int().nonnegative().optional(),
}).strict();

export const contentStudioImageSchema = contentStudioMediaBaseSchema.extend({
  images: z.array(mediaReferenceSchema).max(8).optional(),
  imageSize: z.string().trim().max(30).optional(),
  numberOfImages: z.number().int().min(1).max(1).optional(),
}).strict();

export const contentStudioVideoSchema = contentStudioMediaBaseSchema.extend({
  background: z.boolean().optional(),
  includeBrandLogo: z.boolean().optional(),
  image: mediaReferenceSchema.optional(),
  /** `reference` (default): the prompt directs the scene; `start_frame`: the image is the exact first frame. */
  imageRole: z.enum(['reference', 'start_frame']).optional(),
  duration: z.union([
    z.string().regex(/^\d{1,3}$/).refine((value) => Number(value) >= 1 && Number(value) <= 120),
    z.number().int().min(1).max(120),
  ]).optional(),
  resolution: z.string().trim().max(30).optional(),
  generateAudio: z.boolean().optional(),
  personGeneration: z.string().trim().max(50).optional(),
  numberOfVideos: z.number().int().min(1).max(1).optional(),
}).strict();

export const contentStudioStartVideoSchema = z.object({
  includeBrandLogo: z.boolean().optional(),
  prompt: z.string().trim().min(1).max(20000),
  provider: z.enum(['google', 'openrouter']).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  ...contentGovernanceSchemaFields,
  image: mediaReferenceSchema.optional(),
  imageRole: z.enum(['reference', 'start_frame']).optional(),
  duration: z.number().int().min(1).max(120).optional(),
  resolution: z.string().trim().max(30).optional(),
  aspectRatio: z.string().trim().max(20).optional(),
  generateAudio: z.boolean().optional(),
  seed: z.number().int().nonnegative().optional(),
}).strict();

// ── Content Templates / Calendar / Brand Toolkit ─────────────────────────────

export const emailTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(50000),
  category: z.string().max(100).optional().nullable(),
}).passthrough();

export const generateEmailTemplateSchema = z.object({
  prompt: z.string().min(1).max(20000),
  ...contentGovernanceSchemaFields,
}).passthrough();

export const contentCalendarSchema = z.object({
  title: z.string().min(1).max(500),
  contentType: z.string().max(100),
  channel: z.string().min(1).max(100),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scheduledTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  description: z.string().max(50000).optional(),
  contentAssetId: z.number().int().positive().optional(),
  contentPlanId: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const brandText = (max: number) => z.string().trim().max(max).optional().nullable();
const brandList = z.array(z.string().trim().min(1).max(500)).max(100).optional().nullable();
const brandMediaUrl = z.string().max(5000).refine((value) => {
  if (value === '') return true;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}, 'Logo URL must be HTTP(S) or an application-relative path');

export const brandToolkitSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  version: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(255),
  brandName: brandText(255),
  description: brandText(10_000),
  tagline: brandText(2000),
  missionStatement: brandText(10_000),
  brandValues: brandList,
  brandKeywords: brandList,
  logoUrl: brandMediaUrl.optional().nullable(),
  logoUrls: z.array(brandMediaUrl).max(20).optional().nullable(),
  logoFileName: brandText(255),
  logoVisibility: z.boolean().optional(),
  imageAssets: z.array(z.object({ url: brandMediaUrl, originalUrl: brandMediaUrl.optional(),
    alt: z.string().max(BRAND_IMAGE_LIMITS.alt).optional(), width: z.number().int().min(1).max(BRAND_IMAGE_LIMITS.dimension).optional(), height: z.number().int().min(1).max(BRAND_IMAGE_LIMITS.dimension).optional(),
    thumbnailUrl: brandMediaUrl.optional(), source: z.enum(['website','upload']).optional(), originalName: z.string().max(BRAND_IMAGE_LIMITS.originalName).optional(),sizeBytes:z.number().int().min(0).max(BRAND_IMAGE_LIMITS.storedBytes).optional() }).strict()).max(100).optional(),
  websiteScreenshotUrl: brandMediaUrl.optional().nullable(),
  primaryBrandColor: brandText(50),
  secondaryBrandColor: brandText(50),
  accentColor: brandText(50),
  primaryColors: z.array(z.string().trim().min(1).max(50)).max(20).optional().nullable(),
  secondaryColors: z.array(z.string().trim().min(1).max(50)).max(20).optional().nullable(),
  additionalColors: z.array(z.string().trim().min(1).max(50)).max(20).optional().nullable(),
  fontFamily: brandText(100),
  fontFamilies: brandList,
  gradients: brandList,
  fonts: z.union([
    z.object({
      heading: z.string().trim().max(100).optional(),
      body: z.string().trim().max(100).optional(),
      accent: z.string().trim().max(100).optional(),
    }).strict(),
    z.array(z.string().trim().max(100)).max(20),
  ]).optional().nullable(),
  imageStyleReference: brandText(2000),
  visualInstructions: brandText(10_000),
  logoUsageGuidelines: brandText(10_000),
  voiceType: brandText(100),
  customToneGuidelines: brandText(10_000),
  voicePersonalityTraits: brandList,
  voiceDos: brandList,
  voiceDonts: brandList,
  voiceKeywords: brandList,
  defaultCtas: brandList,
  defaultHashtags: brandList,
  sampleContent: z.unknown().optional(),
  contentPillars: brandList,
  contentFormats: brandList,
  contentInstructions: brandText(10_000),
  audiencePainPoints: brandList,
  audienceGoals: brandList,
  audienceLanguageStyle: brandList,
  audienceTriggers: brandList,
  integrationTools: z.unknown().optional(),
  website: brandText(2000),
  industry: brandText(255),
  email: z.union([z.string().email().max(255), z.literal('')]).optional().nullable(),
  phone: brandText(100),
  linkedinUrl: brandText(2000),
  twitterUrl: brandText(2000),
  facebookUrl: brandText(2000),
  instagramUrl: brandText(2000),
  youtubeUrl: brandText(2000),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  // Accepted for legacy modal payloads; ownership always comes from auth.
  id: z.number().int().positive().optional(),
  colors: z.array(z.string().max(50)).max(20).optional(),
  tone: z.string().max(1000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const optionalProfileText = brandText;
const optionalProfileUrl = z.union([
  z.string().trim().max(2000).refine((value) => {
    if (value === '') return true;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'URL must be a valid HTTP or HTTPS URL'),
  z.null(),
]).optional();
const profileStringList = z.union([
  z.array(z.string().trim().min(1).max(255)).max(100),
  z.string().max(20_000),
]).optional().nullable();
const optionalPositiveId = z.union([
  z.number().int().positive(),
  z.string().regex(/^\d+$/).transform(Number),
]).optional().nullable();

export const businessProfileSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  version: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1).max(100).optional(),
  name: optionalProfileText(255),
  workspaceType: z.enum(WORKSPACE_TYPE_VALUES).optional().nullable(),
  timezone: optionalProfileText(100),
  applicationUses: z.array(z.enum(APPLICATION_USE_VALUES)).max(6).optional(),
  setupGoal: optionalProfileText(1000),
  currentTools: optionalProfileText(1000),
  profileType: optionalProfileText(100),
  companyName: optionalProfileText(255),
  industry: optionalProfileText(1000),
  subIndustry: optionalProfileText(1000),
  companySize: optionalProfileText(100),
  annualRevenue: optionalProfileText(100),
  ownerName: optionalProfileText(255),
  businessName: optionalProfileText(255),
  businessCategory: optionalProfileText(255),
  establishedYear: optionalProfileText(20),
  website: optionalProfileUrl,
  phone: optionalProfileText(50),
  email: z.union([z.string().email().max(255), z.literal('')]).optional().nullable(),
  description: optionalProfileText(10_000),
  businessHours: optionalProfileText(2000),
  targetMarket: optionalProfileText(2000),
  valueProposition: optionalProfileText(5000),
  address: optionalProfileText(2000),
  city: optionalProfileText(255),
  state: optionalProfileText(255),
  country: optionalProfileText(255),
  postalCode: optionalProfileText(50),
  linkedinUrl: optionalProfileUrl,
  twitterUrl: optionalProfileUrl,
  facebookUrl: optionalProfileUrl,
  instagramUrl: optionalProfileUrl,
  youtubeUrl: optionalProfileUrl,
  platforms: profileStringList,
  contentFormats: profileStringList,
  visualStyle: optionalProfileText(2000),
  referenceAccounts: optionalProfileText(10_000),
  businessGoals: profileStringList,
  targetRegions: profileStringList,
  customerType: optionalProfileText(255),
  keyBuyerRoles: profileStringList,
  preferredChannels: profileStringList,
  brandTone: optionalProfileText(2000),
  approvalMode: optionalProfileText(100),
  restrictions: optionalProfileText(10_000),
  isDefault: z.union([z.boolean(), z.literal('true'), z.literal('false'), z.literal(1), z.literal(0), z.literal('1'), z.literal('0')]).optional(),
  categoryId: optionalPositiveId,
  subcategoryId: optionalPositiveId,
  threadId: optionalPositiveId,
}).passthrough();

export const createBusinessProfileSchema = businessProfileSchema.refine(
  (value) => Boolean(value.name?.trim() || value.companyName?.trim() || value.businessName?.trim()),
  { message: 'A profile or company name is required', path: ['name'] },
);

export const contentTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.enum(['email', 'whatsapp', 'sms', 'ad_copy', 'social', 'social_message', 'landing_page', 'blog']),
  content: z.string().min(1).max(50000).refine(value => value.trim().length > 0, 'Template content must not be blank'),
  subject: z.string().max(500).optional().nullable(),
  htmlContent: z.string().max(BRAND_IMAGE_LIMITS.dimension).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  variables: z.array(z.string().max(100)).max(100).optional(),
  category: z.string().max(100).optional().nullable(),
  tags: z.array(z.string().max(100)).max(100).optional(),
  brandToolkitId: z.number().int().positive().optional().nullable(),
  businessProfileId: z.number().int().positive().optional().nullable(),
}).strict();

const contentMediaUrlSchema = z.string().max(5000).refine((value) => {
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}, 'Media URL must be an HTTP(S) URL or an application-relative path');

export const contentAssetSchema = z.object({
  title: z.string().trim().min(1).max(255),
  type: z.string().trim().min(1).max(50),
  content: z.string().max(50000),
  channel: z.string().trim().min(1).max(50),
  status: z.enum(['draft', 'ready', 'scheduled', 'processing', 'published', 'failed']),
  threadId: z.number().int().positive().optional().nullable(),
  parentAssetId: z.number().int().positive().optional().nullable(),
  businessProfileId: z.number().int().positive().optional().nullable(),
  brandToolkitId: z.number().int().positive().optional().nullable(),
  sourceTemplateId: z.number().int().positive().optional().nullable(),
  sourceTemplateVersion: z.number().int().positive().optional().nullable(),
  imageUrl: contentMediaUrlSchema.optional().nullable(),
  videoUrl: contentMediaUrlSchema.optional().nullable(),
  imageUrls: z.array(contentMediaUrlSchema).max(20).optional().nullable(),
  videoUrls: z.array(contentMediaUrlSchema).max(20).optional().nullable(),
  publishPlatform: z.enum(['facebook', 'instagram', 'youtube', 'linkedin', 'twitter']).optional().nullable(),
  scheduledPublishAt: z.string().datetime({ offset: true }).optional().nullable(),
  performance: z.record(z.string(), z.unknown()).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
}).strict();

const contentAssetPreviewTypeSchema = z.enum(['text_image', 'text_video', 'text_only']);
const contentAssetPreviewChannelSchema = z.enum([
  'calls',
  'email',
  'linkedin',
  'instagram',
  'facebook',
  'twitter',
]);
const contentAssetPreviewStatusSchema = z.enum(['pending_approval', 'approved', 'rejected']);

export const contentAssetPreviewSchema = z.object({
  type: contentAssetPreviewTypeSchema,
  message: z.string().trim().min(1).max(50000),
  imageUrl: contentMediaUrlSchema.optional().nullable(),
  videoUrl: contentMediaUrlSchema.optional().nullable(),
  channel: contentAssetPreviewChannelSchema,
  leadId: z.number().int().positive(),
  status: contentAssetPreviewStatusSchema,
}).strict().superRefine((preview, ctx) => {
  if (preview.type === 'text_image' && !preview.imageUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['imageUrl'],
      message: 'Image URL is required for an image preview',
    });
  }
  if (preview.type === 'text_video' && !preview.videoUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['videoUrl'],
      message: 'Video URL is required for a video preview',
    });
  }
});

export const contentAssetPreviewUpdateSchema = z.object({
  type: contentAssetPreviewTypeSchema.optional(),
  message: z.string().trim().min(1).max(50000).optional(),
  imageUrl: contentMediaUrlSchema.optional().nullable(),
  videoUrl: contentMediaUrlSchema.optional().nullable(),
  channel: contentAssetPreviewChannelSchema.optional(),
  status: contentAssetPreviewStatusSchema.optional(),
}).strict().superRefine((preview, ctx) => {
  if (preview.type === 'text_image' && !preview.imageUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['imageUrl'],
      message: 'Image URL is required when changing to an image preview',
    });
  }
  if (preview.type === 'text_video' && !preview.videoUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['videoUrl'],
      message: 'Video URL is required when changing to a video preview',
    });
  }
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one preview field is required',
});

// ── CRM Schemas ───────────────────────────────────────────────────────────────

export const crmContactSchema = z.object({
  name: z.string().trim().max(510).optional(),
  firstName: z.string().trim().max(255).optional(),
  lastName: z.string().trim().max(255).optional(),
  email: z.string().email().max(255).optional().or(z.literal('')).nullable(),
  phone: z.string().max(50).optional().nullable(),
  company: z.string().max(255).optional().nullable(),
  role: z.string().max(255).optional().nullable(),
  status: z.enum(['new', 'contacted', 'replied', 'interested', 'negotiable', 'negotiations', 'demo', 'proposal_sent', 'ticket_open', 'ticket_close', 'won', 'lost']).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  notes: z.string().max(10000).optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  dealValue: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Deal value must be a non-negative amount with at most two decimals').optional().nullable(),
  nextFollowUpAt: z.string().datetime().or(z.date()).optional().nullable(),
  assignedTo: z.number().int().positive().optional().nullable(),
  ownerUserId: z.number().int().positive().optional().nullable(),
  pipelineStatus: z.string().trim().min(1).max(50).optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code').optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).or(z.date()).optional(),
}).strict();

export const crmContactCreateSchema = crmContactSchema.omit({ expectedUpdatedAt: true }).extend({ chatThreadId: z.number().int().positive().optional() });

export const crmActivitySchema = z.object({
  type: z.enum(['note', 'call', 'email', 'meeting', 'task']),
  subject: z.string().max(500).optional(),
  body: z.string().max(10000).optional(),
  dueAt: z.string().datetime({ offset: true }).or(z.date()).nullable().optional(),
  completedAt: z.string().datetime({ offset: true }).or(z.date()).nullable().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
}).strict();

export const crmAutomationSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional(),
  definition: z.custom<AutomationDefinition>(value=>validateAutomationDefinition(value).length===0,'Invalid automation definition').optional(),
  revision: z.number().int().positive().optional(),
  triggerType: z.enum(['status_change', 'pipeline_status_change']).optional(),
  triggerConfig: z.record(z.string(), z.unknown()).optional(),
  action: z.enum(['create_ticket', 'update_pipeline_status', 'update_tags', 'update_status', 'assign_user']).optional(),
  actionConfig: z.record(z.string(), z.unknown()).optional(),
  condition:z.record(z.string(), z.unknown()).optional(),
  conditions:z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
}).strict();

export const crmReminderSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(2000).optional(),
  dueDate: z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)), "Invalid due date").optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  reminderType: z.enum(['followup', 'ticket_open', 'ticket_close', 'proposal_sent', 'proposal_expiry', 'meeting', 'call', 'task', 'custom']).optional(),
  status: z.enum(['pending', 'completed', 'sent', 'snoozed']).optional(),
  contactId: z.number().int().refine(value => value !== 0, 'Contact ID cannot be zero').optional(),
  activityId: z.number().int().positive().optional(),
  notifyContact: z.boolean().optional(),
  snoozedUntil: z.string().datetime({ offset: true }).optional().nullable(),
  assignedTo: z.number().int().positive().optional().nullable(),
}).strict();

export const crmAlertSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional(),
  eventType: z.enum(['status_changed_to', 'status_changed_from', 'proposal_sent', 'ticket_opened', 'ticket_closed', 'lead_created', 'contact_created', 'deal_won', 'deal_lost']),
  conditions: z.record(z.string(), z.unknown()).optional(),
  notifyUser: z.boolean().optional(),
  notifyContact: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).strict();

export const crmContactSyncSchema = z.object({
  contactIds: z.array(z.number().int().positive()).max(500).optional(),
}).strict();

// ── Embedding Schemas ─────────────────────────────────────────────────────────

export const generateEmbeddingSchema = z.object({
  text: z.string().min(1).max(50000),
  model: z.string().max(100).optional(),
}).passthrough();

export const storeEmbeddingSchema = z.object({
  contentType: z.string().min(1).max(100),
  contentId: z.union([z.string(), z.number()]),
  text: z.string().min(1).max(50000),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const searchEmbeddingSchema = z.object({
  query: z.string().min(1).max(5000),
  contentType: z.string().max(100).optional(),
  limit: z.number().int().positive().max(100).optional(),
  threshold: z.number().min(0).max(1).optional(),
}).passthrough();

// ── Campaign Schemas ──────────────────────────────────────────────────────────

export const campaignPlanSchema = z.object({
  goal: z.string().min(1).max(2000),
  budget: z.number().nonnegative().optional(),
  duration: z.number().int().positive().optional(),
  channels: z.array(z.string().max(100)).max(20).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const regenerateCampaignPlanSchema = z.object({
  feedback: z.string().max(5000).optional(),
  adjustments: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const budgetPlanSchema = z.object({
  icp_id: z.number().int().positive(),
  total_budget: z.number().positive().max(1_000_000_000),
  duration_days: z.number().int().min(1).max(3650).optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, 'Currency must be a three-letter ISO code').optional(),
}).strict();

export const campaignPerformanceGenerateSchema = z.object({
  icp_id: z.number().int().positive(),
  platform: z.enum(['google', 'facebook', 'linkedin', 'twitter', 'instagram']),
  budget: z.number().positive().max(1_000_000_000),
  duration_days: z.number().int().min(1).max(3650).optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, 'Currency must be a three-letter ISO code').optional(),
  thread_id: z.number().int().positive().optional(),
}).strict();

export const campaignOptimizeSchema = z.object({
  campaign_id: z.number().int().positive(),
  current_metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
}).strict();

export const createCampaignSchema = z.object({
  name: z.string().min(1).max(500),
  goal: z.string().min(1).max(5000),
  status: z.enum(['draft', 'planned', 'active', 'paused', 'completed', 'archived']).optional(),
  budget: z.number().int().nonnegative(),
  spent: z.number().int().nonnegative().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
  startDate: z.string().max(50).refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid start date').optional(),
  endDate: z.string().max(50).refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid end date').optional().nullable(),
}).strict();

export const saveCampaignPlanBodySchema = z.object({
  planData: z.unknown(),
  status: z.string().max(50).optional(),
}).passthrough();

export const regenerateCampaignPlanBodySchema = z.object({
  previousPlan: z.unknown().optional(),
  context: z.array(z.unknown()).max(100).optional(),
}).passthrough();

export const aiCampaignPlanRequestSchema = z.object({
  message: z.string().min(1).max(10000),
  context: z.array(z.unknown()).max(100).optional(),
}).passthrough();

// ─── Proposals ─────────────────────────────────────────────────────────────────
const proposalLineItemSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  name: z.string().min(1).max(500),
  description: z.string().max(2000).optional().nullable(),
  quantity: z.number().positive().max(BRAND_IMAGE_LIMITS.dimension).optional(),
  unitPrice: z.number().nonnegative().max(1000000000).optional(),
  unit: z.string().max(50).optional(),
  discount: z.number().nonnegative().max(1000000000).optional(),
  catalogId: z.number().int().positive().nullable().optional(),
  isComplimentary: z.boolean().optional(),
  priceConfirmed: z.boolean().optional(),
  isOptional: z.boolean().optional(),
  selected: z.boolean().optional(),
  packageId: z.string().trim().min(1).max(100).nullable().optional(),
  billingPeriod: z.enum(['one_time', 'monthly', 'quarterly', 'yearly']).optional(),
}).refine((item) => (item.discount ?? 0) <= (item.quantity ?? 1) * (item.unitPrice ?? 0), {
  message: 'Discount cannot exceed the line item value',
  path: ['discount'],
});

export const adminCreateCampaignSchema = z.object({
  userId: z.number().int().positive(),
  name: z.string().trim().min(1).max(500),
  goal: z.string().trim().min(1).max(5000),
  status: z.enum(['draft', 'planned', 'active', 'paused', 'completed']).optional(),
  budget: z.number().int().nonnegative().max(1_000_000_000),
  startDate: z.string().max(50).refine(
    (value) => !Number.isNaN(Date.parse(value)),
    'Invalid start date',
  ),
  endDate: z.string().max(50).refine(
    (value) => !Number.isNaN(Date.parse(value)),
    'Invalid end date',
  ).optional().nullable(),
}).strict().refine(
  (data) => !data.endDate || new Date(data.endDate) >= new Date(data.startDate),
  { path: ['endDate'], message: 'End date must be on or after the start date' },
);

const proposalDateSchema = z.union([z.string().max(50), z.date()]).transform((value, context) => {
  const date = value instanceof Date
    ? value
    : new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value);
  if (Number.isNaN(date.getTime())) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' });
    return z.NEVER;
  }
  return date;
});

const futureProposalDateSchema = proposalDateSchema.refine(
  (date) => date.getTime() > Date.now(),
  'The proposal expiry must be in the future',
);

const proposalCurrencySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code');

export const proposalDocumentSectionSchema = z.object({
  title: z.string().trim().min(1).max(500),
  body: z.string().max(100000),
  kind: z.enum(['cover', 'content', 'terms', 'closing']),
  instruction: z.string().max(10000).optional(),
}).strict();
export const proposalRequirementsSchema = z.object({
  objectives: z.string().max(10000).optional(), deliverables: z.string().max(10000).optional(),
  timeline: z.string().max(10000).optional(), responsibilities: z.string().max(10000).optional(),
  budget: z.string().max(2000).optional(),
}).strict();
export const proposalCommercialSchema = z.object({
  packages: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().trim().min(1).max(100), description: z.string().max(2000).optional() }).strict()).max(6).optional(),
  selectedPackageId: z.string().min(1).max(100).nullable().optional(),
  milestones: z.array(z.object({ id: z.string().min(1).max(100), title: z.string().trim().min(1).max(255), percentage: z.number().positive().max(100), dueDate: z.string().date().nullable().optional() }).strict()).max(24).optional(),
}).strict().superRefine((data, context) => {
  for (const field of ['packages', 'milestones'] as const) {
    const values = data[field] || [];
    if (new Set(values.map(item => item.id)).size !== values.length) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'Each option must have a unique ID' });
  }
});

export const proposalOnboardingPlanSchema = z.object({
  teamId: z.number().int().positive().nullable().optional(),
  assignedMemberId: z.number().int().positive().nullable().optional(),
  dueDate: z.string().date().nullable().optional(),
  checklist: z.array(z.object({
    id: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(500),
    deliverable: z.string().trim().max(2000).optional(),
    dueDate: z.string().date().nullable().optional(),
  }).strict()).max(50).optional(),
}).strict().superRefine((data, context) => {
  if (data.assignedMemberId && !data.teamId) context.addIssue({ code: z.ZodIssueCode.custom, path: ['assignedMemberId'], message: 'Choose a team for the onboarding owner' });
  const ids = (data.checklist || []).map(item => item.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['checklist'], message: 'Each onboarding item must have a unique ID' });
});

export const createProposalSchema = z.object({
  draftKey: z.string().trim().min(8).max(100).optional(),
  title: z.string().trim().min(1).max(500),
  coverNote: z.string().max(BRAND_IMAGE_LIMITS.dimension).optional(),
  recipientName: z.string().trim().max(255).optional(),
  recipientEmail: z.string().trim().email().max(320).optional().or(z.literal('')),
  contactId: z.number().int().positive().optional(),
  leadId: z.number().int().positive().optional(),
  outreachConversationId: z.number().int().positive().optional(),
  chatThreadId: z.number().int().positive().optional(),
  templateId: z.number().int().positive().optional(),
  brandToolkitId: z.number().int().positive().nullable().optional(),
  businessProfileId: z.number().int().positive().optional(),
  knowledgeBaseSections: z.array(z.number().int().positive()).max(500).optional(),
  context: z.string().max(50000).optional(),
  supportTicketId: z.number().int().positive().optional(),
  approvalRequired: z.boolean().optional(),
  autoOnboard: z.boolean().optional(),
  currency: proposalCurrencySchema.optional(),
  validUntil: futureProposalDateSchema.nullable().optional(),
  signatureRequired: z.boolean().optional(),
  showTermsAndConditions: z.boolean().optional(),
  termsAndConditions: z.string().max(BRAND_IMAGE_LIMITS.dimension).optional(),
  lineItems: z.array(proposalLineItemSchema).max(500).optional(),
  generatedSections: z.array(proposalDocumentSectionSchema).max(200).optional(),
  commercial: proposalCommercialSchema.optional(),
  requirements: proposalRequirementsSchema.optional(),
  assumptions: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
  onboardingPlan: proposalOnboardingPlanSchema.optional(),
  templateValues: z.record(z.string().max(200), z.string().max(10000)).optional(),
  generationMode: z.enum(['fill_missing', 'replace_selected']).optional(),
  generationSections: z.array(z.number().int().nonnegative()).max(200).optional(),
  discountType: z.enum(['fixed', 'percentage']).nullable().optional(),
  discountValue: z.number().nonnegative().max(1000000000).optional(),
  taxRate: z.number().min(0).max(100).optional(),
}).strict();

export const updateProposalSchema = z.object({
  expectedRevision: z.number().int().positive().optional(),
  contactId: z.number().int().positive().nullable().optional(),
  leadId: z.number().int().positive().nullable().optional(),
  outreachConversationId: z.number().int().positive().nullable().optional(),
  supportTicketId: z.number().int().positive().nullable().optional(),
  chatThreadId: z.number().int().positive().nullable().optional(),
  templateId: z.number().int().positive().nullable().optional(),
  brandToolkitId: z.number().int().positive().optional(),
  templateValues: z.record(z.string().max(200), z.string().max(10000)).optional(),
  approvalRequired: z.boolean().optional(),
  autoOnboard: z.boolean().optional(),
  generatedSections: z.array(proposalDocumentSectionSchema).max(200).optional(),
  commercial: proposalCommercialSchema.optional(),
  requirements: proposalRequirementsSchema.optional(),
  assumptions: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
  onboardingPlan: proposalOnboardingPlanSchema.optional(),
  title: z.string().trim().min(1).max(500).optional(),
  coverNote: z.string().max(BRAND_IMAGE_LIMITS.dimension).optional().nullable(),
  recipientName: z.string().trim().max(255).optional().nullable(),
  recipientEmail: z.string().trim().email().max(320).optional().or(z.literal('')).nullable(),
  currency: proposalCurrencySchema.optional(),
  discountType: z.enum(['fixed', 'percentage']).optional().nullable(),
  discountValue: z.coerce.number().nonnegative().optional(),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  validUntil: futureProposalDateSchema.nullable().optional(),
  signatureRequired: z.boolean().optional(),
  showTermsAndConditions: z.boolean().optional(),
  termsAndConditions: z.string().max(BRAND_IMAGE_LIMITS.dimension).optional().nullable(),
  lineItems: z.array(proposalLineItemSchema).max(500).optional(),
}).strict().superRefine((data, context) => {
  if (data.discountType === 'percentage' && (data.discountValue ?? 0) > 100) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['discountValue'], message: 'Percentage discount cannot exceed 100' });
  }
});

export const updateLineItemsSchema = z.object({
  lineItems: z.array(proposalLineItemSchema).max(500),
});

export const addProposalCommentSchema = z.object({
  content: z.string().trim().min(1).max(10000),
  parentCommentId: z.number().int().positive().optional(),
  mentions: z.array(z.number().int().positive()).max(100).optional(),
});

export const updateProposalCommentSchema = z.object({
  content: z.string().trim().min(1).max(10000).optional(),
  isResolved: z.boolean().optional(),
});

const proposalTemplateSectionSchema = z.object({
  title: z.string().trim().min(1).max(500),
  body: z.string().max(100000),
  kind: z.enum(['cover', 'content', 'terms', 'closing']),
  instruction: z.string().max(10000).optional(),
}).strict();

export const createProposalTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  category: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  templateType: z.enum(['legacy', 'document']).optional(),
  isDefault: z.boolean().optional(),
  coverNote: z.string().max(BRAND_IMAGE_LIMITS.dimension).optional(),
  lineItems: z.array(proposalLineItemSchema).max(500).optional(),
  termsAndConditions: z.string().max(BRAND_IMAGE_LIMITS.dimension).optional(),
  includeKnowledgeBase: z.boolean().optional(),
  includeBusinessProfile: z.boolean().optional(),
  templateContent: z.object({
    sections: z.array(proposalTemplateSectionSchema).max(200),
    placeholders: z.array(z.string().trim().min(1).max(200)).max(200),
    warnings: z.array(z.string().trim().min(1).max(2000)).max(100),
    requiredFields: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  }).strict().optional(),
}).strict();

export const updateProposalTemplateSchema = createProposalTemplateSchema.partial();

export const rejectProposalSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export const sendProposalSchema = z.object({
  channel: z.enum(['email','whatsapp','facebook','instagram','sms','linkedin','twitter','web']).optional(),
  outreachConversationId: z.number().int().positive().optional(),
  leadId: z.number().int().positive().optional(),
  providerAccountId: z.string().trim().min(1).max(255).optional(),
  providerVariant: z.enum(['gmail', 'resend']).optional(),
  recipientName: z.string().trim().max(255).optional(),
  recipientEmail: z.string().trim().email().max(320).or(z.literal('')).optional(),
  message: z.string().trim().min(1).max(10000).optional(),
  subject: z.string().trim().min(1).max(500).optional(),
  whatsappTemplate: z.object({name:z.string().max(512),language:z.string().max(20),components:z.array(z.unknown()).max(20)}).strict().optional(),
  expectedRevision: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export const publicProposalResponseSchema = z.object({
  name: z.string().trim().max(255).optional(),
  reason: z.string().trim().max(2000).optional(),
}).strict();

export const createProposalReminderSchema = z.object({
  reminderDueAt: z.coerce.date().refine((date) => date.getTime() > Date.now(), 'Reminder must be scheduled in the future'),
  reminderType: z.enum(['expiry', 'followup', 'custom', 'customer_followup']).optional(),
}).strict();

export const updateProposalReminderSchema = z.object({
  reminderDueAt: z.coerce.date().refine((date) => date.getTime() > Date.now(), 'Reminder must be scheduled in the future').optional(),
  status: z.enum(['pending', 'sent', 'snoozed', 'paused', 'cancelled']).optional(),
  snoozedUntil: z.coerce.date().refine((date) => date.getTime() > Date.now(), 'Snooze time must be in the future').nullable().optional(),
}).strict();

// ─── Wallet payments ──────────────────────────────────────────────────────────
export const createRechargeOrderSchema = z.object({
  amount: z.number().finite().min(1).max(100000),
});

export const verifyRechargePaymentSchema = z.object({
  razorpay_order_id: z.string().trim().min(5).max(255),
  razorpay_payment_id: z.string().trim().min(5).max(255),
  razorpay_signature: z.string().trim().regex(/^[a-fA-F0-9]{64}$/, 'Invalid payment signature'),
});

// ─── Legal (Public) ────────────────────────────────────────────────────────────
export const accountDeletionRequestSchema = z.object({
  email: z.string().email().max(320),
  fullName: z.string().max(200).optional(),
  reason: z.string().max(2000).optional(),
  source: z.string().max(50).optional(),
}).strict();
