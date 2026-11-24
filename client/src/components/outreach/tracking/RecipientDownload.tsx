"use client";

import { useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { buildApiUrl } from "@/lib/api";
import { getAuthHeaders } from "@/lib/authHeaders";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { RecipientFilter } from "../../../../../shared/outreachTracking";
import { viewerTimezone } from "./DayByDayCard";
import { fetchWithReadRetry } from "@/lib/api-client";

type MessageKind = "outreach" | "follow_up";
type Choice = { status: RecipientFilter; kind: MessageKind; label: string };

const firstMessageChoices: Choice[] = [
  { status: "all", kind: "outreach", label: "All recipients" },
  { status: "failed", kind: "outreach", label: "Only failed" },
  { status: "waiting", kind: "outreach", label: "Only waiting" },
];
const followUpChoices: Choice[] = [
  { status: "all", kind: "follow_up", label: "All follow-ups" },
  { status: "failed", kind: "follow_up", label: "Only failed follow-ups" },
];

type SaveHandle = { createWritable: () => Promise<WritableStream<Uint8Array>> };
type SavePicker = (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<SaveHandle>;

/**
 * Downloads the recipient list as a spreadsheet file. The request carries the
 * sign-in and business headers, which a plain link could not, and the server
 * streams the rows so a very large outreach still downloads.
 *
 * Where the browser can save straight to a file, rows are written to disk as
 * they arrive, so a list of hundreds of thousands never sits in memory.
 * Elsewhere the file is assembled in memory and then saved.
 */
export async function downloadRecipients(batchId: string, status: RecipientFilter, fallbackName: string, kind: MessageKind = "outreach") {
  const suggestedName = `${fallbackName}${kind === "follow_up" ? "-follow-ups" : ""}${status === "all" ? "" : `-${status}`}.csv`;
  const picker = typeof window !== "undefined" ? (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker : undefined;
  // The picker must open straight from the click, before any waiting, or the browser refuses it.
  let handle: SaveHandle | null = null;
  if (picker) {
    try { handle = await picker({ suggestedName, types: [{ description: "CSV file", accept: { "text/csv": [".csv"] } }] }); }
    catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return false;
      handle = null;
    }
  }
  const query = new URLSearchParams({ status, kind, tz: viewerTimezone() });
  const response = await fetchWithReadRetry(buildApiUrl(`/api/outreach/batches/${batchId}/export.csv?${query}`), { credentials: "include", headers: getAuthHeaders() });
  if (!response.ok) throw new Error("The download could not be prepared. Try again.");
  if (handle && response.body) {
    await response.body.pipeTo(await handle.createWritable());
    return true;
  }
  const blob = await response.blob();
  const named = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") || "")?.[1];
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = named || suggestedName;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

export function RecipientDownload({ batchId, hasFollowUps = false }: { batchId: string; hasFollowUps?: boolean }) {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);
  const choices = hasFollowUps ? [...firstMessageChoices, ...followUpChoices] : firstMessageChoices;
  const start = async (choice: Choice) => {
    setDownloading(true);
    try { await downloadRecipients(batchId, choice.status, "outreach-recipients", choice.kind); }
    catch (reason) { toast({ title: "Download failed", description: reason instanceof Error ? reason.message : "Try again.", variant: "destructive" }); }
    finally { setDownloading(false); }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" loading={downloading} loadingText="Preparing download…">
          <Download aria-hidden="true" />Download CSV<ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {choices.map(choice => (
          <DropdownMenuItem key={`${choice.kind}:${choice.status}`} onSelect={() => void start(choice)}>{choice.label}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
