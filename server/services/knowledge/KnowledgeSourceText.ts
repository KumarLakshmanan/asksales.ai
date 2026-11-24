import type { KnowledgeBaseEntry } from '../../models/knowledgeBase/schema.js';

/** Extract source material, not the crawler's bounded prompt preview. The caller
 * must still scan, redact, index and review this text before publication. */
export function knowledgeSourceText(entry: Pick<KnowledgeBaseEntry, 'type' | 'content' | 'question' | 'answer'>): string {
  if (entry.type === 'qa') return `Q: ${entry.question || ''}\nA: ${entry.answer || ''}`.trim();
  if (!entry.content) return '';
  if (entry.type !== 'file' && entry.type !== 'url') return entry.content;
  try {
    const parsed: unknown = JSON.parse(entry.content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return entry.content;
    const source = parsed as { extractedText?: unknown; chunks?: unknown };
    const chunks = Array.isArray(source.chunks) ? source.chunks : [];
    // URL ingestion stores complete per-page text in chunks, but caps the
    // combined extractedText for prompt use. Indexing only the latter silently
    // loses footers, addresses and later pages. Ignore non-page metadata chunks.
    if (entry.type === 'url') {
      const pages = chunks.filter((chunk): chunk is { text: string; pageUrl: string } =>
        Boolean(chunk && typeof chunk === 'object' && !Array.isArray(chunk)
          && typeof chunk.text === 'string' && chunk.text.trim()
          && typeof chunk.pageUrl === 'string' && chunk.pageUrl.trim()));
      if (pages.length) return pages.map(page => page.text).join('\n\n');
    }
    if (typeof source.extractedText === 'string' && source.extractedText.trim()) return source.extractedText;
    const textChunks = chunks.flatMap(chunk => chunk && typeof chunk === 'object'
      && typeof chunk.text === 'string' ? [chunk.text] : []);
    return textChunks.length ? textChunks.join('\n\n') : '';
  } catch {
    return entry.content;
  }
}
