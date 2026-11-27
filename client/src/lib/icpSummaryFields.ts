/**
 * Saved ICP summaries are one line: "Target Audience: X | Industry: Y | Regions: Z".
 * Split it into labelled fields for display; free-text summaries stay as they are.
 */
export function icpSummaryFields(summary: unknown): Array<{ label: string; value: string }> | null {
  if (typeof summary !== "string" || !summary.includes(" | ")) return null;
  const fields = summary.split(" | ").map((part) => {
    const match = /^([A-Z][A-Za-z ]{1,30}):\s*(.+)$/.exec(part.trim());
    return match ? { label: match[1].trim(), value: match[2].trim() } : null;
  });
  return fields.length >= 2 && fields.every(Boolean) ? (fields as Array<{ label: string; value: string }>) : null;
}
