import {
  contentStudioGenerateSchema,
  contentStudioEmailSchema,
  contentStudioSmsSchema,
  contentStudioBlogSchema,
  contentStudioSocialSchema,
  contentStudioVideoSchema,
} from '../../middleware/schemas.js';

/** Translate legacy naming, then apply the same bounded channel contracts. */
export function mapLegacyContentRequest(input: unknown):
  | { supported: false; type: string }
  | { supported: true; type: 'email' | 'sms' | 'blog' | 'social' | 'video'; body: Record<string, unknown> } {
  const parsed = contentStudioGenerateSchema.parse(input);
  const { topic, content_type, type, icp_id, thread_id, tone, ...remaining } = parsed;
  const requestedType = type || content_type!;
  if (!['email', 'sms', 'blog', 'blog_post', 'social', 'social_post', 'video'].includes(requestedType)) {
    return { supported: false, type: requestedType };
  }
  const body = {
    ...remaining,
    prompt: parsed.prompt || topic!,
    ...(parsed.icpId || icp_id ? { icpId: parsed.icpId || icp_id } : {}),
    ...(parsed.threadId || thread_id ? { threadId: parsed.threadId || thread_id } : {}),
  };
  switch (requestedType) {
    case 'email': return { supported: true, type: 'email', body: contentStudioEmailSchema.parse({ ...body, ...(tone === undefined ? {} : { tone }) }) };
    case 'sms': return { supported: true, type: 'sms', body: contentStudioSmsSchema.parse({ ...body, prompt: tone ? `${body.prompt}\nRequested tone: ${tone}` : body.prompt }) };
    case 'blog':
    case 'blog_post': return { supported: true, type: 'blog', body: contentStudioBlogSchema.parse({ ...body, ...(tone === undefined ? {} : { tone }) }) };
    case 'social':
    case 'social_post': return { supported: true, type: 'social', body: contentStudioSocialSchema.parse({ platform: 'linkedin', ...body, prompt: tone ? `${body.prompt}\nRequested tone: ${tone}` : body.prompt }) };
    case 'video': return { supported: true, type: 'video', body: contentStudioVideoSchema.parse({ saveToAssets: true, ...body, prompt: tone ? `${body.prompt}\nRequested tone: ${tone}` : body.prompt }) };
  }
  throw new Error('Unsupported canonical format');
}
