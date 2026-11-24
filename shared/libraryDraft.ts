/** Shared normalization for saved drafts, reusable copies and campaign handoff. */
import { extractBlogBody } from './blogContent.js';
import { readEmailDraft } from './emailTemplateSections.js';
export type LibraryTextKind = 'email' | 'sms' | 'dm' | 'social' | 'ad' | 'blog';
export function readLibraryDraft(content: string): { subject: string; body: string; html: string; fields: Record<string, unknown> } {
  let fields: Record<string, unknown> = {};
  try {
    const value = JSON.parse(content);
    if (typeof value === 'string') return { subject: '', body: value, html: '', fields };
    if (value && typeof value === 'object' && !Array.isArray(value)) fields = value;
  } catch { /* Plain-text drafts are supported. */ }
  const string = (key: string) => typeof fields[key] === 'string' ? fields[key] as string : '';
  if (['subject', 'emailSubject', 'greeting', 'signature', 'preheader', 'html', 'htmlContent'].some(key => key in fields)) {
    const email = readEmailDraft(fields);
    return { subject: email.subject, body: email.body, html: email.html, fields: email.sections };
  }
  const main = string('body') || string('emailBody') || string('message') || string('dm') || string('caption') || string('primaryText') || string('primary_text') || string('text') || string('content');
  const structuredBlog = !main && (fields.introduction || fields.sections || fields.conclusion) ? extractBlogBody(content) : '';
  const body = [string('greeting'), main ? extractBlogBody(main) : structuredBlog, string('closing'), string('signature')].filter(Boolean).join('\n\n');
  return { subject: string('subject') || string('emailSubject') || string('headline') || string('title'), body: body || (Object.keys(fields).length ? '' : content), html: string('htmlContent'), fields };
}

export function updateLibraryDraft(content: string, kind: LibraryTextKind, subject: string, body: string, html: string) {
  const { fields } = readLibraryDraft(content);
  const next = { ...fields };
  if (kind !== 'email' && kind !== 'sms') {
    for (const key of ['body', 'message', 'caption', 'primaryText', 'primary_text', 'text', 'content']) {
      if (typeof next[key] === 'string') next[key] = body;
    }
    const mainKey = kind === 'social' ? 'caption' : kind === 'ad' ? 'primaryText' : kind === 'blog' ? 'content' : 'message';
    next[mainKey] = body;
    if (kind === 'ad') next.headline = subject;
    if (kind === 'blog') next.title = subject;
    return JSON.stringify(next);
  }
  // Flatten the editable message once; retain media and generation provenance fields.
  for (const key of ['greeting', 'closing', 'signature', 'cta', 'body', 'message', 'text', 'content', 'htmlContent', 'html']) delete next[key];
  return JSON.stringify(kind === 'email' ? { ...next, subject, body, ...(html ? { htmlContent: html } : {}) } : { ...next, message: body, characterCount: body.length });
}

export function reusableLibraryContent(kind: LibraryTextKind, content: string) {
  const parsed = readLibraryDraft(content);
  if (kind === 'email' || kind === 'sms') return parsed.body;
  const fields = JSON.parse(updateLibraryDraft(content, kind, parsed.subject, parsed.body, '')) as Record<string, unknown>;
  const keys = kind === 'ad' ? ['headline', 'primaryText', 'description', 'callToAction', 'displayUrl', 'url', 'headlines', 'descriptions']
    : kind === 'social' ? ['caption', 'hashtags', 'callToAction', 'platform']
    : kind === 'blog' ? ['title', 'content', 'excerpt', 'tags', 'seoTitle', 'metaDescription'] : ['message', 'platform'];
  return JSON.stringify(Object.fromEntries(keys.filter(key => fields[key] !== undefined).map(key => [key, fields[key]])));
}

export function libraryCampaignUrl(kind: 'email' | 'sms', source: 'asset' | 'template', id: number) {
  return `/dashboard/outreach/${kind}/create?${source === 'asset' ? 'sourceAssetId' : 'sourceTemplateId'}=${id}`;
}
