import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface PrivacyAccessRecord {
  id: number;
  actor: string;
  action: string;
  reason: string | null;
  created_at: string;
}

export function PrivacyAccessHistory({ entries }: { entries?: PrivacyAccessRecord[] }) {
  return <Card className="shadow-none"><CardHeader><CardTitle className="text-sm">Restricted-content access history</CardTitle></CardHeader><CardContent className="max-h-72 space-y-3 overflow-y-auto">
    {entries?.length ? entries.map((entry) => <div key={entry.id} className="space-y-1 rounded-md border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2"><span className="break-all font-medium">{entry.actor}</span><span className="text-muted-foreground">{entry.action.replaceAll("_", " ")}</span><time className="text-muted-foreground sm:ml-auto" dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString()}</time></div>
      <p className="break-words text-muted-foreground">Reason: {entry.reason || "No reason recorded"}</p>
    </div>) : <p className="text-sm text-muted-foreground">{entries ? "No restricted-content access recorded in this period." : "Access history is currently unavailable."}</p>}
  </CardContent></Card>;
}
