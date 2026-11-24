import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BRAND_NAME } from "@/lib/brand";

export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="flex h-16 items-center justify-between border-b border-border px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5"><img src="/logos/asksales_logo.svg" alt="" className="h-8 w-8" /><span className="font-semibold">{BRAND_NAME}</span></Link>
        <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground">Sign in</Link>
      </header>
      <section className="grid flex-1 items-center px-5 py-16 sm:px-8">
        <div className="mx-auto grid w-full max-w-5xl gap-10 border-y border-border py-12 lg:grid-cols-[.55fr_1.45fr] lg:items-end">
          <p className="font-mono text-5xl font-semibold tracking-[-0.05em] text-muted-foreground sm:text-6xl">404</p>
          <div><p className="font-mono text-[11px] uppercase tracking-[0.14em] text-primary">Route unavailable</p><h1 className="mt-4 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">This page does not exist.</h1><p className="mt-4 max-w-xl leading-7 text-muted-foreground">The address may be outdated, or the resource may have moved to another workspace route.</p><div className="mt-7 flex flex-wrap gap-3"><Link href="/" className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground"><ArrowLeft className="h-4 w-4" />Back to home</Link><Link href="/agents" className="inline-flex h-11 items-center rounded-md border border-border px-5 text-sm font-medium hover:bg-muted">Agent directory</Link></div></div>
        </div>
      </section>
    </main>
  );
}
