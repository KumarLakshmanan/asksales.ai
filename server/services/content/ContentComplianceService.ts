import { z } from 'zod';
import { composeSocialCaption } from '../../../shared/socialCaption.js';
import {
  FACEBOOK_CHAR_LIMIT,
  FACEBOOK_MESSENGER_LIMIT,
  INSTAGRAM_DM_LIMIT,
  INSTAGRAM_POST_CAPTION_LIMIT,
  LINKEDIN_CHAR_LIMIT,
  LINKEDIN_INMAIL_LIMIT,
  META_AD_PRIMARY_TEXT_MAX,
  SMS_CHAR_LIMIT,
  TWITTER_CHAR_LIMIT,
  TWITTER_DM_LIMIT,
} from '../../utils/channelConstants.js';
import type { ResolvedContentBrandContext } from './ContentBrandContextService.js';
import {
  CANONICAL_TEMPLATE_VARIABLES,
  extractTemplateVariables,
  findUnknownTemplateVariables,
  renderContentTemplate,
} from '../../utils/contentTemplateRendering.js';

export const CANONICAL_CONTENT_VARIABLES = new Set(CANONICAL_TEMPLATE_VARIABLES);

const nullAsMissing = (value: unknown) => value === null ? undefined : value;
const optionalGeneratedString = (max: number, min = 0) => z.preprocess(
  nullAsMissing,
  z.string().trim().min(min).max(max).optional(),
);
const optionalGeneratedStringArray = (maxItems: number, maxLength: number) => z.preprocess(
  nullAsMissing,
  z.array(z.string().trim().min(1).max(maxLength)).max(maxItems).optional(),
);
const defaultedGeneratedStringArray = (maxItems: number, maxLength: number) => z.preprocess(
  nullAsMissing,
  z.array(z.string().trim().min(1).max(maxLength)).max(maxItems).default([]),
);
const optionalGeneratedInteger = z.preprocess(
  nullAsMissing,
  z.number().int().nonnegative().optional(),
);
const optionalGeneratedBoolean = z.preprocess(nullAsMissing, z.boolean().optional());

export const contentOutputSchemas = {
  email: z.object({
    subject: z.string().trim().min(1).max(200),
    preheader: optionalGeneratedString(110),
    greeting: optionalGeneratedString(1000),
    body: z.string().trim().min(1).max(50_000),
    closing: optionalGeneratedString(2000),
    signature: optionalGeneratedString(5000),
    cta: optionalGeneratedString(500),
    imagePrompt: optionalGeneratedString(10_000),
  }).passthrough(),
  sms: z.object({
    message: z.string().trim().min(1).max(320),
    characterCount: optionalGeneratedInteger,
    imagePrompt: optionalGeneratedString(10_000),
  }).passthrough(),
  social: z.object({
    title: optionalGeneratedString(150, 1),
    caption: z.string().trim().min(1).max(50_000),
    hashtags: defaultedGeneratedStringArray(30, 200),
    keywords: defaultedGeneratedStringArray(50, 200),
    callToAction: optionalGeneratedString(1000),
    imagePrompt: optionalGeneratedString(10_000),
    videoPrompt: optionalGeneratedString(10_000),
    imagePrompts: optionalGeneratedStringArray(4, 10_000),
    videoPrompts: optionalGeneratedStringArray(4, 10_000),
  }).passthrough(),
  social_message: z.object({
    subject: optionalGeneratedString(500),
    message: z.string().trim().min(1).max(20_000),
    platform: optionalGeneratedString(50),
    imagePrompt: optionalGeneratedString(10_000),
    videoPrompt: optionalGeneratedString(10_000),
  }).passthrough(),
  ad: z.object({
    headline: z.string().trim().min(1).max(500),
    primaryText: z.string().trim().min(1).max(5000),
    description: z.string().trim().min(1).max(2000),
    callToAction: z.string().trim().min(1).max(500),
    displayUrl: z.string().trim().min(1).max(2000),
    keywords: defaultedGeneratedStringArray(100, 200),
    imagePrompt: optionalGeneratedString(10_000, 1),
    videoPrompt: optionalGeneratedString(10_000),
    platform: optionalGeneratedString(50),
    headlines: optionalGeneratedStringArray(15, 100),
    descriptions: optionalGeneratedStringArray(10, 500),
    hashtags: optionalGeneratedStringArray(30, 200),
    visualFocus: optionalGeneratedString(5000),
    professionalTone: optionalGeneratedBoolean,
  }).passthrough(),
  blog: z.object({
    title: z.string().trim().min(1).max(300),
    content: z.string().trim().min(1).max(200_000),
    excerpt: z.string().trim().min(1).max(5000),
    tags: defaultedGeneratedStringArray(50, 200),
    featuredImagePrompt: optionalGeneratedString(10_000),
  }).passthrough(),
} as const;

export type ContentOutputType = keyof typeof contentOutputSchemas;

