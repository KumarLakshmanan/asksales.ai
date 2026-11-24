/** Keep HTTP headers ASCII-safe while preserving international download names. */
export function contentDisposition(fileName: string, disposition: 'inline' | 'attachment' = 'inline'): string {
  const sanitizedName = Array.from(fileName, character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || /["\\/;]/.test(character) ? '_' : character;
  }).join('');
  const safeName = Array.from(sanitizedName
    .replace(/[\uD800-\uDFFF]/gu, '\uFFFD')).slice(0, 180).join('').trim() || 'download';
  const fallback = safeName.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(safeName).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
