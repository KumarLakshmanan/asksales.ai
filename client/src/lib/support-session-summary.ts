/** The persisted session summary also holds internal conversation memory
 * written by SupportConversationMemory.supportConversationContext.
 * Only use this for the sidebar summary, never for user/assistant messages. */
export function supportSessionSummaryPreview(summary: string | null | undefined): string | null {
  if (!summary) return null;
  try {
    const value: unknown = JSON.parse(summary);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const memory = value as Record<string, unknown>;
      if (memory.schemaVersion === 1 && memory.kind === "historical_user_statements"
        && typeof memory.expiresAt === "string" && Number.isFinite(Date.parse(memory.expiresAt))
        && Array.isArray(memory.references)) return null;
    }
  } catch {
    // Ordinary summaries are text. Preserve them verbatim, including JSON-like text.
  }
  return summary;
}