export class ContentComplianceError extends Error {
  constructor(public readonly violations: string[]) {
    super(violations.join(' '));
    this.name = 'ContentComplianceError';
  }
}

export function extractJsonObject(raw: string): unknown {
  const cleaned = (raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const firstObject = cleaned.indexOf('{');
    const lastObject = cleaned.lastIndexOf('}');
    if (firstObject >= 0 && lastObject > firstObject) {
      return JSON.parse(cleaned.slice(firstObject, lastObject + 1));
    }
    throw new ContentComplianceError(['The provider response was not valid JSON.']);
  }
}

export function parseStructuredContent<T extends ContentOutputType>(
  type: T,
  raw: string | unknown,
): z.infer<(typeof contentOutputSchemas)[T]> {
  const value = typeof raw === 'string' ? extractJsonObject(raw) : raw;
  return contentOutputSchemas[type].parse(value) as z.infer<(typeof contentOutputSchemas)[T]>;
}

export function findTemplateVariables(content: string): string[] {
  return extractTemplateVariables(content);
}

export function renderContentVariables(
  content: string,
  values: Record<string, string | number | null | undefined>,
): string {
  const result = renderContentTemplate(content, values);
  if (result.unresolved.length) {
    throw new ContentComplianceError([
      `Unresolved template variables: ${result.unresolved.join(', ')}.`,
    ]);
  }
  return result.rendered;
}

const PLATFORM_LIMITS: Record<string, number> = {
  twitter: TWITTER_CHAR_LIMIT,
  linkedin: LINKEDIN_CHAR_LIMIT,
  facebook: FACEBOOK_CHAR_LIMIT,
  instagram: INSTAGRAM_POST_CAPTION_LIMIT,
  linkedin_dm: LINKEDIN_INMAIL_LIMIT,
  twitter_dm: TWITTER_DM_LIMIT,
  facebook_dm: FACEBOOK_MESSENGER_LIMIT,
  instagram_dm: INSTAGRAM_DM_LIMIT,
  whatsapp: 4096,
  sms: SMS_CHAR_LIMIT,
};

const PLATFORM_NAMES: Record<string, string> = {
  twitter: 'X (Twitter)', linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', whatsapp: 'WhatsApp', sms: 'SMS',
};

/** Per-post character limit for one social post or DM, or undefined when the
 * platform has none. Applies to ONE post: a multi-post plan is validated post
 * by post, never as a single caption. */
export function socialCharacterLimit(type: 'social' | 'social_message', platform: string): number | undefined {
  const key = (platform || '').toLowerCase();
  return PLATFORM_LIMITS[type === 'social_message' ? `${key}_dm` : key];
}

/** The exact text checked against a social platform's per-post limit. */
export function socialPostText(output: Record<string, unknown>): string {
  return composeSocialCaption(output);
}

function contentText(type: ContentOutputType, output: Record<string, unknown>): string {
  if (type === 'email') {
    return [output.subject, output.greeting, output.body, output.closing, output.signature, output.cta]
      .filter(Boolean)
      .join('\n');
  }
  if (type === 'social') return composeSocialCaption(output);
  if (type === 'social_message' || type === 'sms') return String(output.message || '');
  if (type === 'ad') {
    return [output.headline, output.primaryText, output.description, output.callToAction, output.displayUrl]
      .filter(Boolean)
      .join('\n');
  }
  return [output.title, output.excerpt, output.content].filter(Boolean).join('\n');
}

