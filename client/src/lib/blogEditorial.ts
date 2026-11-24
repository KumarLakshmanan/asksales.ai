export interface BlogEditorial {
  outline?: string;
  outlineApproved?: boolean;
  seoTitle?: string;
  metaDescription?: string;
  slug?: string;
  focusKeyword?: string;
  sourceUrls?: string[];
  internalLinks?: string[];
}

export function parseBlogLinks(value: string): string[] {
  const links = [...new Set(value.split(/\n/).map(line => line.trim()).filter(Boolean))];
  if (links.length > 10) throw new Error('Use up to 10 URLs per list.');
  for (const link of links) {
    let url: URL;
    try { url = new URL(link); } catch { throw new Error(`Enter a complete HTTPS URL: ${link}`); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use HTTPS URLs without credentials.');
  }
  return links;
}

export function blogMarkdownExport(post: { title: string; content: string; editorial?: BlogEditorial; imageUrls?: string[] }) {
  const { editorial = {} } = post;
  const metadata = { title: editorial.seoTitle || post.title, description: editorial.metaDescription || '', slug: editorial.slug || '', focus_keyword: editorial.focusKeyword || '', featured_image: post.imageUrls?.[0] || '' };
  const frontMatter = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  const body = /^#\s/.test(post.content.trimStart()) ? post.content : `# ${post.title}\n\n${post.content}`;
  const sources = editorial.sourceUrls?.length ? `\n\n<!-- Source review candidates (verify claims before publication):\n${editorial.sourceUrls.join('\n')}\n-->` : '';
  return `---\n${frontMatter}\n---\n\n${body}${sources}`;
}
