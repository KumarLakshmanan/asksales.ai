import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function CTA() {
  return (
    <section className="bg-background py-20 sm:py-24">
      <div className="mx-auto max-w-[1320px] px-5 sm:px-10">
        <div className="grid overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="px-6 py-10 sm:px-10 sm:py-12">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-primary">Start with one campaign</p>
            <h2 className="mt-4 max-w-3xl text-2xl font-semibold tracking-tight sm:text-4xl">Put the work and its proof in the same workspace.</h2>
            <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
              Define an outcome, review the generated resources, and authorize provider work only when the campaign is ready.
            </p>
          </div>
          <div className="border-t border-border p-6 lg:border-l lg:border-t-0 lg:p-10">
            <Button asChild size="lg" className="h-11 w-full gap-2 whitespace-nowrap lg:w-auto">
              <Link href="/login?mode=register">Create a workspace <ArrowRight className="h-4 w-4" /></Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
