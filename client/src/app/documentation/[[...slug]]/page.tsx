import Link from 'next/link';
import PublicLayout from '@/components/PublicLayout';
import { DocumentationContent } from '@/components/documentation/DocumentationWorkspace';
import { documentationArticles } from '@/content/documentation';

export const metadata = { title: 'Documentation', description: 'Guides and reference for using AskSales.' };

export default async function DocumentationPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const invalid = slug && (slug.length !== 1 || !documentationArticles.some(article => article.slug === slug[0]));
  return <PublicLayout><div className="pt-24 sm:pt-28">
    {invalid ? <section className="mx-auto max-w-3xl space-y-4 p-6 sm:p-8">
      <h1 className="text-2xl font-semibold">Documentation topic not found</h1>
      <p className="text-sm leading-6 text-muted-foreground">This help link may be outdated. Browse or search the documentation to find the current guide.</p>
      <Link href="/documentation" className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium text-primary hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">Browse documentation</Link>
    </section> : <DocumentationContent key={slug?.[0] ?? 'index'} slug={slug?.[0]} access={{ verified: false, modules: [] }} />}
  </div></PublicLayout>;
}
