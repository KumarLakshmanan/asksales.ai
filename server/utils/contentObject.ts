/** A stored content string as an object: its JSON object, or { content } for plain text and non-object JSON. */
export function parseContentObject(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Plain text is normalized below.
  }
  return { content };
}
