import { Edit3, Send, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DraftRecommendationCardProps {
  channel: string;
  subject?: string | null;
  children: React.ReactNode;
  timestamp?: string;
  onEdit?: () => void;
  onSend?: () => void;
  onDiscard?: () => void;
  className?: string;
}
export function DraftRecommendationCard({
  channel,
  subject,
  children,
  timestamp,
  onEdit,
  onSend,
  onDiscard,
  className,
}: DraftRecommendationCardProps) {
  return (
    <section className={cn("ml-auto max-w-[min(100%,42rem)] overflow-hidden rounded-2xl border border-warning/35 bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04)]", className)} aria-label={`AI draft for ${channel}`}>
      <header className="flex items-center gap-2 border-b border-border/60 bg-warning/5 px-3.5 py-2.5">
        <Sparkles className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
        <span className="text-xs font-semibold text-foreground">Drafted</span>
        <span className="text-[11px] text-muted-foreground">Review before sending</span>
        <span className="ml-auto rounded-md border border-border/60 bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{channel}</span>
      </header>
      <div className="px-4 py-3">
        {subject ? <p className="mb-2 border-b border-border/50 pb-2 text-xs font-semibold text-foreground">Subject: {subject}</p> : null}
        <div className="text-sm leading-relaxed text-foreground">{children}</div>
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-muted/20 px-3 py-2">
        {onEdit ? <Button type="button" variant="outline" size="sm" onClick={onEdit} className="h-8 rounded-lg text-xs"><Edit3 className="mr-1.5 h-3.5 w-3.5" />Edit</Button> : null}
        {onSend ? <Button type="button" size="sm" onClick={onSend} className="h-8 rounded-lg text-xs"><Send className="mr-1.5 h-3.5 w-3.5" />Send</Button> : null}
        {onDiscard ? <Button type="button" variant="ghost" size="sm" onClick={onDiscard} className="h-8 rounded-lg text-xs text-muted-foreground"><Trash2 className="mr-1.5 h-3.5 w-3.5" />Discard</Button> : null}
        {timestamp ? <time className="ml-auto text-[10px] tabular-nums text-muted-foreground">{timestamp}</time> : null}
      </footer>
    </section>
  );
}
