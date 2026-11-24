import type { ReactNode } from "react";
import { Shield } from "lucide-react";

import { ThemeToggle } from "@/components/ThemeToggle";
import { BRAND_NAME } from "@/lib/brand";

interface AdminAuthShellProps {
  children: ReactNode;
  title: string;
  description?: string;
  eyebrow?: string;
  highlights?: string[];
}

export function AdminAuthShell({
  children,
  title,
  description,
  eyebrow = "Operations workspace",
  highlights = [],
}: AdminAuthShellProps) {
  return (
    <main id="main-content" tabIndex={-1} className="grid min-h-dvh w-full bg-background text-foreground lg:grid-cols-[minmax(0,1.1fr)_minmax(480px,.9fr)]">
      <aside className="relative hidden min-h-dvh overflow-hidden border-r border-border bg-primary px-10 text-primary-foreground lg:flex lg:items-center xl:px-16">
        <div className="absolute left-10 top-10 flex items-center gap-3 text-sm font-medium xl:left-16 xl:top-12">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-foreground/15">
            <Shield className="h-4 w-4" aria-hidden="true" />
          </span>
          {BRAND_NAME} administration
        </div>

        <div className="mx-auto w-full max-w-xl py-32">
          <p className="mb-3 text-sm font-medium text-primary-foreground/75">{eyebrow}</p>
          <h1 className="text-4xl font-semibold tracking-tight xl:text-5xl">{title}</h1>
          {description && <p className="mt-5 max-w-lg text-base leading-7 text-primary-foreground/80">{description}</p>}
          {highlights.length > 0 && (
            <ul className="mt-8 grid gap-3 text-sm text-primary-foreground/85" aria-label="Security steps">
              {highlights.map((highlight, index) => (
                <li key={highlight} className="flex items-center gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-foreground/15 text-xs font-semibold">
                    {index + 1}
                  </span>
                  {highlight}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section className="relative flex min-h-dvh flex-col justify-center bg-background px-5 py-20 sm:px-10 lg:px-14 lg:py-12 xl:px-16">
        <ThemeToggle className="absolute right-5 top-5 sm:right-8 sm:top-8" />
        <div className="mx-auto w-full max-w-md">
          <div className="mb-10 flex items-center gap-2 lg:hidden">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <Shield className="h-4 w-4 text-primary-foreground" aria-hidden="true" />
            </span>
            <span className="text-lg font-semibold">Admin panel</span>
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
