import type { ReactNode } from "react";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

interface RecommendationCardProps {
  title: string;
  description: string;
  evidence?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}

export function RecommendationCard({ title, description, evidence, actionLabel, onAction }: RecommendationCardProps) {
  return (
    <aside className="flex flex-col gap-3 rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/[0.06] via-card to-card p-4 sm:flex-row sm:items-center" aria-label="Campaign recommendation">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Sparkles className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Recommended next move</p>
        <h2 className="mt-0.5 text-sm font-semibold text-foreground">{title}</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        {evidence ? <div className="mt-2 text-[11px] text-muted-foreground">{evidence}</div> : null}
      </div>
      {actionLabel && onAction ? (
        <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1.5 rounded-lg" onClick={onAction}>
          {actionLabel}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      ) : null}
    </aside>
  );
}
