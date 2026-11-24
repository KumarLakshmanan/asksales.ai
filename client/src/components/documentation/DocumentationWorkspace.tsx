'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, BookOpen } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { documentationArticles, documentationGroups, searchDocumentation, type DocumentationArticle } from '@/content/documentation';
import { DOCUMENTATION_ROOT, canOpenDocumentationDestination, type DocumentationAccess } from '@/lib/documentation-navigation';
import { useBusinessProfiles } from '@/hooks/use-business-profiles';
import { usePlatformAccess } from '@/hooks/use-platform-access';
import { SearchInput } from '@/components/ui/search-input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function ArticleDiagram({ diagram }: { diagram: NonNullable<DocumentationArticle['sections'][number]['diagram']> }) {
  const id = useId();
  return <figure className="my-6 min-w-0 rounded-xl border bg-card p-3 sm:p-5" aria-labelledby={`${id}-title`}>
    <figcaption id={`${id}-title`} className="mb-3 text-sm font-medium">{diagram.title}</figcaption>
    <div role="region" aria-label={`${diagram.title}, scroll horizontally if needed`} tabIndex={0} className="overflow-x-auto rounded-lg bg-white p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {/* Reviewed, pre-rendered Mermaid SVG. The same-origin image cannot run
          scripts in the document; no remote renderer or raw HTML is used. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/documentation/diagrams/${diagram.id}.svg`} alt={diagram.description} className="mx-auto h-auto w-full min-w-[32rem] max-w-[54rem]" loading="lazy" />
    </div>
    <p className="mt-3 text-sm leading-6 text-muted-foreground">{diagram.description}</p>
  </figure>;
}

function MarkdownBody({ children }: { children: string }) {
  return <div className="prose prose-sm max-w-none break-words text-foreground dark:prose-invert prose-headings:text-foreground prose-p:leading-7 prose-li:leading-7 prose-a:text-primary prose-a:underline prose-strong:text-foreground [&_table]:min-w-[32rem] [&_th]:text-left [&_td]:align-top">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children }) => href?.startsWith(`${DOCUMENTATION_ROOT}/`) ? <Link href={href}>{children}</Link> : <span>{children}</span>,
      table: ({ children }) => <div role="region" aria-label="Reference table, scroll horizontally if needed" tabIndex={0} className="max-w-full overflow-x-auto focus-visible:ring-2 focus-visible:ring-ring"><table>{children}</table></div>,
    }}>{children}</ReactMarkdown>
  </div>;
}

// Exported separately to exercise the real guide without mocking private APIs.
export function DocumentationContent({ slug, access }: { slug?: string; access: DocumentationAccess }) {
  const [query, setQuery] = useState('');
  const article = documentationArticles.find(item => item.slug === slug);
  const matches = searchDocumentation(query);
  const searching = query.trim().length > 0;
  const destinations = article?.destinations.filter(item => canOpenDocumentationDestination(item.href, access)) ?? [];

  return <div className="mx-auto w-full max-w-[1440px] space-y-6 p-4 sm:p-6 lg:p-8">
    <header className="space-y-4 border-b pb-6">
      <Link href={DOCUMENTATION_ROOT} className="inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-medium text-primary focus-visible:ring-2 focus-visible:ring-ring"><BookOpen className="h-4 w-4" aria-hidden="true" />AskSales Documentation</Link>
      <div><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{searching ? 'Search documentation' : article?.title ?? 'Learn your workspace'}</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{searching ? 'Search matches titles, instructions and troubleshooting across all topics.' : article?.summary ?? 'Step-by-step guides, prerequisites and diagrams for the work you do in AskSales.'}</p></div>
      <form role="search" onSubmit={event => event.preventDefault()} className="max-w-xl">
        <label htmlFor="documentation-search" className="mb-2 block text-sm font-medium">Search documentation</label>
        <SearchInput id="documentation-search" aria-label="Search documentation" value={query} onValueChange={setQuery} placeholder="Try held work, imports or manual follow-ups" className="h-11" />
      </form>
    </header>
    <div className="grid min-w-0 gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <nav aria-label="Documentation topics" className="min-w-0">
        <details className="rounded-xl border p-3 lg:hidden"><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Browse all topics</summary><TopicNavigation slug={slug} /></details>
        <div className="hidden lg:block"><TopicNavigation slug={slug} /></div>
      </nav>
      <div className="min-w-0">
        {searching ? <section aria-label="Documentation search results"><p role="status" className="mb-4 text-sm text-muted-foreground">{matches.length} matching {matches.length === 1 ? 'topic' : 'topics'}</p>{matches.length ? <ArticleCards articles={matches} onNavigate={() => setQuery('')} /> : <div className="rounded-xl border p-6"><p>No topics match “{query}”. Try a shorter phrase such as “credits” or “assistant”.</p><Button variant="outline" className="mt-4" onClick={() => setQuery('')}>Clear search</Button></div>}</section>
          : article ? <article aria-label={article.title}>
            <section aria-labelledby="prerequisites" className="mb-6 rounded-xl border bg-muted/30 p-5"><h2 id="prerequisites" className="font-semibold">Before you start</h2><ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6">{article.prerequisites.map(item => <li key={item}>{item}</li>)}</ul>{destinations.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{destinations.map(item => <Link key={item.href} href={item.href} className="inline-flex min-h-11 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">Open {item.label}<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>)}</div>}<p className="mt-3 text-xs leading-5 text-muted-foreground">Available pages and actions depend on your verified workspace role, enabled modules and configuration.</p></section>
            <nav aria-label="On this page" className="mb-8 rounded-xl border p-5"><p className="text-sm font-semibold">On this page</p><ul className="mt-2 space-y-1">{article.sections.map(section => <li key={section.id}><a href={`#${section.id}`} className="inline-flex min-h-10 items-center text-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring">{section.title}</a></li>)}</ul></nav>
            <div className="max-w-[80ch] space-y-10">{article.sections.map(section => <section key={section.id} id={section.id} className="scroll-mt-6"><h2 className="mb-4 text-xl font-semibold tracking-tight">{section.title}</h2><MarkdownBody>{section.body}</MarkdownBody>{section.diagram && <ArticleDiagram diagram={section.diagram} />}</section>)}</div>
            <footer className="mt-10 border-t pt-5 text-sm"><Link href={DOCUMENTATION_ROOT} className="inline-flex min-h-11 items-center text-primary hover:underline">All documentation topics</Link></footer>
          </article> : <><section className="mb-8 rounded-xl border border-primary/20 bg-primary/5 p-5"><h2 className="font-semibold">Start with a reviewed draft</h2><p className="mt-2 max-w-3xl text-sm leading-7 text-muted-foreground">Select the intended business, prepare your resources and review the actual outcome. Customer delivery requires a ready assigned assistant and account. Completing setup never automatically replays held work.</p><Link href={`${DOCUMENTATION_ROOT}/getting-started`} className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary">Read Getting started<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></section>{documentationGroups.map(group => <section key={group} className="mb-8" aria-label={group}><h2 className="mb-4 text-lg font-semibold">{group}</h2><ArticleCards articles={documentationArticles.filter(item => item.group === group)} /></section>)}</>}
      </div>
    </div>
  </div>;
}

