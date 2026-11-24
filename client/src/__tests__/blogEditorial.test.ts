import { expect, it } from 'vitest';
import { blogMarkdownExport, parseBlogLinks } from '@/lib/blogEditorial';

it('validates and deduplicates review candidate URLs', () => {
  expect(parseBlogLinks('https://example.com/source\nhttps://example.com/source')).toEqual(['https://example.com/source']);
  expect(() => parseBlogLinks('javascript:alert(1)')).toThrow();
  expect(() => parseBlogLinks('https://user:secret@example.com')).toThrow();
  expect(() => parseBlogLinks('not a url')).toThrow();
});
it('exports escaped SEO metadata without duplicating a Markdown heading', () => {
  const result = blogMarkdownExport({ title: 'Hello', content: '# Hello\nBody', editorial: { seoTitle: 'Title: "quote"', slug: 'hello', sourceUrls: ['https://example.com/research'] } });
  expect(result).toContain('title: "Title: \\"quote\\""');
  expect(result.match(/# Hello/g)).toHaveLength(1);
  expect(result).toContain('verify claims before publication');
});
