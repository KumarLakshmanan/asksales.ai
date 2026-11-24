import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface InsightMetricCardProps {
  label: string;
  value: ReactNode;
  detail: ReactNode;
  icon?: ReactNode;
  tone?: "neutral" | "primary" | "success" | "warning";
}

const toneClasses = {
  neutral: "border-border/70 bg-card",
  primary: "border-primary/20 bg-primary/[0.04]",
  success: "border-success/20 bg-success/[0.04]",
  warning: "border-warning/20 bg-warning/[0.04]",
};

export function InsightMetricCard({ label, value, detail, icon, tone = "neutral" }: InsightMetricCardProps) {
  return (
    <article className={cn("rounded-2xl border p-4 shadow-[0_1px_2px_rgb(0_0_0/0.03)]", toneClasses[tone])}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {icon ? <span className="text-muted-foreground" aria-hidden="true">{icon}</span> : null}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </article>
  );
}
