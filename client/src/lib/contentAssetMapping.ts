export function contentAssetSmsMessage(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const value = parsed as Record<string, unknown>;
      for (const field of ["message", "content", "body", "caption"] as const) {
        if (typeof value[field] === "string" && value[field].trim()) return value[field];
      }
    }
  } catch {
    // Legacy and AI-generated SMS assets may be stored as plain text.
  }
  return content;
}
