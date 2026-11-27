/**
 * Canonical conversation-side-panel registry shared by the browser client and
 * the agent runtime. Keep transport aliases here so both sides normalize old
 * persisted tabs in exactly the same way.
 */
export const TAB_TYPES = {
  OVERVIEW: 'overview',
  SEARCH: 'search',
  ICP: 'icp',
  AGENT_CHOOSE: 'agentchoose',
  LEADS: 'leads',
  LEAD_INPUTS: 'lead-inputs',
  OUTREACH: 'outreach',
  ANALYTICS: 'analytics',
  CAMPAIGNS: 'campaigns',
  ADS: 'ads',
  LEAD_CONFIG: 'leadconfig',
  CONTENT_STUDIO: 'content-studio',
  PERFORMANCE_MARKETING: 'performancemarketing',
  CONTENT_PREVIEW: 'contentpreview',
  SOCIAL_POST_PREVIEW: 'socialpostpreview',
  BRAND_TOOLKIT: 'brandtoolkit',
  EMAIL_TEMPLATE: 'emailtemplate',
  SMS_TEMPLATE: 'smstemplate',
  SOCIAL_CHAT_TEMPLATE: 'socialchattemplate',
  BLOG_POST: 'blogpost',
  CRM: 'crm',
  SUPPORT: 'support',
  PROPOSALS: 'proposals',
  CONTENT_IMAGE: 'content-image',
  CONTENT_VIDEO: 'content-video',
  CONTENT_EMAIL: 'content-email',
  CONTENT_SMS: 'content-sms',
  CONTENT_WHATSAPP: 'content-whatsapp',
  CONTENT_SOCIAL: 'content-social',
  CONTENT_SOCIAL_MESSAGE: 'content-social-message',
  CONTENT_AD_COPY: 'content-adcopy',
  CONTENT_BLOG: 'content-blog',
} as const;

export type TabType = (typeof TAB_TYPES)[keyof typeof TAB_TYPES];

export const TAB_LABELS: Readonly<Record<TabType, string>> = {
  [TAB_TYPES.OVERVIEW]: 'Overview',
  [TAB_TYPES.SEARCH]: 'Search',
  [TAB_TYPES.ICP]: 'ICP Profile',
  [TAB_TYPES.AGENT_CHOOSE]: 'Agents',
  [TAB_TYPES.LEADS]: 'Leads',
  [TAB_TYPES.LEAD_INPUTS]: 'Search Settings',
  [TAB_TYPES.OUTREACH]: 'Outreach',
  [TAB_TYPES.ANALYTICS]: 'Analytics',
  [TAB_TYPES.CAMPAIGNS]: 'Campaigns',
  // The Ads tab opens the ad copy writer.
  [TAB_TYPES.ADS]: 'Ad Copy',
  // Lead Config was merged into Search Settings; old saved tabs open there.
  [TAB_TYPES.LEAD_CONFIG]: 'Search Settings',
  [TAB_TYPES.CONTENT_STUDIO]: 'Content Studio',
  [TAB_TYPES.PERFORMANCE_MARKETING]: 'Performance Marketing',
  [TAB_TYPES.CONTENT_PREVIEW]: 'Content Preview',
  [TAB_TYPES.SOCIAL_POST_PREVIEW]: 'Social Post',
  [TAB_TYPES.BRAND_TOOLKIT]: 'Brand Toolkit',
  [TAB_TYPES.EMAIL_TEMPLATE]: 'Email',
  [TAB_TYPES.SMS_TEMPLATE]: 'SMS',
  [TAB_TYPES.SOCIAL_CHAT_TEMPLATE]: 'Social Message',
  [TAB_TYPES.BLOG_POST]: 'Blog Post',
  [TAB_TYPES.CRM]: 'CRM',
  [TAB_TYPES.SUPPORT]: 'Support',
  [TAB_TYPES.PROPOSALS]: 'Proposals',
  [TAB_TYPES.CONTENT_IMAGE]: 'Images',
  [TAB_TYPES.CONTENT_VIDEO]: 'Videos',
  [TAB_TYPES.CONTENT_EMAIL]: 'Email',
  [TAB_TYPES.CONTENT_SMS]: 'SMS',
  [TAB_TYPES.CONTENT_WHATSAPP]: 'WhatsApp',
  [TAB_TYPES.CONTENT_SOCIAL]: 'Social Post',
  [TAB_TYPES.CONTENT_SOCIAL_MESSAGE]: 'Social Message',
  [TAB_TYPES.CONTENT_AD_COPY]: 'Ad Copy',
  [TAB_TYPES.CONTENT_BLOG]: 'Blog',
};

