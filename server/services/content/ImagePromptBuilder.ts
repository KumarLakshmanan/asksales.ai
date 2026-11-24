/**
 * Brand data the image prompt may use. Accepts the resolved Studio context and
 * the chat/ads tool context (whose toolkit and business profile carry the same
 * fields at runtime).
 */
export interface ImageBrandSource {
  businessProfile?: object | null;
  brandToolkit?: object | null;
}

/**
 * Builds the text sent to image models (Seedream, GPT Image, Gemini, ...).
 *
 * Image models paint whatever words they are given, and they weight the start
 * of the prompt most. So the user's request goes first and in full, the rules
 * that protect it come next, and brand context comes last as visual guidance
 * only. Marketing copy (tagline, value proposition, description, goals) is
 * never sent: a model shown "Tagline: ..." renders it, which is how unrelated
 * slogans and unverified product claims ended up inside generated images.
 */

/** Provider prompt ceiling (OpenRouter, Gemini). */
export const IMAGE_PROVIDER_PROMPT_LIMIT = 4000;
/** Room kept for the logo-reference instructions appended when a logo is attached. */
const LOGO_REFERENCE_RESERVE = 1100;
export const IMAGE_PROMPT_LIMIT = IMAGE_PROVIDER_PROMPT_LIMIT - LOGO_REFERENCE_RESERVE;
/** The request is never cut below this; brand context gives way first. */
export const IMAGE_USER_PROMPT_LIMIT = 2000;

const AUTO = 'auto';

function clip(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : JSON.stringify(value);
  if (!text || text === '[]' || text === '{}' || text === 'null') return '';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/** Text the request puts in quotes: those are the exact words to render. */
export function extractRequestedText(prompt: string): string[] {
  const found: string[] = [];
  for (const match of prompt.matchAll(/"([^"\n]{2,200})"|“([^”\n]{2,200})”/g)) {
    const text = (match[1] ?? match[2] ?? '').trim();
    if (text && !found.includes(text)) found.push(text);
  }
  return found.slice(0, 6);
}

function styleLabel(style: string | undefined): string | undefined {
  const value = style?.trim();
  if (!value || value.toLowerCase() === AUTO) return undefined;
  return value.replace(/[-_]+/g, ' ');
}

/** Visual-only brand guidance for image models. Never includes marketing copy. */
export function formatImageBrandContext(context: ImageBrandSource, options: { includeLogo?: boolean } = {}): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const business = (context.businessProfile ?? {}) as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolkit = (context.brandToolkit ?? {}) as Record<string, any>;
  const logoVisible = toolkit.logoVisibility !== false && options.includeLogo !== false;
  const hasApprovedLogo = Boolean(toolkit.logoUrl || toolkit.logoUrls?.[0]);
  const colors = {
    primary: toolkit.primaryColors?.length ? toolkit.primaryColors : [toolkit.primaryBrandColor].filter(Boolean),
    secondary: toolkit.secondaryColors?.length ? toolkit.secondaryColors : [toolkit.secondaryBrandColor].filter(Boolean),
    additional: toolkit.additionalColors,
  };
  const lines = [
    ['Brand', clip(toolkit.name || business.companyName || business.businessName || business.name, 120)],
    ['Industry', clip([business.industry, business.subIndustry].filter(Boolean).join(' / '), 160)],
    ['Brand colors (use as accents; use as the main palette only when the request names no colors)', clip(colors, 260)],
    ['Typography for any requested text', clip(toolkit.fonts || (toolkit.fontFamily ? { body: toolkit.fontFamily } : undefined), 160)],
    ['House image style (only when the request names no style)', clip(toolkit.imageStyleReference, 160)],
    ['Visual instructions (follow unless the request says otherwise)', clip(toolkit.visualInstructions, 420)],
    ['Restrictions (mandatory)', clip(business.restrictions, 220)],
    ['Logo rules (mandatory)', clip(toolkit.logoUsageGuidelines, 220)],
  ].filter(([, value]) => value).map(([label, value]) => `- ${label}: ${value}`);
  lines.push(`- Logo: ${logoVisible && hasApprovedLogo
    ? 'the approved logo is attached as a reference image. Reproduce it faithfully if it appears; never invent, redraw or add another mark.'
    : logoVisible
      ? 'no approved logo is available. Do not invent a logo or wordmark.'
      : 'logo display is off. Do not render a logo or wordmark.'}`);
  return lines.join('\n');
}

export interface ImagePromptInput {
  userPrompt: string;
  style?: string;
  brandContext?: ImageBrandSource | null;
  /** False when the user excluded logos, or no logo will be attached. */
  includeLogo?: boolean;
  maxLength?: number;
}

export function buildImageGenerationPrompt({ userPrompt, style, brandContext, includeLogo, maxLength = IMAGE_PROMPT_LIMIT }: ImagePromptInput): string {
  const request = userPrompt.trim().slice(0, IMAGE_USER_PROMPT_LIMIT);
  const requestedText = extractRequestedText(request);
  const preset = styleLabel(style);
  const rules = [
    '- The request above decides the subject, composition, background, colors, lighting, art style and framing. If anything below conflicts with it, the request wins.',
    `- Text in the image: show only the words the request asks to appear, spelled exactly as written${requestedText.length
      ? ` (quoted in the request: ${requestedText.map((text) => `"${text}"`).join(', ')}; quotes that describe the look rather than words to show are not text)`
      : ''}. Add no other words. If the request asks for no text, render none.`,
    '- Do not add taglines, slogans, product claims, feature lists, prices, statistics, URLs or calls to action that the request does not contain.',
    ...(preset ? [`- Selected style preset: ${preset}. Use it only where the request does not already name a style.`] : []),
  ];
  const head = `IMAGE REQUEST (follow exactly):\n${request}\n\nRULES:\n${rules.join('\n')}`;
  if (!brandContext || (!brandContext.brandToolkit && !brandContext.businessProfile)) return head.slice(0, maxLength);
  const brandHeader = '\n\nBRAND REFERENCE (visual guidance only; never write any of it in the image):\n';
  const budget = maxLength - head.length - brandHeader.length;
  if (budget < 80) return head.slice(0, maxLength);
  return `${head}${brandHeader}${formatImageBrandContext(brandContext, { includeLogo }).slice(0, budget)}`;
}