function normalizedRestrictions(context: ResolvedContentBrandContext): string[] {
  const rawBusiness = context.businessProfile.restrictions || '';
  const businessRules = rawBusiness
    .split(/\r?\n|;|\|/)
    .map(rule => rule.replace(/^[-*]\s*/, '').trim())
    .map(rule => rule
      .replace(/^(?:do\s+not|don't|never|avoid|must\s+not|no)\s+(?:say|mention|use|claim|include|reference|promise)?\s*/i, '')
      .replace(/^["'“”‘’]+|["'“”‘’.,:;]+$/g, '')
      .trim())
    .filter(rule => rule.length >= 4);
  const voiceDonts = Array.isArray(context.brandToolkit.voiceDonts)
    ? context.brandToolkit.voiceDonts.filter(rule => typeof rule === 'string' && rule.trim().length >= 4)
    : [];
  return [...businessRules, ...voiceDonts];
}

function validateUrls(text: string): string[] {
  const violations: string[] = [];
  if (/(?:javascript|vbscript|data):/i.test(text)) {
    violations.push('Unsafe URL scheme detected.');
  }
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"')\]}]+/gi)) {
    try {
      const parsed = new URL(match[0]);
      if (!parsed.hostname.includes('.')) violations.push(`Invalid URL: ${match[0]}.`);
      if (parsed.protocol !== 'https:') violations.push(`Published links must use HTTPS: ${match[0]}.`);
    } catch {
      violations.push(`Invalid URL: ${match[0]}.`);
    }
  }
  return violations;
}

export function validateGeneratedContent(options: {
  type: ContentOutputType;
  output: Record<string, unknown>;
  context: ResolvedContentBrandContext;
  platform?: string;
  smsMaxCharacters?: number;
}): void {
  const { type, output, context } = options;
  const text = contentText(type, output);
  const violations: string[] = [];

  for (const variable of findUnknownTemplateVariables(text)) {
    violations.push(`Unsupported template variable: ${variable}.`);
  }

  const lowered = text.toLocaleLowerCase();
  for (const restriction of normalizedRestrictions(context)) {
    if (lowered.includes(restriction.toLocaleLowerCase())) {
      violations.push(`Content violates a brand restriction: "${restriction}".`);
    }
  }

  const highRiskClaims = [
    /\bguaranteed\b/i,
    /\b100%\s+(?:guaranteed|effective|safe|success)\b/i,
    /\brisk[- ]free\b/i,
    /\b(?:the\s+)?#?1\s+(?:best|leading|rated)\b/i,
  ];
  if (highRiskClaims.some(pattern => pattern.test(text))) {
    violations.push('Content includes an unsubstantiated absolute or guaranteed claim.');
  }

  violations.push(...validateUrls(text));
  if (/\[(?:insert|add|your)?\s*(?:link|url|website|contact)[^\]]*\]/i.test(text)) {
    violations.push('Bracket-style URL or contact placeholders are not allowed.');
  }

  const platform = (options.platform || '').toLowerCase();
  const smsLimit = options.smsMaxCharacters === 320 ? 320 : SMS_CHAR_LIMIT;
  if (type === 'sms' && text.length > smsLimit) {
    violations.push(`SMS content exceeds ${smsLimit} characters.`);
  }
  if (type === 'social' || type === 'social_message') {
    const limit = socialCharacterLimit(type, platform);
    if (limit && text.length > limit) {
      const name = PLATFORM_NAMES[platform] || platform;
      const item = type === 'social_message' ? 'message' : 'post';
      violations.push(`The ${name} ${item} exceeds the ${limit.toLocaleString('en-US')}-character limit: it is ${text.length.toLocaleString('en-US')} characters including the call to action and hashtags. Shorten it${type === 'social' ? ', or split it into separate posts' : ''}.`);
    }
  }
  if (type === 'ad') {
    if (!String(output.callToAction || '').trim()) violations.push('Ad call-to-action is required.');
    if (platform === 'facebook' || platform === 'meta' || platform === 'instagram' || platform === 'all') {
      if (String(output.primaryText || '').length > META_AD_PRIMARY_TEXT_MAX) {
        violations.push(`Meta ad primary text exceeds ${META_AD_PRIMARY_TEXT_MAX} characters.`);
      }
      if (String(output.headline || '').length > 40) {
        violations.push('Meta ad headline exceeds 40 characters.');
      }
      if (String(output.description || '').length > 30) {
        violations.push('Meta ad description exceeds 30 characters.');
      }
    }
    if (platform === 'google' || platform === 'all') {
      const headlines = Array.isArray(output.headlines)
        ? output.headlines.map(String)
        : [String(output.headline || '')];
      const descriptions = Array.isArray(output.descriptions)
        ? output.descriptions.map(String)
        : [String(output.description || '')];
      if (headlines.some(headline => headline.length > 30)) {
        violations.push('Google ad headlines must be 30 characters or fewer.');
      }
      if (descriptions.some(description => description.length > 90)) {
        violations.push('Google ad descriptions must be 90 characters or fewer.');
      }
    }
    const displayUrl = String(output.displayUrl || '').trim();
    if (!displayUrl) {
      violations.push('Ad destination URL is required.');
    } else if (/enter your|example\.com|placeholder/i.test(displayUrl)) {
      violations.push('Ad destination URL is still a placeholder.');
    } else {
      const approvedWebsite = context.businessProfile.website || context.brandToolkit.website || '';
      if (!approvedWebsite) {
        violations.push('An approved business or Brand Toolkit website is required for ads.');
      } else {
        try {
          const destination = new URL(/^https?:\/\//i.test(displayUrl) ? displayUrl : `https://${displayUrl}`);
          const approved = new URL(/^https?:\/\//i.test(approvedWebsite) ? approvedWebsite : `https://${approvedWebsite}`);
          if (destination.protocol !== 'https:') {
            violations.push('Ad destination URL must use HTTPS.');
          }
          const destinationHost = destination.hostname.replace(/^www\./, '').toLowerCase();
          const approvedHost = approved.hostname.replace(/^www\./, '').toLowerCase();
          if (
            destinationHost !== approvedHost
            && !destinationHost.endsWith(`.${approvedHost}`)
          ) {
            violations.push('Ad destination URL must use the approved business or Brand Toolkit domain.');
          }
        } catch {
          violations.push('Ad destination URL is invalid.');
        }
      }
    }
  }

  if (violations.length) throw new ContentComplianceError([...new Set(violations)]);
}
