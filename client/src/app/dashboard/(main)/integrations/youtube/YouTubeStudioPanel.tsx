"use client";

import { getAuthHeaders } from '@/lib/authHeaders';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { buildApiUrl, getCsrfToken } from "@/lib/api-client";

type Account = { id: number; accountIdentifier: string; accountName: string; isSelected: boolean };
type Readiness = { ready: boolean; code?: string; channelId?: string | null; missingCapabilities?: string[]; quotaForecast?: Record<string, number | null> };
type Playlist = { id: string; title: string; itemCount: number };
type Caption = { id: string; language?: string; name?: string; status?: string };
type Comment = { id?: string; topLevelCommentId?: string; author?: string; text?: string; moderationStatus?: string; replies?: Array<{ id?: string; author?: string; text?: string }> };

import { creatorSessionScope } from '@/lib/creator-session';
import { clearYouTubeCommentDraft, loadYouTubeCommentDrafts, retainYouTubeCommentDraft } from '@/lib/youtubeCommentRecovery';
import { acknowledgedYouTubeOffset, clearYouTubeUploadCheckpoint, loadYouTubeUploadCheckpoint, matchesYouTubeUploadFile, saveYouTubeUploadCheckpoint, type YouTubeUploadCheckpoint } from '@/lib/youtubeUploadRecovery';

const CHUNK_BYTES = 8 * 1024 * 1024;

function parseChapters(value: string) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^(\d+):([0-5]\d)(?::([0-5]\d))?\s+(.+)$/.exec(line);
    if (!match) throw new Error(`Invalid chapter line: ${line}`);
    const hours = match[3] ? Number(match[1]) : 0;
    const minutes = match[3] ? Number(match[2]) : Number(match[1]);
    const seconds = Number(match[3] || match[2]);
    return { startSeconds: hours * 3600 + minutes * 60 + seconds, title: match[4].trim() };
  });
}

async function uploadChunk(sessionToken: string, file: File, start: number) {
  const endExclusive = Math.min(start + CHUNK_BYTES, file.size);
  const authHeaders = getAuthHeaders();
  const headers = new Headers({
    "content-type": file.type || "video/mp4",
    "content-range": `bytes ${start}-${endExclusive - 1}/${file.size}`,
    "x-upload-session": sessionToken,
  });
  Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));
  const csrf = getCsrfToken(); if (csrf) headers.set("x-xsrf-token", csrf);
  const response = await fetch(buildApiUrl("/api/youtube/manage/uploads/chunk"), {
    method: "PUT", headers, body: file.slice(start, endExclusive), credentials: "include",
  });
  const payload = await response.json().catch(() => null) as { success?: boolean; data?: { complete: boolean; uploadedBytes?: number; videoId?: string }; error?: string } | null;
  if (!response.ok || !payload?.success) throw new Error(payload?.error || `Upload failed (${response.status})`);
  return payload.data!;
}

