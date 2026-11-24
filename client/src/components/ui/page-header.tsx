import * as React from "react";
import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  icon: LucideIcon;
  iconClassName?: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
  eyebrow?: string;
}

function PageHeader({
  icon: Icon,
  iconClassName,
  title,
  subtitle,
  actions,
  className,
  eyebrow,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4",
        className
      )}
    >
      <div className="flex min-w-0 flex-[1_1_22rem] items-start gap-3 border-l-2 border-primary pl-3.5">
        <Icon className={cn("mt-1 h-4 w-4 shrink-0 text-primary", iconClassName)} />
        <div className="min-w-0">
          {eyebrow && <p className="mb-2 text-xs font-medium text-muted-foreground">{eyebrow}</p>}
          <h1 className="break-words text-xl font-semibold tracking-[-0.025em] sm:text-2xl">{title}</h1>
          {subtitle && (
            <p className="mt-1.5 max-w-[65ch] break-words text-sm leading-5 text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {/* Wrap the whole action group before compressing the title. The available
          content width can be much smaller than the viewport beside a sidebar. */}
      {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 pt-0.5 [&>*]:max-w-full">{actions}</div>}
    </div>
  );
}

export { PageHeader };
export type { PageHeaderProps };
