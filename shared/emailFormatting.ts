/** Internal previews must not record a recipient open by loading our transport pixel. */
export function stripEmailOpenTracking(html: string): string {
  return html.replace(/<img\b[^>]*(?:data-asksales-open-tracker|\/api\/email-events\/open\/)[^>]*>/gi, '');
}

/** Preserve text layout without depending on the composer's page CSS. */
export function plainTextToEmailHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/\t/g, '    ')
    .replace(/ {2,}/g, spaces => ' ' + '&nbsp;'.repeat(spaces.length - 1))
    .replace(/\r\n?|\n/g, '<br>');
}

/**
 * Legacy compose/send APIs accept both text and HTML in the same body field.
 * Keep HTML templates intact, but encode unformatted bodies before HTML delivery.
 * Recognize email tags specifically so addresses such as <sales@example.com>
 * and literal angle-bracket text are not mistaken for markup.
 */
export function hasEmailMarkup(body: string): boolean {
  return /<!doctype\s+html\b|<\/?(?:html|head|body|title|meta|style|script|p|div|br|hr|span|a|b|strong|i|em|u|s|strike|del|font|small|sub|sup|h[1-6]|ul|ol|li|blockquote|pre|code|table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|img|picture|source|center|section|article|header|footer)(?:\s[^<>]*|\s*\/?)>/i.test(body);
}

export function emailBodyToHtml(body: string): string {
  if (!body) return body;
  if (!hasEmailMarkup(body)) return `<div>${plainTextToEmailHtml(body)}</div>`;
  // Rich composer fragments can mix actual formatting tags with typed line
  // breaks. HTML otherwise collapses those breaks, joining the greeting and
  // body. Leave complete designed documents and table layouts unchanged.
  if (/<!doctype\s+html\b|<(?:html|table)\b/i.test(body)) return body;
  let literalDepth = 0;
  const parts = body.split(/(<!--[\s\S]*?-->|<\/?[a-z][a-z0-9:-]*(?:[^>"']|"[^"]*"|'[^']*')*>)/gi);
  const inlineTag = /^<\/?(?:a|b|strong|i|em|u|s|strike|span|font|small|sub|sup)\b/i;
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      if (/^<(?:pre|code|style|script)\b/i.test(part)) literalDepth++;
      else if (/^<\/(?:pre|code|style|script)\b/i.test(part)) literalDepth = Math.max(0, literalDepth - 1);
      return part;
    }
    const betweenInlineTags = inlineTag.test(parts[index - 1] || '') && inlineTag.test(parts[index + 1] || '');
    return !literalDepth && (part.trim() || betweenInlineTags) ? part.replace(/\r\n?|\n/g, '<br>') : part;
  }).join('');
}

/** Remove generated placeholders while keeping paragraph and signature breaks. */
export function stripEmailPlaceholders(text: string): string {
  return text.replace(/[ \t]*\[[\w \t/'-]+\][ \t]*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ').trim();
}