export const LEGACY_TAB_ALIASES: Readonly<Record<string, TabType>> = {
  leadInputs: TAB_TYPES.LEAD_INPUTS,
  leadconfig: TAB_TYPES.LEAD_INPUTS,
  'lead-config': TAB_TYPES.LEAD_INPUTS,
  contentstudio: TAB_TYPES.CONTENT_STUDIO,
};

export const CONTENT_TAB_TYPE_MAP: Readonly<Record<string, TabType>> = {
  emailtemplate: TAB_TYPES.CONTENT_EMAIL,
  smstemplate: TAB_TYPES.CONTENT_SMS,
  whatsapptemplate: TAB_TYPES.CONTENT_WHATSAPP,
  socialchattemplate: TAB_TYPES.CONTENT_SOCIAL_MESSAGE,
  socialpostpreview: TAB_TYPES.CONTENT_SOCIAL,
  brandtoolkit: TAB_TYPES.CONTENT_STUDIO,
  'content-studio-email': TAB_TYPES.CONTENT_EMAIL,
  'content-studio-sms': TAB_TYPES.CONTENT_SMS,
  'content-studio-social': TAB_TYPES.CONTENT_SOCIAL,
  'content-studio-adcopy': TAB_TYPES.CONTENT_AD_COPY,
  'content-studio-image': TAB_TYPES.CONTENT_IMAGE,
  'content-studio-video': TAB_TYPES.CONTENT_VIDEO,
  'content-studio-social-message': TAB_TYPES.CONTENT_SOCIAL_MESSAGE,
  'content-studio-blog': TAB_TYPES.CONTENT_BLOG,
  blogpost: TAB_TYPES.CONTENT_BLOG,
  'content-media': TAB_TYPES.CONTENT_IMAGE,
};

export const CONTENT_TAB_INITIAL_MAP: Readonly<Record<string, string>> = {
  [TAB_TYPES.CONTENT_IMAGE]: 'image',
  [TAB_TYPES.CONTENT_VIDEO]: 'video',
  [TAB_TYPES.CONTENT_EMAIL]: 'email',
  [TAB_TYPES.CONTENT_SMS]: 'sms',
  [TAB_TYPES.CONTENT_WHATSAPP]: 'whatsapp',
  [TAB_TYPES.CONTENT_SOCIAL]: 'social',
  [TAB_TYPES.CONTENT_SOCIAL_MESSAGE]: 'social_message',
  [TAB_TYPES.CONTENT_AD_COPY]: 'ad_copy',
  [TAB_TYPES.CONTENT_BLOG]: 'blog',
  [TAB_TYPES.CONTENT_STUDIO]: 'all',
  contentstudio: 'all',
};

export const VALID_TAB_TYPES: readonly string[] = Object.freeze([
  ...new Set([
    ...Object.values(TAB_TYPES),
    ...Object.keys(LEGACY_TAB_ALIASES),
    ...Object.keys(CONTENT_TAB_TYPE_MAP),
  ]),
]);

export function normalizeTabType(tabType: string): string {
  return LEGACY_TAB_ALIASES[tabType] || CONTENT_TAB_TYPE_MAP[tabType] || tabType;
}

export function getTabLabel(tabType: string): string {
  const normalized = normalizeTabType(tabType) as TabType;
  return TAB_LABELS[normalized]
    || normalized.charAt(0).toUpperCase() + normalized.slice(1).replace(/-/g, ' ');
}

// Maps agent type keys to the tab type and selected agent for header clicks.
export const HEADER_AGENT_TAB_MAP: Record<string, { tabType: string; selectedAgent: string }> = {
  'lead_generation': { tabType: TAB_TYPES.LEADS, selectedAgent: 'lead-generation' },
  'lead-generation': { tabType: TAB_TYPES.LEADS, selectedAgent: 'lead-generation' },
  'content_studio': { tabType: TAB_TYPES.CONTENT_STUDIO, selectedAgent: 'content-studio' },
  'content-studio': { tabType: TAB_TYPES.CONTENT_STUDIO, selectedAgent: 'content-studio' },
  'outreach': { tabType: TAB_TYPES.OUTREACH, selectedAgent: 'outreach' },
  'performance_marketing': { tabType: TAB_TYPES.PERFORMANCE_MARKETING, selectedAgent: 'performance-marketing' },
  'performance-marketing': { tabType: TAB_TYPES.PERFORMANCE_MARKETING, selectedAgent: 'performance-marketing' },
  'icp_generation': { tabType: TAB_TYPES.ICP, selectedAgent: 'icp-generation' },
  'icp': { tabType: TAB_TYPES.ICP, selectedAgent: 'icp-generation' },
};
