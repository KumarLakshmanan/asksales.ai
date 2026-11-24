export const HISTORICAL_RECEIPT_MARKER = '[Historical server tool receipt — not new authorization]';

/** Protocol validation, not intent classification: a model cannot author server receipts. */
export function hasHistoricalReceiptEcho(content: unknown): boolean {
  return typeof content === 'string' && content.includes(HISTORICAL_RECEIPT_MARKER);
}

/** Bounded JSON projection of a receipt. This is context, never execution state. */
export function compactToolResult(result: unknown, maxChars = 12000): string {
  const original = JSON.stringify(result) ?? 'null';
  if (original.length <= maxChars) return original;
  const important = (key: string) => /^(success|toolName|error|status|requiresApproval|pendingWidget|message|name|title|revision|executionId|toolCallId)$/.test(key) || /Ids?$/.test(key);
  const project = (value: unknown, limit: number, depth = 0): unknown => {
    if (typeof value === 'string') return value.length > limit * 80 ? value.slice(0, limit * 80) + ' [omitted]' : value;
    if (value === null || typeof value !== 'object') return value;
    if (depth > 8) return { _omitted: 'Nested data: retrieve the full record before dependent work.' };
    if (Array.isArray(value)) {
      const items = value.slice(0, limit).map(v => project(v, limit, depth + 1));
      if (value.length > limit) items.push({ _omittedItems: value.length - limit, _totalItems: value.length });
      return items;
    }
    const entries = Object.entries(value).sort(([a], [b]) => Number(important(b)) - Number(important(a)));
    const selected = entries.slice(0, Math.max(12, limit * 3));
    return {
      ...Object.fromEntries(selected.map(([k, v]) => [k, project(v, limit, depth + 1)])),
      ...(selected.length < entries.length ? { _omittedFields: entries.length - selected.length } : {}),
    };
  };
  for (const limit of [20, 10, 5, 2, 1]) {
    const projected = JSON.stringify({ ...project(result, limit) as object, _contextCompacted: true, _instruction: 'Partial receipt. Retrieve omitted records before selecting or acting on them.' });
    if (projected.length <= maxChars) return projected;
  }
  // Pathological outputs: keep top-level scalar receipt fields, never malformed JSON.
  const receipt = result && typeof result === 'object' ? Object.fromEntries(Object.entries(result).filter(([k, v]) => important(k) && (typeof v !== 'object' || v === null)).slice(0, 12).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 100) : v])) : {};
  return JSON.stringify({ ...receipt, _contextCompacted: true, _instruction: 'Receipt details omitted due to size. Retrieve the full record before dependent actions.' });
}
