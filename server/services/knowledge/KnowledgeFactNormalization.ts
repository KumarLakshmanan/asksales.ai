const SMALL_NUMBERS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
};

/** Narrow wording equivalences used to compare published facts with queries
 * and answers. This normalizes established paraphrases; it does not infer
 * truth or turn a missing source into support. */
export function normalizeKnowledgeFactText(value: string): string {
  return value.toLowerCase()
    .replace(/\b\d{1,3}(?:,\d{2})+,\d{3}\b|\b\d{1,3}(?:,\d{3})+\b/g, (amount) => amount.replace(/,/g, ''))
    .replace(/(?<=\d)[,\s](?=\d{3}(?:\D|$))/g, '')
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (word) => SMALL_NUMBERS[word])
    .replace(/check[ -]?in/g, 'checkin')
    .replace(/check[ -]?out/g, 'checkout')
    .replace(/\bday[- ]out(?:ing)?\b/g, 'day out')
    .replace(/\b(?:hours?|timings?|times?)\b/g, 'time')
    .replace(/\b(?:exclusive|excluding|excludes?|exclude)\s+(?:of\s+)?(?:applicable\s+)?gst\b/g, 'gst not included')
    .replace(/\+\s*gst\b/g, 'gst not included')
    .replace(/\bgst\s+(?:(?:is|are)\s+)?(?:not\s+included|excluded|extra|charged\s+separately)\b/g, 'gst not included')
    .replace(/\bspa(?:\s*(?:&|and)\s*wellness)?\s+services?\s+(?:(?:are|is)\s+)?(?:chargeable\s+separately|charged\s+separately|not\s+included|excluded|costs?\s+extra)\b/g, 'spa services not included');
}
