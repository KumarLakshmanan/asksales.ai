/** Literal review field, not an intent classifier. Never let generation paraphrase it away. */
export function withExactCallToAction(body: string, cta?: string): string {
  const exact = cta?.trim();
  if (!exact || body.includes(exact)) return body;
  return `${body.trimEnd()}\n\n${exact}`;
}

/** The reviewed CTA owns the closing slot; a second model-written ask would change it. */
export function withReviewedEmailCta<T extends { body: string; closing?: string; cta?: string }>(template: T, cta?: string): T {
  if (!cta?.trim()) return template;
  return { ...template, body: withExactCallToAction(template.body, cta), closing: '', cta: cta.trim() };
}
