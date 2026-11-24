import type { ReactNode } from "react";
import Link from "next/link";
import { Check, Sparkles, type LucideIcon } from "lucide-react";
import { BRAND_NAME } from "@/lib/brand";

interface SplitAuthShellProps {
  children: ReactNode;
  eyebrow: string;
  title: string;
  description: string;
  highlights: string[];
  icon?: LucideIcon;
  brandLabel?: string;
  formWidth?: "sm" | "md";
}

export function SplitAuthShell({
  children,
  eyebrow,
  title,
  description,
  highlights,
  icon: Icon = Sparkles,
  brandLabel = BRAND_NAME,
  formWidth = "sm",
}: SplitAuthShellProps) {
  return (
    <main id="main-content" tabIndex={-1} className="grid min-h-dvh bg-background lg:grid-cols-[minmax(0,1.1fr)_minmax(480px,.9fr)]">
      <aside className="relative hidden min-h-dvh overflow-hidden border-r border-border bg-card lg:flex lg:items-center">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border)/0.2)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border)/0.2)_1px,transparent_1px)] bg-[size:48px_48px]" />
        <div className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-primary" />

        <Link href="/" className="absolute left-10 top-10 z-10 flex items-center gap-3 xl:left-16 xl:top-12">
          <span className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-border bg-background shadow-sm">
            <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
          </span>
          <span className="text-lg font-semibold tracking-tight">{brandLabel}</span>
        </Link>

        <div className="relative mx-auto w-full max-w-2xl px-10 py-32 xl:px-16">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p>
          <h1 className="mt-4 max-w-xl text-3xl font-semibold leading-[1.12] tracking-[-0.035em] xl:text-4xl">
            {title}
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground">{description}</p>

          <ol className="relative mt-10 max-w-xl border-y border-border" aria-label="What happens next">
            {highlights.map((highlight, index) => (
              <li key={highlight} className="relative flex items-center gap-4 border-b border-border py-4 last:border-b-0">
                <span className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10">
                  <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                </span>
                <span className="text-sm">{highlight}</span>
              </li>
            ))}
          </ol>
        </div>
      </aside>

      <section className="flex min-h-dvh items-center px-5 py-10 sm:px-10 lg:px-14 xl:px-16">
        <div className={`mx-auto w-full ${formWidth === "md" ? "max-w-md" : "max-w-sm"}`}>
          <Link href="/" className="mb-10 flex items-center gap-3 lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-[9px] border border-border bg-card">
              <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
            </span>
            <span className="font-semibold">{brandLabel}</span>
          </Link>
          {children}
        </div>
      </section>
    </main>
  );
}
