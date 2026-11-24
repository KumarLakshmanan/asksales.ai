"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Check, FileText, Sparkles, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import api from "@/lib/api";
import { creatorUploadError } from "@/lib/creator-upload";
import { useCreatorScope, creatorDraftScope } from './CreatorScope';
import { useRefreshContentLibrary } from '@/hooks/use-content-counts';
import { creatorSessionScope } from '@/lib/creator-session';

export type GeneratorMode = "ai" | "manual";

export interface ManualDraft {
  title: string;
  description: string;
  subject: string;
  content: string;
  mediaUrl?: string;
  mediaType?: "image" | "video";
}

interface GeneratorModeSwitchProps {
  mode: GeneratorMode;
  onChange: (mode: GeneratorMode) => void;
  manualLabel?: string;
}

export function GeneratorModeSwitch({ mode, onChange, manualLabel = "Create manually" }: GeneratorModeSwitchProps) {
  return (
    <div className="grid grid-cols-2 rounded-lg border border-border bg-muted/30 p-1" aria-label="Creation method">
      <button
        type="button"
        onClick={() => onChange("ai")}
        aria-pressed={mode === "ai"}
        className={`flex h-9 items-center justify-center gap-2 rounded-md text-xs font-medium transition-colors ${mode === "ai" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> AI generator
      </button>
      <button
        type="button"
        onClick={() => onChange("manual")}
        aria-pressed={mode === "manual"}
        className={`flex h-9 items-center justify-center gap-2 rounded-md text-xs font-medium transition-colors ${mode === "manual" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
      >
        <FileText className="h-3.5 w-3.5" aria-hidden="true" /> {manualLabel}
      </button>
    </div>
  );
}

interface ManualContentComposerProps {
  assetType: string;
  channel: string;
  returnHref: string;
  contentLabel?: string;
  contentPlaceholder?: string;
  uploadLabel?: string;
  accept?: string;
  requireFile?: boolean;
  requireContent?: boolean;
  mediaKind?: "image" | "video";
  onCreated?: (assetId: number) => void;
  buildStoredContent?: (values: {
    title: string;
    description: string;
    content: string;
    subject: string;
  }) => Record<string, unknown>;
  onDraftChange?: (draft: ManualDraft) => void;
  active?: boolean;
}

type ManualUploadReceipt = { state: "pending" | "confirmed"; fingerprint: string; kind: "image" | "video"; baselineUrls: string[]; url?: string };
type RecoveredManualAsset = { id: number; metadata?: Record<string, unknown>; imageUrl?: string | null; imageUrls?: string[] | null; videoUrl?: string | null; videoUrls?: string[] | null };
const fileFingerprint = (file: File) => JSON.stringify([file.name, file.type, file.size, file.lastModified]);
const assetMediaUrls = (asset: RecoveredManualAsset, kind: "image" | "video") => [...new Set((kind === "video" ? [asset.videoUrl, ...(asset.videoUrls || [])] : [asset.imageUrl, ...(asset.imageUrls || [])]).filter((url): url is string => Boolean(url)))];

export function ManualContentComposer({
  assetType,
  channel,
  returnHref,
  contentLabel = "Content",
  contentPlaceholder = "Write or paste the content you want to save…",
  uploadLabel = "Supporting media",
  accept = "image/*,video/*",
  requireFile = false,
  requireContent = true,
  mediaKind,
  onCreated,
  buildStoredContent,
  onDraftChange,
  active = true,
}: ManualContentComposerProps) {
  const { toast } = useToast();
  const scope = useCreatorScope();
  const refreshContent = useRefreshContentLibrary();
  const inputId = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [subject, setSubject] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [draftId, setDraftId] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [unconfirmedCreate, setUnconfirmedCreate] = useState(false);
  const [uploadReceipt, setUploadReceipt] = useState<ManualUploadReceipt | null>(null);
  const [recoveringMedia, setRecoveringMedia] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [recoveredMediaUrl, setRecoveredMediaUrl] = useState("");
  const recoveredMetadata = useRef<Record<string, unknown>>({});
  const savingRef = useRef(false);
  const savedDraft = useRef<{ id: number; payload: string; uploadedFile: File | null; uncertainFile: File | null } | null>(null);
  const [recoveredKey, setRecoveredKey] = useState('');
  const recoverySuffix = scope.threadId ? `:${creatorDraftScope(scope)}` : '';
  const draftKey = `asksales:manual:${creatorSessionScope()}:${assetType}:${channel}${recoverySuffix}`;
  const currentScope = useRef(draftKey);
  useEffect(() => {
    currentScope.current = draftKey;
    let activeScope = true;
    setTitle(''); setDescription(''); setContent(''); setSubject(''); setMediaUrl('');
    setFile(null); setPreviewUrl(null); setCreatedId(null); setDraftId(null);
    setSaveError(null); setUnconfirmedCreate(false); savedDraft.current = null;
    setUploadReceipt(null); setRecoveredMediaUrl(""); setRecoveringMedia(false); setRecoveryBlocked(false); recoveredMetadata.current = {};
    setSaving(false); savingRef.current = false;
    try {
      const stored = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      if (stored && typeof stored === 'object') {
        setTitle(typeof stored.title === 'string' ? stored.title : '');
        setDescription(typeof stored.description === 'string' ? stored.description : '');
        setContent(typeof stored.content === 'string' ? stored.content : '');
        setSubject(typeof stored.subject === 'string' ? stored.subject : '');
        setMediaUrl(typeof stored.mediaUrl === 'string' ? stored.mediaUrl : '');
        setUnconfirmedCreate(stored.unconfirmedCreate === true);
        const receipt: ManualUploadReceipt | null = stored.uploadReceipt && ["pending", "confirmed"].includes(stored.uploadReceipt.state) && ["image", "video"].includes(stored.uploadReceipt.kind) && Array.isArray(stored.uploadReceipt.baselineUrls)
          ? stored.uploadReceipt : null;
        setUploadReceipt(receipt);
        if (Number.isSafeInteger(stored.draftId) && stored.draftId > 0) {
          setDraftId(stored.draftId);
          savedDraft.current = { id: stored.draftId, payload: '', uploadedFile: null, uncertainFile: null };
          setRecoveringMedia(true);
          setRecoveryBlocked(true);
          void api.get<RecoveredManualAsset>(`/api/content/assets/${stored.draftId}`).then((asset) => {
            if (!activeScope) return;
            if (asset.id !== stored.draftId) throw new Error("The saved draft could not be verified.");
            recoveredMetadata.current = asset.metadata || {};
            const kind = receipt?.kind || mediaKind || "image";
            const urls = assetMediaUrls(asset, kind);
            if (receipt?.state === "pending") {
              const added = urls.filter((url) => !receipt.baselineUrls.includes(url));
              if (added.length !== 1) throw new Error("The previous upload is still unconfirmed. Check its status before uploading again; the request may still finish.");
              setUploadReceipt({ ...receipt, state: "confirmed", url: added[0] });
              setRecoveredMediaUrl(added[0]);
            } else {
              setRecoveredMediaUrl(receipt?.url && urls.includes(receipt.url) ? receipt.url : urls[0] || "");
              if (receipt?.url && !urls.includes(receipt.url)) setUploadReceipt(null);
            }
            setRecoveryBlocked(false);
          }).catch((reason) => {
            if (activeScope) setSaveError(reason instanceof Error ? reason.message : "Saved media could not be checked. Retry before editing this draft.");
          }).finally(() => { if (activeScope) setRecoveringMedia(false); });
        }
      }
    } catch { /* A corrupt or blocked session store must not block editing. */ }
    setRecoveredKey(draftKey);
    return () => { activeScope = false; };
  }, [draftKey, recoveryAttempt, mediaKind]);
  useEffect(() => {
    if (recoveredKey !== draftKey) return;
    try { sessionStorage.setItem(draftKey, JSON.stringify({ title, description, content, subject, mediaUrl, draftId, unconfirmedCreate, uploadReceipt })); } catch { /* storage optional */ }
  }, [recoveredKey, draftKey, title, description, content, subject, mediaUrl, draftId, unconfirmedCreate, uploadReceipt]);

  useEffect(() => {
    onDraftChange?.({ title, description, subject, content, mediaUrl: previewUrl || mediaUrl.trim() || recoveredMediaUrl || undefined, mediaType: file ? (file.type.startsWith("video/") ? "video" : "image") : uploadReceipt?.kind || mediaKind || "image" });
  }, [title, description, subject, content, previewUrl, mediaUrl, file, mediaKind, onDraftChange, recoveredMediaUrl, uploadReceipt]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const selectFile = (selected: File | null) => {
    const error = selected ? creatorUploadError(selected) : null;
    if (error) { toast({ title: "Cannot upload file", description: error, variant: "destructive" }); return; }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(selected);
    setPreviewUrl(selected ? URL.createObjectURL(selected) : null);
    setCreatedId(null);
  };

  const canSave = title.trim() && (!requireContent || content.trim()) && (!requireFile || file || mediaUrl.trim() || recoveredMediaUrl);

  const save = async () => {
    if (savingRef.current || unconfirmedCreate || recoveringMedia || recoveryBlocked) return;
    const requestScope = draftKey;
    const checkScope = () => { if (currentScope.current !== requestScope || requestScope !== `asksales:manual:${creatorSessionScope()}:${assetType}:${channel}${recoverySuffix}`) throw new Error("The active account changed. Reopen the original account to recover this draft."); };
    const persistUpload = (receipt: ManualUploadReceipt | null, id: number) => {
      checkScope();
      setUploadReceipt(receipt);
      // Write before dispatch, not in a later effect: refresh can happen while upload is in flight.
      try { sessionStorage.setItem(requestScope, JSON.stringify({ title, description, content, subject, mediaUrl, draftId: id, unconfirmedCreate, uploadReceipt: receipt })); } catch { /* in-memory guard remains */ }
    };
    if (mediaUrl.trim()) {
      try { const parsed = new URL(mediaUrl.trim()); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(); }
      catch { toast({ title: "Invalid media URL", description: "Use a complete HTTPS URL without embedded credentials.", variant: "destructive" }); return; }
    }
    if (!canSave) {
      toast({
        title: "Complete the required fields",
        description: requireFile ? "Add a title and upload a file before saving." : "Add a title and content before saving.",
        variant: "destructive",
      });
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    setCreatedId(null);
    try {
      const values = {
        title: title.trim(),
        description: description.trim(),
        content: content.trim(),
        subject: subject.trim(),
      };
      const storedContent = JSON.stringify(buildStoredContent?.(values) ?? {
        ...values,
        body: values.content,
        message: values.content,
        caption: values.content,
        origin: "manual",
      });
      const payload = {
        ...(scope.threadId ? { threadId: scope.threadId } : {}),
        type: assetType,
        title: title.trim(),
        content: storedContent,
        channel,
        status: "draft",
        ...(mediaKind === "image" && mediaUrl.trim() && !file ? { imageUrl: mediaUrl.trim() } : {}),
        ...(mediaKind === "video" && mediaUrl.trim() && !file ? { videoUrl: mediaUrl.trim() } : {}),
        metadata: {
          ...recoveredMetadata.current,
          origin: "manual",
          description: description.trim() || null,
          originalFileName: file?.name || recoveredMetadata.current.originalFileName || null,
        },
      };
      const fingerprint = JSON.stringify(payload);
      if (!savedDraft.current) {
        try {
          const asset = await api.post<{ id: number }>("/api/content/assets", payload);
          if (!Number.isSafeInteger(asset?.id) || asset.id <= 0) throw new Error("The server did not return a valid saved draft ID. Check the library before trying again.");
          // Keep the receipt with its original account even if navigation switched accounts.
          try { sessionStorage.setItem(requestScope, JSON.stringify({ title, description, content, subject, mediaUrl, draftId: asset.id, unconfirmedCreate: false, uploadReceipt: null })); } catch { /* in-memory receipt still protects this mount */ }
          checkScope();
          savedDraft.current = { id: asset.id, payload: fingerprint, uploadedFile: null, uncertainFile: null };
          setDraftId(asset.id);
          persistUpload(null, asset.id);
        } catch (error) {
          if (currentScope.current !== requestScope) throw error;
          const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
          // A lost create receipt cannot be retried safely: this endpoint has no
          // creation idempotency contract. Preserve the input and ask for review.
          if (status === 0 || status >= 500) setUnconfirmedCreate(true);
          throw error;
        }
      }
      const draft = savedDraft.current;
      if (uploadReceipt?.state === "pending") {
        const persisted = await api.get<RecoveredManualAsset>(`/api/content/assets/${draft.id}`);
        checkScope();
        if (persisted.id !== draft.id) throw new Error("The previous upload could not be checked. Review the saved draft in the library before retrying.");
        const added = assetMediaUrls(persisted, uploadReceipt.kind).filter((url) => !uploadReceipt.baselineUrls.includes(url));
        if (added.length !== 1) throw new Error("The previous upload is still unconfirmed. Check its status before uploading again; the request may still finish.");
        if (file && fileFingerprint(file) !== uploadReceipt.fingerprint) throw new Error("The previous upload was saved. Review it in the library before selecting a different file.");
        draft.uploadedFile = file;
        draft.uncertainFile = null;
        setRecoveredMediaUrl(added[0]);
        persistUpload({ ...uploadReceipt, state: "confirmed", url: added[0] }, draft.id);
      }
      if (draft.payload !== fingerprint) {
        const updated = await api.put<{ id: number }>(`/api/content/assets/${draft.id}`, payload);
        checkScope();
        if (updated?.id !== draft.id) throw new Error("The draft update was not confirmed. Your input is still here; retry to update the same draft.");
        draft.payload = fingerprint;
      }

      if (file && draft.uploadedFile !== file && !(uploadReceipt?.state === "confirmed" && uploadReceipt.fingerprint === fileFingerprint(file))) {
        let attemptReceipt: ManualUploadReceipt | null = null;
        try {
          const existing = await api.get<RecoveredManualAsset>(`/api/content/assets/${draft.id}`);
          checkScope();
          if (existing.id !== draft.id) throw new Error("The saved draft could not be verified before upload.");
          const kind = mediaKind || (file.type.startsWith("video/") ? "video" : "image");
          attemptReceipt = { state: "pending", fingerprint: fileFingerprint(file), kind, baselineUrls: assetMediaUrls(existing, kind) };
          persistUpload(attemptReceipt, draft.id);
          const formData = new FormData();
          formData.append("file", file);
          formData.append("assetId", String(draft.id));
          formData.append("mediaType", mediaKind || (file.type.startsWith("video/") ? "video" : "image"));
          const receipt = await api.postForm<{ success?: boolean; url?: string; asset?: { id: number } }>("/api/content/assets/upload", formData);
          checkScope();
          if (!receipt?.success || !receipt.url || (receipt.asset && receipt.asset.id !== draft.id)) throw new Error("The media upload did not return a confirmed saved receipt.");
          draft.uploadedFile = file;
          setRecoveredMediaUrl(receipt.url);
          persistUpload({ ...attemptReceipt, state: "confirmed", url: receipt.url }, draft.id);
        } catch (uploadError) {
          if (currentScope.current !== requestScope) throw uploadError;
          const status = typeof uploadError === "object" && uploadError !== null && "status" in uploadError ? Number(uploadError.status) : 0;
          if (status === 0 || status >= 500) draft.uncertainFile = file;
          else if (attemptReceipt) persistUpload(null, draft.id);
          throw uploadError;
        }
      }

      setCreatedId(draft.id);
      refreshContent();
      onCreated?.(draft.id);
      toast({ title: "Draft saved", description: "Your content is saved in the library." });
    } catch (error) {
      if (currentScope.current !== requestScope) return;
      const message = error instanceof Error ? error.message : "Check the fields and try again.";
      setSaveError(message);
      toast({
        title: savedDraft.current ? "Draft saved; completion needs attention" : "Draft save could not be confirmed",
        description: message,
        variant: "destructive",
      });
    } finally {
      if (currentScope.current === requestScope) { savingRef.current = false; setSaving(false); }
    }
  };

  return (
    <fieldset disabled={saving || recoveringMedia} hidden={!active} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${inputId}-title`} className="text-xs">Title <span aria-hidden="true" className="text-muted-foreground">(required)</span></Label>
        <Input id={`${inputId}-title`} required value={title} onChange={(event) => { setTitle(event.target.value); setCreatedId(null); }} placeholder="Name this draft" />
      </div>
      {assetType === "email_template" && <div className="space-y-2">
        <Label htmlFor={`${inputId}-subject`} className="text-xs">Subject line</Label>
        <Input id={`${inputId}-subject`} value={subject} onChange={(event) => { setSubject(event.target.value); setCreatedId(null); }} placeholder="What recipients see in their inbox" />
      </div>}
      <div className="space-y-2">
        <Label htmlFor={`${inputId}-description`} className="text-xs">Description (optional)</Label>
        <Input id={`${inputId}-description`} value={description} onChange={(event) => { setDescription(event.target.value); setCreatedId(null); }} placeholder="Add context for teammates" />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${inputId}-content`} className="text-xs">{contentLabel}{!requireContent && <span className="font-normal text-muted-foreground"> (optional)</span>}</Label>
        <Textarea id={`${inputId}-content`} value={content} onChange={(event) => { setContent(event.target.value); setCreatedId(null); }} placeholder={contentPlaceholder} rows={7} className="resize-y" />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={inputId} className="text-xs">{uploadLabel}{!requireFile && <span className="font-normal text-muted-foreground"> (optional)</span>}</Label>
          {file && (
            <button type="button" onClick={() => selectFile(null)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive">
              <Trash2 className="h-3 w-3" /> Remove
            </button>
          )}
        </div>
        <input id={inputId} type="file" accept={accept} className="sr-only" onChange={(event) => selectFile(event.target.files?.[0] || null)} />
        <label htmlFor={inputId} className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-5 text-center transition-colors hover:border-primary/50 hover:bg-primary/5">
          <Upload className="h-5 w-5 text-primary" aria-hidden="true" />
          <span className="text-xs font-medium">{file ? file.name : "Choose a file"}</span>
          <span className="text-[11px] text-muted-foreground">{accept.replaceAll("/*", " files").replaceAll(",", " or ")}</span>
        </label>
        {mediaKind && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              <span className="h-px flex-1 bg-border" /> or use an existing URL <span className="h-px flex-1 bg-border" />
            </div>
            <Input
              aria-label={`${mediaKind === "video" ? "Video" : "Image"} URL`}
              value={mediaUrl}
              onChange={(event) => { setMediaUrl(event.target.value); setCreatedId(null); }}
              placeholder="/uploads/… or https://…"
              disabled={Boolean(file)}
            />
          </div>
        )}
        {(previewUrl || mediaUrl.trim() || recoveredMediaUrl) && (
          <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
            {(file?.type.startsWith("video/") || (!file && (uploadReceipt?.kind || mediaKind) === "video")) ? (
              <video src={previewUrl || mediaUrl.trim() || recoveredMediaUrl} controls className="max-h-48 w-full object-contain" />
            ) : (
              <img src={previewUrl || mediaUrl.trim() || recoveredMediaUrl} alt="Selected upload preview" className="max-h-48 w-full object-contain" />
            )}
          </div>
        )}
        {recoveredMediaUrl && <p className="text-xs text-muted-foreground">Saved attachment restored. Selecting another file adds an attachment; manage removals in the library.</p>}
      </div>

      <Button data-creator-action={active ? "" : undefined} type="button" onClick={() => void save()} loading={saving} loadingText="Saving draft…" disabled={recoveringMedia || recoveryBlocked || !canSave || unconfirmedCreate || Boolean(createdId)} className="h-11 w-full">
        <Check className="mr-2 h-4 w-4" />
        {createdId ? "Draft saved" : draftId ? (saveError ? "Retry saving draft" : "Save changes") : "Save manual draft"}
      </Button>

      {createdId && (
        <div className="border border-success/25 bg-success/5 p-3 text-xs leading-5 text-muted-foreground">
          Draft #{createdId} is stored. <Link href={returnHref} className="font-medium text-foreground underline underline-offset-4">View it in the library</Link>.
        </div>
      )}
      {draftId && !createdId && <p role="status" className="text-xs text-muted-foreground">Draft #{draftId} already exists. Changes will update this draft. <Link href={returnHref} className="underline">View in library</Link>.</p>}
      {(saveError || unconfirmedCreate) && <p role="alert" className="text-xs text-destructive">{saveError || "The previous draft save could not be confirmed."}{unconfirmedCreate && <> Your input is preserved. <Link href={returnHref} className="underline">Check the library</Link> before creating another draft; the first request may have saved.</>}</p>}
      {unconfirmedCreate && <Button type="button" variant="outline" onClick={() => { setUnconfirmedCreate(false); setSaveError(null); }}>I checked the library; try saving again</Button>}
      {(recoveryBlocked || uploadReceipt?.state === "pending") && <Button type="button" variant="outline" onClick={() => setRecoveryAttempt((value) => value + 1)}>Check previous upload status</Button>}
      {recoveringMedia && <p role="status" className="text-xs text-muted-foreground">Checking the saved draft and its media…</p>}
      {createdId && <Button type="button" variant="outline" onClick={() => {
        savedDraft.current = null; setDraftId(null); setCreatedId(null); setSaveError(null); setUnconfirmedCreate(false);
        setUploadReceipt(null); setRecoveredMediaUrl(""); setRecoveryBlocked(false); recoveredMetadata.current = {};
        setTitle(""); setDescription(""); setSubject(""); setContent(""); setMediaUrl(""); selectFile(null);
      }}>Create another draft</Button>}
    </fieldset>
  );
}