function TopicNavigation({ slug }: { slug?: string }) {
  return <div className="space-y-5">{documentationGroups.map(group => <div key={group}><p className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{group}</p><ul className="mt-2">{documentationArticles.filter(item => item.group === group).map(item => <li key={item.slug}><Link href={`${DOCUMENTATION_ROOT}/${item.slug}`} aria-current={slug === item.slug ? 'page' : undefined} className={cn('block min-h-11 rounded-md px-2 py-3 text-sm leading-5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring', slug === item.slug ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground')}>{item.title}</Link></li>)}</ul></div>)}</div>;
}

function ArticleCards({ articles, onNavigate }: { articles: DocumentationArticle[]; onNavigate?: () => void }) {
  return <div className="grid gap-3 xl:grid-cols-2">{articles.map(article => <Link key={article.slug} href={`${DOCUMENTATION_ROOT}/${article.slug}`} onClick={onNavigate} className="group min-w-0 rounded-xl border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><h3 className="font-medium leading-6">{article.title}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{article.summary}</p><span className="mt-3 inline-flex items-center gap-2 text-xs font-medium text-primary">Read guide<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></span></Link>)}</div>;
}

export default function DocumentationWorkspace({ slug }: { slug?: string }) {
  const profiles = useBusinessProfiles();
  const platform = usePlatformAccess();
  const verified = !profiles.isLoading && !profiles.isError && !platform.isLoading && !platform.isError && Boolean(platform.data) && !platform.data?.maintenance.enabled && platform.data?.subscription?.allowed !== false;
  return <DocumentationContent key={slug ?? 'index'} slug={slug} access={{ verified, role: verified ? profiles.activeProfile?.role : undefined, modules: platform.data?.modules.filter(item => item.enabled).map(item => item.key) ?? [] }} />;
}
