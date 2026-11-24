/** Formatting-only normalization; callers parse HTML and return text, never markup. */
export type EmailTextFormat = 'text' | 'html';

export function normalizeEmailText(text: string): string {
  return text.replace(/[\u034f\u200b\ufeff]/g, '')
    .replace(/[\t\f\v \u00a0\u2007\u202f]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const EMAIL_NON_CONTENT = 'script,style,head,title,template,noscript,iframe,object,embed,svg,[hidden],[aria-hidden="true"]';
export const EMAIL_BLOCKS = 'p,div,tr,li,h1,h2,h3,h4,h5,h6,blockquote,section,article';
