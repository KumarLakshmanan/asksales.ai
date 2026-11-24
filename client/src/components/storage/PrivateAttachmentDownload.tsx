"use client";

import { useEffect, useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { downloadStorageFiles } from "@/lib/storage-workspace";
import { subscribeBusinessProfile } from "@/lib/business-profile";
import { formatAttachmentSize, type ConversationAttachment } from "@/lib/conversation-attachments";

/** Private files need an authenticated, business-scoped ticket before native
 * navigation. A cookie-only file URL cannot carry the selected business. */
export function PrivateAttachmentDownload({ attachment }: { attachment: ConversationAttachment }) {
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeBusinessProfile(() => {
      pending.current?.abort();
      pending.current = null;
      setBusy(false);
      setError(null);
    });
    return () => {
      pending.current?.abort();
      pending.current = null;
      unsubscribe();
    };
  }, [attachment.fileId]);

  async function download() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      await downloadStorageFiles([Number(attachment.fileId)], controller.signal);
    } catch {
      if (!controller.signal.aborted)
        setError("This attachment could not be downloaded. Try again.");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  return <div>
    <button type="button" onClick={() => void download()} disabled={busy}
      aria-label={`Download ${attachment.name}`} aria-busy={busy}
      className="flex w-full max-w-full items-center gap-2 rounded-md bg-white/10 px-2.5 py-1.5 text-left text-xs text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-wait disabled:opacity-70">
      {busy ? <Spinner size="xs" label={null} className="shrink-0" /> : <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      <span className="truncate">{attachment.name}</span>
      <span className="ml-auto shrink-0 text-white/70">{formatAttachmentSize(Number(attachment.size))}</span>
    </button>
    {error ? <p role="alert" className="mt-1 text-xs text-white">{error}</p> : null}
  </div>;
}
