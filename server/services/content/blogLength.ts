export type BlogLength = 'short' | 'medium' | 'long';

interface BlogLengthTarget {
  min: number;
  max: number;
  /** Output budget large enough for the article plus its JSON wrapper. */
  maxTokens: number;
}

export const BLOG_LENGTH_TARGETS: Record<BlogLength, BlogLengthTarget> = {
  short: { min: 500, max: 800, maxTokens: 3000 },
  medium: { min: 1000, max: 1500, maxTokens: 5000 },
  long: { min: 2000, max: 3000, maxTokens: 9000 },
};

export function blogLengthTarget(length: string | undefined): BlogLengthTarget {
  return BLOG_LENGTH_TARGETS[(length as BlogLength) in BLOG_LENGTH_TARGETS ? length as BlogLength : 'medium'];
}

export function blogLengthInstruction(length: string | undefined): string {
  const { min, max } = blogLengthTarget(length);
  return `${min}-${max} words. The article body must contain at least ${min} words; count only the article text, not the JSON.`;
}

/** Words a reader sees, ignoring Markdown markers and link targets. */
export function countWords(markdown: string): number {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|~-]+/g, ' ');
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** A post well under the reviewed minimum gets one expansion pass. */
export function blogNeedsExpansion(content: string, length: string | undefined): boolean {
  return countWords(content) < Math.floor(blogLengthTarget(length).min * 0.85);
}

export function blogExpansionRequest(content: string, length: string | undefined): string {
  const { min, max } = blogLengthTarget(length);
  return `The article above has ${countWords(content)} words, but the reviewed length is ${min}-${max} words. `
    + `Expand it to between ${min} and ${max} words: deepen each section with concrete examples, steps and explanations. `
    + 'Keep the same title, topic, tone, keywords and facts; do not invent statistics, prices or customer names. '
    + 'Return the complete post in the same JSON format.';
}
