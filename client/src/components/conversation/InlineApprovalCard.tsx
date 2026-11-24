"use client";

import { useState } from "react";
import { Check, CircleHelp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ApprovalOption {
  id: string;
  label: string;
  description?: string;
  tone?: "primary" | "secondary" | "danger";
}
interface InlineApprovalCardProps {
  title: string;
  description?: string;
  options: ApprovalOption[];
  onSelect: (optionId: string) => void;
  busy?: boolean;
  className?: string;
}

export function InlineApprovalCard({ title, description, options, onSelect, busy = false, className }: InlineApprovalCardProps) {
  const [selected, setSelected] = useState<string | null>(null);

  const choose = (option: ApprovalOption) => {
    if (busy) return;
    setSelected(option.id);
    onSelect(option.id);
  };

  return (
    <section className={cn("ml-0 max-w-[44rem] rounded-2xl border border-warning/35 bg-warning/5 p-4 sm:ml-12", className)} aria-label="Approval required">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warning/30 bg-background">
          <CircleHelp className="h-4 w-4 text-warning" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {description ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {options.map((option) => (
              <Button
                key={option.id}
                type="button"
                variant={option.tone === "primary" ? "default" : option.tone === "danger" ? "destructive" : "outline"}
                size="sm"
                disabled={busy}
                onClick={() => choose(option)}
                aria-pressed={selected === option.id}
                className="h-auto min-h-9 rounded-lg px-3 py-2 text-left"
              >
                {option.tone === "primary" ? <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> : option.tone === "danger" ? <X className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> : null}
                <span>
                  <span className="block text-xs font-medium">{option.label}</span>
                  {option.description ? <span className="mt-0.5 block text-[10px] font-normal opacity-75">{option.description}</span> : null}
                </span>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
