/** Escape the five HTML-significant characters (& < > " ') for text and attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] || character);
}

/** escapeHtml for any value: null and undefined become '', everything else goes through String(). */
export function escapeHtmlValue(value: unknown): string {
  return escapeHtml(String(value ?? ''));
}
