"use client";

import { getAuthHeaders } from '@/lib/authHeaders';

import { useEffect, useState } from "react";
import { Images } from "lucide-react";
import { buildApiUrl } from "@/lib/api";
import { fetchWithReadRetry } from "@/lib/api-client";

export function SupportMediaPreview({ assetId, alt }: { assetId: number; alt: string }) {
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setSrc(undefined);
    setFailed(false);
    void fetchWithReadRetry(buildApiUrl(`/api/settings/media-galleries/assets/${assetId}/content`), {
      credentials: "include", signal: controller.signal,
      headers: getAuthHeaders(),
    }).then(async (response) => {
      if (!response.ok) throw new Error("Preview unavailable");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [assetId, retry]);
  return src ? <img src={src} alt={alt} className="h-40 w-full rounded-lg object-cover" />
    : <div role="status" className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg bg-muted text-muted-foreground">
      <Images className="h-8 w-8" /><span className="text-xs">{failed ? "Preview unavailable." : "Loading preview…"}</span>
      {failed && <button type="button" className="rounded border px-3 py-1 text-xs text-foreground hover:bg-accent" onClick={() => setRetry((value) => value + 1)}>Retry preview</button>}
    </div>;
}
