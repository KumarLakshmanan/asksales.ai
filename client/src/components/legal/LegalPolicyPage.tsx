"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { FileText } from "lucide-react";
import PublicLayout from "@/components/PublicLayout";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { getLegalPolicyFallback } from "@/lib/legal-policy-content";

interface PolicyPage {
  id: number;
  slug: string;
  title: string;
  contentMarkdown: string;
  updatedAt: string;
}

interface LegalPolicyPageProps {
  slug: string;
  fallbackTitle?: string;
}

const POLICY_LINKS = [
  { href: "/privacy", slug: "privacy-policy", label: "Privacy policy" },
  { href: "/terms", slug: "terms-of-use", label: "Terms of use" },
  { href: "/refund-policy", slug: "refund-policy", label: "Refund policy" },
  { href: "/cancellation-policy", slug: "cancellation-policy", label: "Cancellation policy" },
];

function slugifyHeading(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

function extractSections(markdown: string) {
  return [...markdown.matchAll(/^##\s+(.+)$/gm)].map((match) => ({
    title: match[1].trim(),
    id: slugifyHeading(match[1]),
  }));
}

function PolicyLoadingSkeleton() {
  return (
    <div className="grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-14">
      <aside className="space-y-5 border-b border-border pb-8 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-8">
        <div>
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-3 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-4/5" />
        </div>
        <div className="space-y-3 border-t border-border pt-5">
          {Array.from({ length: 7 }).map((_, index) => (
            <Skeleton key={index} className={`h-3 ${index % 3 === 0 ? "w-3/4" : "w-full"}`} />
          ))}
        </div>
      </aside>
      <div className="space-y-7">
        {Array.from({ length: 5 }).map((_, index) => (
          <section key={index} className="space-y-3">
            <Skeleton className="h-7 w-2/5" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </section>
        ))}
      </div>
    </div>
  );
}

export default function LegalPolicyPage({ slug, fallbackTitle = "Policy" }: LegalPolicyPageProps) {
  const fallback = useMemo(() => getLegalPolicyFallback(slug, fallbackTitle), [fallbackTitle, slug]);
  const [policy, setPolicy] = useState<PolicyPage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function loadPolicy() {
      setLoading(true);
      try {
        const data = await api.get<PolicyPage>(`/api/legal/policies/${encodeURIComponent(slug)}`, { skipAuth: true });
        if (!mounted) return;
        const publishedContent = data?.contentMarkdown?.trim() || "";
        if (publishedContent.length >= 1000 && extractSections(publishedContent).length >= 5) {
          setPolicy(data);
        } else {
          setPolicy(null);
        }
      } catch {
        if (mounted) {
          setPolicy(null);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void loadPolicy();
    return () => { mounted = false; };
  }, [slug]);

  const title = policy?.title || fallback.title;
  const contentMarkdown = policy?.contentMarkdown || fallback.contentMarkdown;
  const sections = useMemo(() => extractSections(contentMarkdown), [contentMarkdown]);
  const lastUpdated = useMemo(() => {
    const value = policy?.updatedAt || fallback.updatedAt;
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(date);
  }, [fallback.updatedAt, policy?.updatedAt]);

  return (
    <PublicLayout>
      <section className="border-b border-border pb-12 pt-28 sm:pt-32">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-primary">
            <FileText className="h-4 w-4" aria-hidden="true" /> Legal library
          </div>
          <h1 className="mt-5 max-w-3xl text-3xl font-semibold tracking-[-0.035em] sm:text-5xl">{title}</h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-muted-foreground sm:text-lg">{fallback.summary}</p>
          <p className="mt-5 font-mono text-xs text-muted-foreground">Last updated {lastUpdated}</p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
        {loading ? (
          <PolicyLoadingSkeleton />
        ) : (
          <div className="grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-14">
            <aside className="border-b border-border pb-8 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-8">
              <div className="sticky top-28">
                <p className="text-sm font-semibold">Policy library</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Move between policies or jump directly to a section.</p>
                <nav className="mt-5 space-y-1" aria-label="Policy pages">
                  {POLICY_LINKS.map((item) => (
                    <Link
                      key={item.slug}
                      href={item.href}
                      aria-current={item.slug === slug ? "page" : undefined}
                      className={`block border-l-2 py-1.5 pl-3 text-sm transition-colors ${item.slug === slug ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"}`}
                    >
                      {item.label}
                    </Link>
                  ))}
                </nav>

                <div className="mt-7 border-t border-border pt-5">
                  <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">On this page</p>
                  <nav className="mt-3 max-h-[45vh] space-y-1 overflow-y-auto pr-2" aria-label="Policy sections">
                    {sections.map((section) => (
                      <a key={section.id} href={`#${section.id}`} className="block rounded-sm py-1 text-sm leading-5 text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        {section.title}
                      </a>
                    ))}
                  </nav>
                </div>
              </div>
            </aside>

            <div className="min-w-0">
              <article className="prose prose-slate max-w-none prose-headings:tracking-tight prose-h2:scroll-mt-32 prose-h2:border-t prose-h2:border-border prose-h2:pt-9 prose-h2:text-2xl prose-p:leading-8 prose-p:text-muted-foreground prose-li:text-muted-foreground dark:prose-invert">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks]}
                  components={{
                    h2: ({ children, ...props }) => <h2 id={slugifyHeading(String(children))} {...props}>{children}</h2>,
                  }}
                >
                  {contentMarkdown}
                </ReactMarkdown>
              </article>
            </div>
          </div>
        )}
      </section>
    </PublicLayout>
  );
}
