"use client";
import { useEffect, useState } from "react";
import api from "@/lib/api";
import { downloadContentMedia } from "@/lib/contentMediaTools";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export function isWebVtt(value: string) {
  return /^WEBVTT(?:\s|$)/.test(value.trim()) && /\d{2}:\d{2}(?::\d{2})?\.\d{3}\s+-->\s+\d{2}:\d{2}(?::\d{2})?\.\d{3}/.test(value);
}

export function VideoCaptionTools({ video }: { video: { id: string; title: string; videoUrl: string } }) {
  const [captions, setCaptions] = useState("");
  const [captionUrl, setCaptionUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const assetId = video.id.startsWith("db-") ? Number(video.id.slice(3)) : null;
  useEffect(() => {
    let active = true;
    if (assetId) void api.get<{ metadata?: { captionsVtt?: string } }>(`/api/content/assets/${assetId}`).then((asset) => {
      if (active) setCaptions(asset.metadata?.captionsVtt || "");
    }).catch(() => { if (active) setError("Saved captions could not be loaded. Reopen this video to try again."); });
    return () => { active = false; };
  }, [assetId]);
  useEffect(() => {
    if (!isWebVtt(captions)) { setCaptionUrl(null); return; }
    const url = URL.createObjectURL(new Blob([captions], { type: "text/vtt" }));
    setCaptionUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [captions]);
  const save = async () => {
    if (!assetId || !isWebVtt(captions)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const asset = await api.get<{ metadata?: Record<string, unknown> }>(`/api/content/assets/${assetId}`);
      await api.put(`/api/content/assets/${assetId}`, { metadata: { ...asset.metadata, captionsVtt: captions } });
      setMessage("Caption track saved with this draft. Download the VTT file separately when publishing.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Captions could not be saved."); }
    finally { setBusy(false); }
  };
  return <section className="mx-auto max-w-[760px] space-y-3 rounded-xl border border-border bg-card p-4" aria-label="Video captions">
    <Label htmlFor={`captions-${video.id}`}>Captions (WebVTT)</Label>
    <p className="text-xs text-muted-foreground">Add a reviewed caption track. Captions are saved separately, not burned into the video. Automatic transcription is not run.</p>
    <Textarea id={`captions-${video.id}`} rows={5} maxLength={50000} placeholder={"WEBVTT\n\n00:00.000 --> 00:04.000\nYour caption here"} value={captions} onChange={(event) => setCaptions(event.target.value)} />
    {captions.trim() && !isWebVtt(captions) && <p className="text-xs text-destructive">Start with WEBVTT and include a timing line, for example 00:00.000 --&gt; 00:04.000.</p>}
    {captionUrl && <video key={captionUrl} controls preload="metadata" src={video.videoUrl} className="max-h-80 w-full rounded-lg" aria-label="Preview video with captions"><track kind="captions" src={captionUrl} label="Reviewed captions" default /></video>}
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!assetId || busy || !captionUrl} onClick={save}>{busy ? "Saving…" : "Save captions"}</Button><Button size="sm" variant="outline" disabled={!captionUrl} onClick={() => { if (captionUrl) void downloadContentMedia(captionUrl, `${video.title}-captions`, "vtt").catch(() => setError("Caption download failed. Please retry.")); }}>Download VTT</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
  </section>;
}
