/**
 * Extract explicit lead IDs only when the user labels the numbers as lead IDs.
 * This deliberately avoids treating budgets, years, dates, and counts as
 * recipients.
 */
export function extractExplicitLeadIds(message: string): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  const pattern = /\b(?:exact\s+|selected\s+)?lead\s+ids?\s*(?::|=|are\b|is\b|#)?\s*(#?\d+(?:\s*(?:,\s*(?:and\s+)?|and\s+|&\s*)#?\d+){0,99})/gi;

  for (const match of message.matchAll(pattern)) {
    for (const token of match[1].match(/\d+/g) || []) {
      const id = Number(token);
      if (Number.isInteger(id) && id > 0 && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }

  return ids;
}