export function YouTubeStudioPanel() {
  const fieldId = useId();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [credentialId, setCredentialId] = useState<number | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [checkpoint, setCheckpoint] = useState<YouTubeUploadCheckpoint | null>(null);
  const uploadRunning = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [privacyStatus, setPrivacyStatus] = useState<"private" | "unlisted" | "public">("private");
  const [publishAt, setPublishAt] = useState("");
  const [videoId, setVideoId] = useState("");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistId, setPlaylistId] = useState("");
  const [captionUrl, setCaptionUrl] = useState("");
  const [captionLanguage, setCaptionLanguage] = useState("en");
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [chapters, setChapters] = useState("0:00 Introduction\n0:10 Main topic\n0:20 Next steps");
  const [analyticsStart, setAnalyticsStart] = useState(() => new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  const [analyticsEnd, setAnalyticsEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [analyticsResult, setAnalyticsResult] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [reply, setReply] = useState<Record<string, string>>({});
  const replying = useRef(new Set<string>());

  useEffect(() => {
    setReply(credentialId ? Object.fromEntries(Object.entries(loadYouTubeCommentDrafts(credentialId)).map(([id, draft]) => [id, draft.text])) : {});
  }, [credentialId]);

  const selected = useMemo(() => accounts.find((account) => account.id === credentialId), [accounts, credentialId]);
  const notify = (value: string) => setMessage(value);

  const refreshAccounts = useCallback(async () => {
    const rows = await api.get<Account[]>("/api/channel-accounts/youtube");
    setAccounts(rows);
    setCredentialId((current) => current || rows.find((row) => row.isSelected)?.id || rows[0]?.id || null);
  }, []);

  const refreshReadiness = useCallback(async (id: number) => {
    setReadiness(await api.get<Readiness>("/api/youtube/manage/readiness", { params: { credentialId: id } }));
  }, []);

  useEffect(() => { void refreshAccounts().catch((error: Error) => notify(error.message)); }, [refreshAccounts]);
  useEffect(() => { if (credentialId) void refreshReadiness(credentialId).catch((error: Error) => notify(error.message)); }, [credentialId, refreshReadiness]);

  async function selectAccount(id: number) {
    await api.post("/api/channel-accounts/youtube/select", { credentialId: id });
    setCredentialId(id); await refreshAccounts();
  }

  useEffect(() => {
    const saved = loadYouTubeUploadCheckpoint();
    if (!saved) return;
    setCheckpoint(saved); setCredentialId(saved.credentialId);
    setTitle(saved.details.title); setDescription(saved.details.description);
    setPrivacyStatus(saved.details.privacyStatus); setPublishAt(saved.details.publishAt);
    setProgress(Math.round(saved.uploadedBytes / saved.file.size * 100));
  }, []);

  function retainUpload(value: YouTubeUploadCheckpoint) {
    // Persist before any media dispatch or finalization so a lost response can
    // be recovered against the same provider session after this page reloads.
    saveYouTubeUploadCheckpoint(value); setCheckpoint(value);
  }

  async function startUpload(sendBytes = true) {
    if (uploadRunning.current || (!checkpoint && (!credentialId || !file || !title.trim()))) return;
    uploadRunning.current = true; setBusy(true); setMessage(null);
    let current = checkpoint;
    try {
      if (!current) {
        const session = await api.post<{ sessionToken: string; expiresAt: string }>("/api/youtube/manage/uploads/initiate", {
          credentialId, title: title.trim(), description, privacyStatus: publishAt ? "private" : privacyStatus,
          publishAt: publishAt ? new Date(publishAt).toISOString() : undefined,
          postType: "video", contentType: file!.type || "video/mp4", contentLength: file!.size,
        });
        current = { version: 1, scope: creatorSessionScope(), sessionToken: session.sessionToken, expiresAt: session.expiresAt,
          credentialId: credentialId!, file: { name: file!.name, size: file!.size, type: file!.type, lastModified: file!.lastModified },
          details: { title: title.trim(), description, privacyStatus, publishAt }, uploadedBytes: 0 };
        retainUpload(current);
      } else {
        if (current.scope !== creatorSessionScope() || current.credentialId !== credentialId) throw new Error("Return to the original business and channel to recover this upload.");
        if (Date.parse(current.expiresAt) <= Date.now()) throw new Error("The upload session expired. Check the channel before starting another upload; automatic reupload is blocked.");
        if (!current.videoId) {
          const status = await api.post<{ complete: boolean; uploadedBytes?: number; video?: { id?: string } }>("/api/youtube/manage/uploads/status", { sessionToken: current.sessionToken, contentLength: current.file.size });
          current = { ...current, uploadedBytes: status.complete ? current.file.size : acknowledgedYouTubeOffset(status.uploadedBytes, current.file.size), videoId: status.complete ? status.video?.id : undefined };
          retainUpload(current);
        }
      }
      let offset = current.uploadedBytes;
      if (!current.videoId && offset < current.file.size) {
        if (!sendBytes) { setProgress(Math.round(offset / current.file.size * 100)); notify(`YouTube has acknowledged ${offset} of ${current.file.size} bytes. Reselect the original file to resume this session.`); return; }
        if (!file || !matchesYouTubeUploadFile(current.file, file)) throw new Error("Reselect the original file with the same name, size, type and modification time to resume.");
        while (offset < current.file.size) {
          const result = await uploadChunk(current.sessionToken, file, offset);
          const next: number = result.complete ? current.file.size : acknowledgedYouTubeOffset(result.uploadedBytes, current.file.size);
          current = { ...current, uploadedBytes: next, videoId: result.complete ? result.videoId : undefined };
          retainUpload(current); setProgress(Math.round(next / current.file.size * 100));
          if (next <= offset) throw new Error("YouTube has not acknowledged further bytes. Check upload status before continuing.");
          offset = next;
        }
      }
      if (!current.videoId) throw new Error("YouTube accepted the bytes but its video receipt is pending. Check upload status; the same session will be retained.");
      const finalized = await api.post<{ videoId: string; postUrl: string; processingStatus: string }>("/api/youtube/manage/uploads/finalize", { sessionToken: current.sessionToken, videoId: current.videoId });
      if (!finalized.videoId || finalized.videoId !== current.videoId) throw new Error("The final video receipt did not match. The upload session is retained for checking.");
      setVideoId(finalized.videoId); clearYouTubeUploadCheckpoint(current); setCheckpoint(null); setFile(null);
      notify(`Uploaded ${finalized.videoId}; YouTube status: ${finalized.processingStatus}.`);
    } catch (error) { notify(error instanceof Error ? error.message : "Upload failed"); }
    finally { uploadRunning.current = false; setBusy(false); }
  }

  async function applyMetadata() {
    if (!credentialId || !videoId) return;
    await api.patch(`/api/youtube/manage/videos/${encodeURIComponent(videoId)}`, { credentialId, title: title || undefined, description, privacyStatus: publishAt ? "private" : privacyStatus, publishAt: publishAt ? new Date(publishAt).toISOString() : undefined });
    notify("Video metadata and native schedule updated.");
  }

  async function validateAndApplyChapters() {
    if (!credentialId || !videoId) return;
    const generated = await api.post<{ description: string }>("/api/youtube/manage/chapters/validate", { description, chapters: parseChapters(chapters) });
    setDescription(generated.description);
    await api.patch(`/api/youtube/manage/videos/${encodeURIComponent(videoId)}`, { credentialId, description: generated.description });
    notify("Validated chapter timestamps were added to the description.");
  }

  async function setThumbnail() {
    if (!credentialId || !videoId || !thumbnailUrl) return;
    await api.post(`/api/youtube/manage/videos/${encodeURIComponent(videoId)}/thumbnail`, { credentialId, thumbnailUrl });
    notify("Custom thumbnail updated.");
  }

  async function loadPlaylists() {
    if (!credentialId) return;
    const rows = await api.get<Playlist[]>("/api/youtube/manage/playlists", { params: { credentialId } }); setPlaylists(rows); setPlaylistId((current) => current || rows[0]?.id || "");
  }
  async function assignPlaylist() { if (credentialId && videoId && playlistId) { await api.post(`/api/youtube/manage/videos/${encodeURIComponent(videoId)}/playlists`, { credentialId, playlistId }); notify("Video added to playlist."); } }
  async function loadCaptions() { if (credentialId && videoId) setCaptions(await api.get<Caption[]>(`/api/youtube/manage/videos/${encodeURIComponent(videoId)}/captions`, { params: { credentialId } })); }
  async function addCaption() { if (credentialId && videoId && captionUrl) { await api.post(`/api/youtube/manage/videos/${encodeURIComponent(videoId)}/captions`, { credentialId, captionUrl, language: captionLanguage }); await loadCaptions(); notify("Caption track uploaded."); } }
  async function removeCaption(id: string) { if (credentialId) { await api.delete(`/api/youtube/manage/captions/${encodeURIComponent(id)}?credentialId=${credentialId}`); await loadCaptions(); } }

  async function syncAnalytics() {
    if (!credentialId) return;
    const result = await api.post<{ snapshots: unknown[]; limitations?: string[] }>("/api/youtube/manage/analytics/sync", { credentialId, startDate: analyticsStart, endDate: analyticsEnd, videoId: videoId || undefined });
    setAnalyticsResult(`${result.snapshots.length} daily snapshots synced.${result.limitations?.[0] ? ` ${result.limitations[0]}` : ""}`);
  }

  async function loadComments() { if (credentialId && videoId) { const result = await api.get<{ comments: Comment[] }>(`/api/youtube/manage/videos/${encodeURIComponent(videoId)}/comments`, { params: { credentialId } }); setComments(result.comments); } }
  async function moderate(commentId: string, moderationStatus: "published" | "heldForReview" | "rejected") { if (credentialId) { await api.post(`/api/youtube/manage/comments/${encodeURIComponent(commentId)}/moderate`, { credentialId, moderationStatus }); await loadComments(); } }
  async function sendReply(parentId: string) {
    const text = reply[parentId]?.trim();
    if (!credentialId || !text) return;
    const scope = `${creatorSessionScope()}:${credentialId}:${parentId}`;
    if (replying.current.has(scope)) return;
    replying.current.add(scope);
    let draft: ReturnType<typeof retainYouTubeCommentDraft> | undefined;
    try {
      draft = retainYouTubeCommentDraft(credentialId, parentId, text);
      const receipt = await api.post<{ id?: string }>(`/api/youtube/manage/comments/${encodeURIComponent(parentId)}/replies`, { credentialId, text }, { headers: { 'Idempotency-Key': draft.key } });
      if (!receipt.id?.trim()) throw new Error('The reply receipt is unconfirmed. Check YouTube before composing another reply.');
      clearYouTubeCommentDraft(credentialId, parentId, draft);
      setReply((current) => ({ ...current, [parentId]: "" }));
      await loadComments();
    } catch (error) {
      // Only an explicit provider rejection proves that this intent had no
      // effect. An unchanged user retry may then create a new reviewed intent.
      if (draft && (error as { data?: { code?: string } })?.data?.code === 'YOUTUBE_REPLY_REJECTED') {
        clearYouTubeCommentDraft(credentialId, parentId, draft);
      }
      throw error;
    } finally { replying.current.delete(scope); }
  }

  const action = async (fn: () => Promise<void>) => { setBusy(true); setMessage(null); try { await fn(); } catch (error) { notify(error instanceof Error ? error.message : "YouTube action failed"); } finally { setBusy(false); } };

  return <section className="min-w-0 space-y-5 rounded-xl border p-3 sm:p-5">
    <div><h2 className="text-lg font-semibold">YouTube Studio tools</h2><p className="text-sm text-muted-foreground">Manage the exact selected channel. OAuth tokens remain server-side during resumable uploads.</p></div>
    {message && <div role="status" className="rounded-md border bg-muted/40 p-3 text-sm">{message}</div>}
    <div className="grid gap-3 md:grid-cols-[1fr_auto]">
      <label className="text-sm">Channel<select className="mt-1 w-full rounded-md border bg-background px-3 py-2" value={credentialId || ""} disabled={busy || Boolean(checkpoint)} onChange={(event) => void action(() => selectAccount(Number(event.target.value)))}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.accountName} · {account.accountIdentifier}</option>)}</select></label>
      <div className="self-end rounded-md border px-3 py-2 text-sm"><span className={readiness?.ready ? "text-emerald-600" : "text-amber-600"}>{readiness?.ready ? "Ready" : readiness?.code?.replaceAll("_", " ") || "Checking…"}</span>{readiness?.missingCapabilities?.length ? <span className="ml-2 text-xs text-muted-foreground">Reconnect for {readiness.missingCapabilities.join(", ")}</span> : null}</div>
    </div>

    <div className="grid gap-4 lg:grid-cols-2">
      <div className="min-w-0 space-y-3 rounded-lg border p-3 sm:p-4"><h3 className="font-medium">Resumable upload & scheduling</h3>
        {checkpoint && <p className="text-sm text-muted-foreground">Recovering {checkpoint.file.name}. Its channel and reviewed settings stay fixed until the upload is verified.</p>}
        <input aria-label="Video file" className="block w-full min-w-0 text-sm" disabled={busy} type="file" accept="video/*" onChange={(event) => setFile(event.target.files?.[0] || null)} />
        <div className="space-y-1 text-sm"><label htmlFor={`${fieldId}-title`}>Video title</label><input id={`${fieldId}-title`} className="w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="Video title" disabled={busy || Boolean(checkpoint)} maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
        <div className="space-y-1 text-sm"><label htmlFor={`${fieldId}-description`}>Description</label><textarea id={`${fieldId}-description`} className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="Description" disabled={busy || Boolean(checkpoint)} maxLength={5000} value={description} onChange={(event) => setDescription(event.target.value)} /></div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><div className="space-y-1 text-sm"><label htmlFor={`${fieldId}-privacy`}>Video privacy</label><select id={`${fieldId}-privacy`} className="w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm" value={privacyStatus} disabled={busy || Boolean(checkpoint)} onChange={(event) => setPrivacyStatus(event.target.value as typeof privacyStatus)}><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select></div><div className="space-y-1 text-sm"><label htmlFor={`${fieldId}-publish-at`}>Native publish time</label><input id={`${fieldId}-publish-at`} aria-label="Native publish time" disabled={busy || Boolean(checkpoint)} className="w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm" type="datetime-local" value={publishAt} onChange={(event) => setPublishAt(event.target.value)} /></div></div>
        {busy && progress > 0 && <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${progress}%` }} /></div>}
        <div className="flex flex-wrap gap-2"><button className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={busy || !readiness?.ready || (!file && !checkpoint?.videoId) || !title.trim()} onClick={() => void startUpload()}>{checkpoint ? "Resume upload" : "Upload in chunks"}</button>{checkpoint && <button className="rounded-md border px-3 py-2 text-sm" disabled={busy} onClick={() => void startUpload(false)}>Check upload status</button>}<button className="rounded-md border px-3 py-2 text-sm disabled:opacity-50" disabled={busy || !videoId} onClick={() => void action(applyMetadata)}>Update metadata</button></div>
      </div>

      <div className="min-w-0 space-y-3 rounded-lg border p-3 sm:p-4"><h3 className="font-medium">Video management</h3>
        <label className="block text-sm">Video ID<input className="mt-1 w-full rounded-md border bg-background px-3 py-2" value={videoId} onChange={(event) => setVideoId(event.target.value)} placeholder="YouTube video ID" /></label>
        <div className="flex items-end gap-2"><div className="min-w-0 flex-1 space-y-1 text-sm"><label htmlFor={`${fieldId}-thumbnail`}>Thumbnail URL</label><input id={`${fieldId}-thumbnail`} className="w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm" value={thumbnailUrl} onChange={(event) => setThumbnailUrl(event.target.value)} placeholder="HTTPS thumbnail URL" /></div><button disabled={busy || !videoId || !thumbnailUrl} className="rounded-md border px-3 py-2 text-sm" onClick={() => void action(setThumbnail)}>Set thumbnail</button></div>
        <div className="flex items-end gap-2"><div className="min-w-0 flex-1 space-y-1 text-sm"><label htmlFor={`${fieldId}-playlist`}>Playlist</label><select id={`${fieldId}-playlist`} className="w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm" value={playlistId} onChange={(event) => setPlaylistId(event.target.value)}><option value="">Load a playlist</option>{playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.title} ({playlist.itemCount})</option>)}</select></div><button className="rounded-md border px-3 py-2 text-sm" onClick={() => void action(loadPlaylists)}>Load</button><button disabled={!playlistId || !videoId} className="rounded-md border px-3 py-2 text-sm" onClick={() => void action(assignPlaylist)}>Add</button></div>
        <div className="space-y-1 text-sm"><label htmlFor={`${fieldId}-chapters`}>Chapters</label><textarea id={`${fieldId}-chapters`} className="min-h-24 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm" value={chapters} onChange={(event) => setChapters(event.target.value)} /></div><button disabled={!videoId} className="rounded-md border px-3 py-2 text-sm" onClick={() => void action(validateAndApplyChapters)}>Validate & apply chapters</button>
      </div>

      <div className="min-w-0 space-y-3 rounded-lg border p-3 sm:p-4"><h3 className="font-medium">Caption tracks</h3><div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_5rem_auto]"><div className="min-w-0 space-y-1 text-sm"><label htmlFor={`${fieldId}-caption-url`}>Caption file URL</label><input id={`${fieldId}-caption-url`} className="w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm" value={captionUrl} onChange={(event) => setCaptionUrl(event.target.value)} placeholder="HTTPS VTT/SRT URL" /></div><div className="min-w-0 space-y-1 text-sm"><label htmlFor={`${fieldId}-caption-language`}>Caption language</label><input id={`${fieldId}-caption-language`} className="w-full min-w-0 rounded-md border bg-background px-2 py-2 text-sm" value={captionLanguage} onChange={(event) => setCaptionLanguage(event.target.value)} /></div><button disabled={!videoId || !captionUrl} className="rounded-md border px-3 py-2 text-sm" onClick={() => void action(addCaption)}>Upload</button></div><button className="rounded-md border px-3 py-2 text-sm" disabled={!videoId} onClick={() => void action(loadCaptions)}>Refresh tracks</button>{captions.map((caption) => <div className="flex items-center justify-between text-sm" key={caption.id}><span>{caption.language} · {caption.name || "Untitled"} · {caption.status}</span><button className="text-destructive" onClick={() => void action(() => removeCaption(caption.id))}>Delete</button></div>)}</div>

      <div className="min-w-0 space-y-3 rounded-lg border p-3 sm:p-4"><h3 className="font-medium">Analytics</h3><div className="grid grid-cols-2 gap-2"><input aria-label="Analytics start" type="date" className="rounded-md border bg-background px-3 py-2 text-sm" value={analyticsStart} onChange={(event) => setAnalyticsStart(event.target.value)} /><input aria-label="Analytics end" type="date" className="rounded-md border bg-background px-3 py-2 text-sm" value={analyticsEnd} onChange={(event) => setAnalyticsEnd(event.target.value)} /></div><button className="rounded-md border px-3 py-2 text-sm" onClick={() => void action(syncAnalytics)}>Sync provider analytics</button>{analyticsResult && <p className="text-xs text-muted-foreground">{analyticsResult}</p>}</div>
    </div>

    <div className="min-w-0 space-y-3 rounded-lg border p-3 sm:p-4"><div className="flex items-center justify-between"><h3 className="font-medium">Comment moderation</h3><button disabled={!videoId} className="rounded-md border px-3 py-2 text-sm" onClick={() => void action(loadComments)}>Load comments</button></div>{comments.map((comment) => { const id = comment.topLevelCommentId || comment.id || ""; return <div className="space-y-2 border-t pt-3" key={id}><p className="text-sm"><span className="font-medium">{comment.author || "YouTube user"}</span> {comment.text}</p><div className="flex flex-wrap items-end gap-2"><button className="rounded border px-2 py-1 text-xs" onClick={() => void action(() => moderate(id, "published"))}>Publish</button><button className="rounded border px-2 py-1 text-xs" onClick={() => void action(() => moderate(id, "heldForReview"))}>Hold</button><button className="rounded border px-2 py-1 text-xs text-destructive" onClick={() => void action(() => moderate(id, "rejected"))}>Reject</button><div className="min-w-52 flex-1 space-y-1 text-xs"><label htmlFor={`${fieldId}-reply-${id}`}>Reply</label><input id={`${fieldId}-reply-${id}`} className="w-full min-w-0 rounded border bg-background px-2 py-1 text-xs" value={reply[id] || ""} onChange={(event) => setReply((current) => ({ ...current, [id]: event.target.value }))} placeholder="Reply…" /></div><button className="rounded border px-2 py-1 text-xs" onClick={() => void action(() => sendReply(id))}>Reply</button></div></div>; })}</div>
    {selected && <p className="text-xs text-muted-foreground">All actions are bound to {selected.accountName} ({selected.accountIdentifier}).</p>}
  </section>;
}
