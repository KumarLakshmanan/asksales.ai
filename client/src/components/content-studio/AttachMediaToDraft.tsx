"use client";
import { useState } from "react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

type Draft = { id: number; title: string; type: string; status: string; content: string; imageUrl?: string | null; imageUrls?: string[] | null; videoUrl?: string | null; videoUrls?: string[] | null };
const editable = (draft: Draft) => ["draft", "ready"].includes(draft.status) && !["image", "video"].includes(draft.type);

export function appendDraftMedia(draft: Draft, mediaType: "image" | "video", mediaUrl: string): Partial<Pick<Draft, "content" | "imageUrl" | "imageUrls" | "videoUrl" | "videoUrls">> {
  const single = mediaType === "image" ? "imageUrl" : "videoUrl";
  const plural = mediaType === "image" ? "imageUrls" : "videoUrls";
  let content: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(draft.content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) content = parsed;
  } catch { /* Plain text drafts retain their exact text. */ }
  const contentUrls = content && Array.isArray(content[plural]) ? content[plural] as unknown[] : [];
  const urls = [...new Set([...(draft[plural] || []), draft[single], ...contentUrls, content?.[single], mediaUrl].filter((value): value is string => typeof value === "string" && Boolean(value)))];
  if (urls.length > 20) throw new Error("This draft already has 20 attachments of this type. Remove one in the library first.");
  return { [single]: draft[single] || urls[0], [plural]: urls, ...(content ? { content: JSON.stringify({ ...content, [single]: content[single] || draft[single] || urls[0], [plural]: urls }) } : {}) };
}

export function AttachMediaToDraft({ mediaUrl, mediaType }: { mediaUrl: string; mediaType: "image" | "video" }) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = async () => {
    setBusy(true); setError("");
    try {
      const assets = await api.get<Draft[]>("/api/content/assets");
      setDrafts((Array.isArray(assets) ? assets : []).filter(editable));
    } catch { setError("Drafts could not be loaded. Try again."); }
    finally { setBusy(false); }
  };
  const attach = async () => {
    if (!selected) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const draft = await api.get<Draft>(`/api/content/assets/${selected}`);
      if (!editable(draft)) throw new Error("This draft is no longer editable. Choose another draft.");
      await api.put(`/api/content/assets/${selected}`, appendDraftMedia(draft, mediaType, mediaUrl));
      setMessage(`Attached to “${draft.title}”. Review the draft before publishing.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Attachment failed. Please retry."); }
    finally { setBusy(false); }
  };
  return <section className="mx-auto max-w-[760px] space-y-3 rounded-xl border border-border bg-card p-4" aria-label="Attach media to a draft">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">Use this {mediaType}</p><Button variant="outline" size="sm" disabled={busy} onClick={load}>{drafts ? "Refresh drafts" : "Choose a content draft"}</Button></div>
    {drafts && <><Label htmlFor={`attach-${mediaType}`}>Content draft</Label><select id={`attach-${mediaType}`} value={selected} onChange={(event) => { setSelected(event.target.value); setMessage(""); }} className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"><option value="">{drafts.length ? "Select a draft" : "No editable content drafts"}</option>{drafts.map((draft) => <option key={draft.id} value={draft.id}>{draft.title} · {draft.type.replaceAll("_", " ")}</option>)}</select><Button size="sm" disabled={busy || !selected} onClick={attach}>{busy ? "Working…" : "Attach to draft"}</Button></>}
    <p className="text-xs text-muted-foreground">Adds media without replacing existing attachments. Nothing is published or sent.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
  </section>;
}
