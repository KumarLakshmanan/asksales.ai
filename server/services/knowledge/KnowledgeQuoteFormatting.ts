import type { VerifiedKnowledgeAnswer } from './types.js';

/** Internal previews support multiple answer bubbles. Keep every exact quote
 * and its terms, rather than dropping catalog options to fit one bubble. No
 * text is reconstructed if privacy filtering changed the verified content. */
export function splitPublishedQuote(finalText: string, verification: VerifiedKnowledgeAnswer | undefined, maxChars: number): string | null {
  if (verification?.reason !== 'verbatim_published_evidence' || !verification.mayDeliver
    || !verification.claims.length || verification.claims.some(claim => !finalText.includes(claim.claim))) return null;
  const parts: string[] = [];
  let pending = '';
  for (const paragraph of finalText.split(/\n\s*\n/)) {
    if (paragraph.length > maxChars) return null;
    if (pending && pending.length + paragraph.length + 2 > maxChars) {
      parts.push(pending);
      pending = '';
    }
    pending += `${pending ? '\n\n' : ''}${paragraph}`;
  }
  if (pending) parts.push(pending);
  return parts.length ? parts.join('|||') : null;
}

/** Deterministic presentation of an already verified quote. Only markup/list
 * markers are added; factual wording and qualifications are not rewritten. */
export function presentPublishedQuote(text: string, request: string): string {
  const numbered = /\bnumbered\b/i.test(request);
  const bulleted = /\bbullet(?:ed|s|\s+points?)?\b/i.test(request);
  const boldHeading = /\bbold\b/i.test(request) && /\bheading\b/i.test(request);
  const plainSentence = /\bsentence\b/i.test(request) || /\b(?:without|no)\s+markdown\b/i.test(request);
  const quote = text.replace(/^From the published knowledge base:\s*\n+/i, '').trim();
  if (!numbered && !bulleted && !boldHeading) {
    return plainSentence ? quote.replace(/^\s*[•*-]\s*/gm, '') : quote;
  }
  let ordinal = 0;
  const rendered = quote.split('|||').map(part => {
    const lines = part.split('\n');
    return lines.map((line, index) => {
      const bullet = /^\s*[•*-]\s+(.+)$/.exec(line);
      if (numbered && bullet) return `${++ordinal}. ${bullet[1]}`;
      if (bulleted && bullet) return `• ${bullet[1]}`;
      if (boldHeading && index === 0 && line.trim()) {
        if (/^\*\*[^*]+\*\*$/.test(line.trim())) return line.trim();
        return `**${line.trim().replace(/^\d+[.)]\s+/, '')}**`;
      }
      return line;
    }).join('\n');
  }).join('|||');
  // A line-level PDF extract may contain only the requested bullet and no
  // published title. Add a neutral presentation label when the user asked
  // for a bold heading; this carries no factual assertion.
  return boldHeading && /^\s*[•*-]\s/m.test(quote) && !/^\*\*/.test(rendered)
    ? `**Published details**\n${rendered}`
    : rendered;
}

/** Shorten only by removing whole optional quoted paragraphs. Never restore
 * text changed by privacy filtering, cut a sentence, or drop source terms or
 * the subsequent playbook/disclaimer suffix to satisfy a display limit.
 */
export function fitPublishedQuote(finalText: string, verification: VerifiedKnowledgeAnswer | undefined, maxChars: number) {
  if (verification?.reason !== 'verbatim_published_evidence' || !verification.mayDeliver) return null;
  const claims = verification.claims;
  if (!claims.length || claims.some(claim => !finalText.includes(claim.claim))) return null;
  const last = claims.at(-1)!.claim;
  const suffix = finalText.slice(finalText.lastIndexOf(last) + last.length);
  const required = claims.filter(claim => /\bterms\s*(?:&|and)\s*conditions\b/i.test(claim.claim));
  const optional = claims.filter(claim => !required.includes(claim));
  const selected: typeof claims = [];
  const render = (items: typeof claims) => `${items.map(claim => claim.claim).join('\n\n')}${suffix}`;
  for (const claim of optional) {
    if (render([...selected, claim, ...required]).length <= maxChars) selected.push(claim);
  }
  if (!selected.length) return null;
  const retained = [...selected, ...required];
  return { text: render(retained), verification: { ...verification, claims: retained } };
}
