/** Read legacy structured or nested blog responses without dropping sections. */
export function extractBlogBody(value: string): string {
  let content = value;
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed === 'string') { content = parsed; continue; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) break;
      const record = parsed as Record<string, unknown>;
      const main = typeof record.body === 'string' ? record.body : typeof record.content === 'string' ? record.content : '';
      if (main && main !== content) { content = main; continue; }
      const parts: string[] = [];
      if (typeof record.introduction === 'string') parts.push(record.introduction);
      if (Array.isArray(record.sections)) for (const section of record.sections) {
        if (!section || typeof section !== 'object') continue;
        const { heading, content: body } = section as Record<string, unknown>;
        parts.push([typeof heading === 'string' && heading ? `## ${heading}` : '', typeof body === 'string' ? body : ''].filter(Boolean).join('\n\n'));
      }
      if (typeof record.conclusion === 'string') parts.push(`## Conclusion\n\n${record.conclusion}`);
      if (parts.length) return parts.filter(Boolean).join('\n\n');
      break;
    } catch { break; }
  }
  return content;
}
