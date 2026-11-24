"use client";
import type { BlogEditorial } from '@/lib/blogEditorial';
import { Button } from '@/components/ui/button';
import { BlogCmsReviewHandoff } from '@/components/content-library/BlogCmsReviewHandoff';

export function BlogReviewPanel({ title, content, editorial = {}, onExport, assetId }: { title: string; content: string; editorial?: BlogEditorial; onExport: () => void; assetId?: number }) {
  const citations = [...new Set(Array.from(content.matchAll(/https:\/\/[^\s<>"\)\]]+/g), match => match[0]))];
  return <section className="mx-auto mt-4 max-w-3xl space-y-3 rounded-xl border bg-card p-5" aria-label="Blog editorial review">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Review before publication</h3><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={onExport}>Export Markdown + SEO</Button>{assetId && Number.isSafeInteger(assetId) && assetId > 0 && <BlogCmsReviewHandoff assetId={assetId} />}</div></div>
    <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Search preview</p><p className="mt-1 font-medium text-primary">{editorial.seoTitle || title}</p><p className="text-xs text-muted-foreground">/{editorial.slug || 'add-a-url-slug'}</p><p className="mt-1 text-sm">{editorial.metaDescription || 'No meta description supplied. Add one before publishing in your CMS.'}</p></div>
    <details><summary className="cursor-pointer text-sm font-medium">Sources and citations ({citations.length} links in draft)</summary>
      <p className="mt-2 text-xs text-muted-foreground">These URLs were not fetched or fact-checked. Review the linked evidence and every factual claim before publishing.</p>
      <p className="mt-2 text-xs font-medium">Source candidates</p>
      {editorial.sourceUrls?.length ? <ul className="space-y-1">{editorial.sourceUrls.map(url => <li key={url}><a className="break-all text-xs text-primary underline" href={url} target="_blank" rel="noreferrer">{url}</a></li>)}</ul> : <p className="text-xs text-muted-foreground">No source URLs supplied.</p>}
      <p className="mt-2 text-xs font-medium">Links used in the article</p>
      {citations.length ? <ul className="space-y-1">{citations.map(url => <li key={url}><a className="break-all text-xs text-primary underline" href={url} target="_blank" rel="noreferrer">{url}</a></li>)}</ul> : <p className="text-xs text-muted-foreground">No citations detected.</p>}
    </details>
    <p className="text-xs text-muted-foreground">Export this draft, or send it to a matching website’s CMS review. After exact-version approval, a connected WordPress or Shopify account can receive a draft for final review. Nothing is published automatically.</p>
  </section>;
}
