"use client";

import "@/components/outreach/assistants/assistant-workspace.css";

import { galleryUploadBatches, uploadGalleryFiles, type GalleryUploadResult } from '@/lib/support-media-upload';

import { businessProfileHeaders, selectedBusinessProfileId } from '@/lib/business-profile';
import { finishGalleryCreation, galleryCreationScope, pendingGalleryCreation, startGalleryCreation } from '@/lib/support-gallery-intent';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ImagePlus, Images, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Upload } from "lucide-react";
import api from "@/lib/api";
import { SupportMediaPreview } from "@/components/support/SupportMediaPreview";
import { MediaDeliveryAttention, type MediaDeliveryAttentionItem as Delivery } from "@/components/support/MediaDeliveryAttention";
import { supportMediaScanNotice } from "@/lib/supportMediaScanNotice";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Gallery = {
  id: number; title: string; description?: string; status: string; version_status?: string;
  asset_count?: number; published_asset_count?: number; helpful_auto_attach?: boolean;
  entity_tags?: string[]; rights_certified?: boolean;
  business_profile_id?: number | null; audience?: "customer" | "internal"; allowed_channels?: string[];
  usage_scopes?: string[]; current_published_version_id?: number | null;
  creation_request_key?: string | null;
};

type Asset = {
  id: number; name: string; owner_description?: string; alt_text: string; publication_state: string;
  owner_tags?: string[]; sort_order: number; scan_results?: Record<string, unknown>;
};

type GalleryDetail = Gallery & { assets: Asset[]; version_id: number };

function MediaScanSummary({ scan }: { scan?: Record<string, unknown> }) {
  if (!scan) return <p className="text-xs text-muted-foreground">No scan details are available.</p>;
  const review = scan.ownerReview as { decision?: string; reason?: string; reviewedAt?: string } | undefined;
  return <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
    <dt className="text-muted-foreground">Image safety scan</dt><dd>{scan.visionAvailable ? "Completed" : "Unavailable or incomplete"}</dd>
    <dt className="text-muted-foreground">Metadata removed</dt><dd>{scan.metadataStripped ? "Yes" : "Not confirmed"}</dd>
    <dt className="text-muted-foreground">Sensitive content</dt><dd>{scan.hasFace || scan.likelyChild || scan.unsafe || scan.hasSecrets || scan.hasInstructionInjection || (Array.isArray(scan.piiTypes) && scan.piiTypes.length > 0) ? "Flagged — replacement required" : "No findings from completed checks"}</dd>
    {review && <><dt className="text-muted-foreground">Owner decision</dt><dd className="break-words">{review.decision} · {review.reason}{review.reviewedAt ? ` · ${new Date(review.reviewedAt).toLocaleString()}` : ""}</dd></>}
  </dl>;
}

const DEFAULT_MEDIA_CHANNELS = ["whatsapp", "instagram", "facebook", "email", "web"] as const;
const EMPTY_GALLERY_FORM = { title: "", description: "", tags: "", helpful: true, certified: false,
  businessProfileId: "", audience: "customer" as "customer" | "internal", channels: [...DEFAULT_MEDIA_CHANNELS] as string[] };
type ScopeFields = Pick<typeof EMPTY_GALLERY_FORM, "businessProfileId" | "audience" | "channels">;
type BusinessProfile = { id: number; companyName?: string; company_name?: string; name?: string };

function GalleryScope({ value, onChange, profiles }: { value: ScopeFields; onChange: (fields: ScopeFields) => void; profiles: BusinessProfile[] }) {
  return <fieldset className="space-y-3 rounded-lg border p-3"><legend className="px-1 text-sm font-medium">Where images can be used</legend>
    <label className="block space-y-1 text-sm">Business or property<select aria-label="Business or property" className="h-10 w-full rounded-md border bg-background px-3" value={value.businessProfileId} onChange={(event) => onChange({ ...value, businessProfileId: event.target.value })}><option value="">Current business</option>{profiles.filter(profile => profile.id === selectedBusinessProfileId()).map((profile) => <option key={profile.id} value={profile.id}>{profile.companyName || profile.company_name || profile.name || `Profile ${profile.id}`}</option>)}</select></label>
    <label className="block space-y-1 text-sm">Audience<select aria-label="Media audience" className="h-10 w-full rounded-md border bg-background px-3" value={value.audience} onChange={(event) => onChange({ ...value, audience: event.target.value as ScopeFields["audience"] })}><option value="customer">Customers and support team</option><option value="internal">Support team only</option></select></label>
    <div><p className="mb-2 text-sm">Allowed channels</p><div className="flex flex-wrap gap-3">{DEFAULT_MEDIA_CHANNELS.map((channel) => <label key={channel} className="flex items-center gap-2 text-sm"><Checkbox checked={value.channels.includes(channel)} onCheckedChange={(checked) => onChange({ ...value, channels: checked ? [...value.channels, channel] : value.channels.filter((item) => item !== channel) })} />{channel === "web" ? "Web chat" : channel}</label>)}</div><p className="mt-2 text-xs text-muted-foreground">Choose at least one channel.</p></div>
  </fieldset>;
}

type UploadMode = "new" | "add" | "resume";
type GalleryEditor = { id: number; title: string; description: string; tags: string; helpful: boolean } & ScopeFields;
type AssetEditor = {
  galleryId: number; id: number; name: string; description: string; altText: string; tags: string; sortOrder: number;
};
type DeleteTarget = { kind: "gallery" | "asset"; galleryId: number; assetId?: number; name: string };

export default function MediaGalleriesPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [galleries, setGalleries] = useState<Gallery[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [detail, setDetail] = useState<GalleryDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadStage, setUploadStage] = useState('');
  const uploadGeneration = useRef(0);
  useEffect(() => () => { uploadGeneration.current += 1; }, []);
  const [draftGalleryId, setDraftGalleryId] = useState<number | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [names, setNames] = useState<string[]>([]);
  const [form, setForm] = useState(EMPTY_GALLERY_FORM);
  const [uploadMode, setUploadMode] = useState<UploadMode>("new");
  const [galleryEditor, setGalleryEditor] = useState<GalleryEditor | null>(null);
  const [assetEditor, setAssetEditor] = useState<AssetEditor | null>(null);
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<BusinessProfile[]>([]);
  const [profileError, setProfileError] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [review, setReview] = useState<{ asset: Asset; galleryId: number; decision: "approve" | "reject" } | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [deliveryError, setDeliveryError] = useState(false);
  const [reconciliation, setReconciliation] = useState<Delivery | null>(null);
  const [outcome, setOutcome] = useState<"delivered" | "not_delivered">("delivered");
  const [providerMessageId, setProviderMessageId] = useState("");
  const [deliveryReason, setDeliveryReason] = useState("");

  const loadDeliveries = useCallback(async () => {
    try { setDeliveries(await api.get<Delivery[]>("/api/settings/media-deliveries/uncertain")); setDeliveryError(false); }
    catch { setDeliveryError(true); }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try { setGalleries(await api.get<Gallery[]>("/api/settings/media-galleries")); }
    catch (error) { setLoadError(error instanceof Error ? error.message : "Please try again."); }
    finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadDeliveries(); }, [loadDeliveries]);
  useEffect(() => { void api.get<BusinessProfile[]>("/api/settings/business-profiles").then(setProfiles).catch(() => setProfileError(true)); }, []);

  const selectedSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const pendingCreationKey = pendingGalleryCreation(galleryCreationScope());
  const recoverableGallery = pendingCreationKey && galleries.find((gallery) => gallery.creation_request_key === pendingCreationKey);

  async function createGallery() {
    if (!form.certified || !form.title.trim() || !files.length || !form.channels.length) {
      toast({ title: "Complete the required fields", description: "Add a title, at least one image, and confirm the rights certification.", variant: "destructive" });
      return;
    }
    try { galleryUploadBatches(files); }
    catch (error) {
      toast({ title: 'Check the selected images', description: error instanceof Error ? error.message : 'Choose images up to 5 MB each.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    setUploadStage(draftGalleryId ? 'Uploading and checking images…' : 'Creating gallery draft…');
    setUploadErrors([]);
    const creationScope = galleryCreationScope();
    const generation = uploadGeneration.current;
    const currentUpload = () => uploadGeneration.current === generation && galleryCreationScope() === creationScope;
    const headers = businessProfileHeaders();
    let creationKey = pendingGalleryCreation(creationScope);
    try {
      let galleryId = draftGalleryId;
      if (!galleryId) {
        creationKey = startGalleryCreation(creationScope);
        const gallery = await api.post<{ id: number }>("/api/settings/media-galleries", {
          title: form.title, description: form.description,
          entityTags: form.tags.split(",").map((value) => value.trim()).filter(Boolean),
          allowedChannels: form.channels,
          businessProfileId: form.businessProfileId ? Number(form.businessProfileId) : null,
          usageScopes: ["support_answer", "outreach_reply", "hotel_policy", "internal_assist"],
          audience: form.audience, helpfulAutoAttach: form.helpful, rightsCertified: true,
          certification: { lawfulAuthority: true, customerUsePermitted: true, accuracyConfirmed: true },
        }, { headers: { ...headers, 'Idempotency-Key': creationKey } });
        galleryId = gallery.id;
        if (currentUpload()) setDraftGalleryId(galleryId);
      }
      if (galleryCreationScope() !== creationScope) throw new Error('The business changed. Return to the original business to resume this gallery.');
      if (currentUpload()) setUploadStage(`Uploading and checking ${files.length} image${files.length === 1 ? '' : 's'}…`);
      const result = await uploadGalleryFiles(files, files.map((file, index) => ({
        name: names[index] || file.name.replace(/\.[^.]+$/, ''),
        description: form.description,
        altText: `${names[index] || form.title} — ${form.description || 'customer-facing image'}`,
        tags: form.tags.split(',').map(value => value.trim()).filter(Boolean),
      })), async payload => {
        if (galleryCreationScope() !== creationScope) throw new Error('The business changed. Return to the original business to resume this gallery.');
        return api.postForm<GalleryUploadResult>(`/api/settings/media-galleries/${galleryId}/images`, payload, { headers });
      }, completed => { if (currentUpload()) setUploadStage(`Uploaded and checked ${completed} of ${files.length} images…`); });
      const failures = result?.outcomes?.filter((item) => item.status === "failed") || [];
      if (failures.length) {
        if (!currentUpload()) return;
        setUploadErrors(failures.map((item) => `${files[item.index]?.name}: ${item.error || "Upload failed"}`));
        setFiles(failures.map((item) => files[item.index]));
        setNames(failures.map((item) => names[item.index]));
        setUploadMode("resume");
        await load();
        toast({ title: "Some images need a retry", description: `${files.length - failures.length} saved; ${failures.length} failed. Only failed files remain selected.`, variant: "destructive" });
        return;
      }
      if (creationKey) finishGalleryCreation(creationScope, creationKey);
      if (!currentUpload()) return;
      const assets = result?.assets;
      const reviewCount = assets?.filter((asset) => asset.publication_state === 'ready_for_review').length || 0;
      const withheldCount = assets?.filter((asset) => ['quarantined', 'failed'].includes(asset.publication_state)).length || 0;
      toast({ title: uploadMode === "new" ? "Gallery processed" : "Images added", description: assets
        ? `${assets.length} image${assets.length === 1 ? '' : 's'} saved; ${reviewCount} awaiting owner review; ${withheldCount} withheld by safety checks. Check gallery publication status before sharing.`
        : 'Image upload saved. Check gallery publication status before sharing.' });
      setDialogOpen(false); setFiles([]); setNames([]);
      setDraftGalleryId(null);
      setUploadMode("new");
      setForm(EMPTY_GALLERY_FORM);
      await load();
    } catch (error) {
      if (!currentUpload()) return;
      toast({
        title: draftGalleryId ? "Image upload interrupted" : "Gallery creation needs checking",
        description: `${error instanceof Error ? error.message : "The upload did not finish."} Your files are still selected. Retry keeps the same creation identity; changed details may need the saved draft to be resolved first.`,
        variant: "destructive",
      });
    } finally { if (currentUpload()) setSaving(false); }
  }

  async function openGallery(id: number) {
    try { setDetail(await api.get<GalleryDetail>(`/api/settings/media-galleries/${id}`)); }
    catch (error) { toast({ title: "Gallery unavailable", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" }); }
  }

  function openNewGallery() {
    uploadGeneration.current += 1;
    setSaving(false);
    // A confirmed parent remains accessible from its gallery card. An explicit
    // new operation may use a fresh identity without duplicating an unknown one.
    if (recoverableGallery && pendingCreationKey) finishGalleryCreation(galleryCreationScope(), pendingCreationKey);
    setUploadErrors([]);
    setUploadMode("new");
    setDraftGalleryId(null);
    setFiles([]);
    setNames([]);
    setForm(EMPTY_GALLERY_FORM);
    setDialogOpen(true);
  }

  function resumePendingGallery() {
    if (!recoverableGallery) return;
    const generation = ++uploadGeneration.current;
    const scope = galleryCreationScope();
    void api.get<GalleryDetail>(`/api/settings/media-galleries/${recoverableGallery.id}`).then((gallery) => {
      if (generation === uploadGeneration.current && scope === galleryCreationScope()) continueDraftUpload(gallery);
    }).catch((error) => {
      if (generation !== uploadGeneration.current || scope !== galleryCreationScope()) return;
      toast({ title: 'Saved draft unavailable', description: error instanceof Error ? error.message : 'Please try again.', variant: 'destructive' });
    });
  }

  function continueDraftUpload(gallery: GalleryDetail) {
    uploadGeneration.current += 1;
    setSaving(false);
    setUploadMode("resume");
    setDraftGalleryId(gallery.id);
    setFiles([]);
    setNames([]);
    setForm({
      businessProfileId: gallery.business_profile_id ? String(gallery.business_profile_id) : "",
      audience: gallery.audience || "customer", channels: gallery.allowed_channels?.length ? gallery.allowed_channels : [...DEFAULT_MEDIA_CHANNELS],
      title: gallery.title,
      description: gallery.description || "",
      tags: (gallery.entity_tags || []).join(", "),
      helpful: gallery.helpful_auto_attach === true,
      certified: gallery.rights_certified === true,
    });
    setDetail(null);
    setDialogOpen(true);
  }

  function addImagesToGallery(gallery: GalleryDetail) {
    uploadGeneration.current += 1;
    setSaving(false);
    setUploadMode("add");
    setDraftGalleryId(gallery.id);
    setFiles([]);
    setNames([]);
    setForm({
      businessProfileId: gallery.business_profile_id ? String(gallery.business_profile_id) : "",
      audience: gallery.audience || "customer", channels: gallery.allowed_channels?.length ? gallery.allowed_channels : [...DEFAULT_MEDIA_CHANNELS],
      title: gallery.title,
      description: gallery.description || "",
      tags: (gallery.entity_tags || []).join(", "),
      helpful: gallery.helpful_auto_attach === true,
      certified: gallery.rights_certified === true,
    });
    setDetail(null);
    setDialogOpen(true);
  }

  function editGallery(gallery: GalleryDetail) {
    setGalleryEditor({
      businessProfileId: gallery.business_profile_id ? String(gallery.business_profile_id) : "",
      audience: gallery.audience || "customer", channels: gallery.allowed_channels?.length ? gallery.allowed_channels : [...DEFAULT_MEDIA_CHANNELS],
      id: gallery.id,
      title: gallery.title,
      description: gallery.description || "",
      tags: (gallery.entity_tags || []).join(", "),
      helpful: gallery.helpful_auto_attach === true,
    });
    setDetail(null);
  }

  async function saveGallery() {
    if (!galleryEditor?.title.trim() || !galleryEditor.channels.length) return;
    setSaving(true);
    try {
      const updated = await api.put<GalleryDetail>(`/api/settings/media-galleries/${galleryEditor.id}`, {
        title: galleryEditor.title,
        description: galleryEditor.description,
        entityTags: galleryEditor.tags.split(",").map((value) => value.trim()).filter(Boolean),
        helpfulAutoAttach: galleryEditor.helpful,
        businessProfileId: galleryEditor.businessProfileId ? Number(galleryEditor.businessProfileId) : null,
        audience: galleryEditor.audience, allowedChannels: galleryEditor.channels,
      });
      setGalleryEditor(null);
      setDetail(updated);
      await load();
      toast({ title: "Gallery updated", description: updated.version_status === "published" ? "Approved details are now live." : "Changes are saved in the draft. The live version is unchanged until review completes." });
    } catch (error) {
      toast({ title: "Could not update gallery", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally { setSaving(false); }
  }

  function editAsset(galleryId: number, asset: Asset) {
    setAssetEditor({
      galleryId, id: asset.id, name: asset.name, description: asset.owner_description || "",
      altText: asset.alt_text, tags: (asset.owner_tags || []).join(", "), sortOrder: asset.sort_order,
    });
    setReplacementFile(null);
    setDetail(null);
  }

  async function saveAsset() {
    if (!assetEditor?.name.trim()) return;
    setSaving(true);
    const metadata = {
      name: assetEditor.name,
      description: assetEditor.description,
      altText: assetEditor.altText,
      tags: assetEditor.tags.split(",").map((value) => value.trim()).filter(Boolean),
      sortOrder: assetEditor.sortOrder,
    };
    try {
      let updated: GalleryDetail;
      const wasReplaced = Boolean(replacementFile);
      if (replacementFile) {
        galleryUploadBatches([replacementFile]);
        const payload = new FormData();
        payload.append("image", replacementFile);
        payload.append("metadata", JSON.stringify(metadata));
        updated = await api.postForm<GalleryDetail>(
          `/api/settings/media-galleries/${assetEditor.galleryId}/assets/${assetEditor.id}/replace`, payload,
        );
      } else {
        updated = await api.patch<GalleryDetail>(
          `/api/settings/media-galleries/${assetEditor.galleryId}/assets/${assetEditor.id}`, metadata,
        );
      }
      setAssetEditor(null);
      setReplacementFile(null);
      setDetail(updated);
      await load();
      toast({ title: wasReplaced ? "Image replaced" : "Image updated", description: "The gallery has been reindexed with the latest image details." });
    } catch (error) {
      toast({ title: "Could not update image", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      if (deleteTarget.kind === "gallery") {
        await api.delete(`/api/settings/media-galleries/${deleteTarget.galleryId}`);
        setDetail(null);
        toast({ title: "Gallery deleted", description: "It can no longer be selected or delivered." });
      } else {
        const updated = await api.delete<GalleryDetail>(
          `/api/settings/media-galleries/${deleteTarget.galleryId}/assets/${deleteTarget.assetId}`,
        );
        setDetail(updated);
        toast({ title: "Image deleted", description: "It has been removed from the active gallery version." });
      }
      setDeleteTarget(null);
      await load();
    } catch (error) {
      toast({ title: "Could not delete media", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function retryScans() {
    if (!detail || saving) return;
    setSaving(true);
    try {
      await api.post(`/api/settings/media-galleries/${detail.id}/retry-scans`);
      await openGallery(detail.id);
      await load();
      toast({ title: "Safety scans finished", description: "Review each image's updated publication status." });
    } catch {
      toast({ title: "Could not retry scans", description: "The previous publication status is unchanged. Please try again.", variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function submitReview() {
    if (!review || !reviewReason.trim()) return;
    setSaving(true);
    try {
      const updated = await api.post<GalleryDetail>(`/api/settings/media-galleries/${review.galleryId}/assets/${review.asset.id}/review`, { decision: review.decision, reason: reviewReason });
      setDetail(updated); setReview(null); setReviewReason(""); await load();
      toast({ title: "Review recorded", description: "The gallery publication state has been updated." });
    } catch (error) { toast({ title: "Review could not be saved", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" }); }
    finally { setSaving(false); }
  }

  async function submitReconciliation() {
    if (!reconciliation || !deliveryReason.trim()) return;
    setSaving(true);
    try {
      await api.post(`/api/settings/media-deliveries/${reconciliation.id}/reconcile`, { outcome, reason: deliveryReason, providerMessageId });
      setReconciliation(null); setDeliveryReason(""); setProviderMessageId(""); await loadDeliveries();
      toast({ title: "Delivery outcome recorded", description: outcome === "delivered" ? "This image will not be sent again for this message." : "Use Retry image to resend this confirmed missing image. No image was sent by this action." });
    } catch (error) { toast({ title: "Could not record delivery outcome", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" }); }
    finally { setSaving(false); }
  }

  async function retryDelivery(delivery: Delivery) {
    setSaving(true);
    try {
      const result = await api.post<{ sent: number; failed: number }>(`/api/settings/media-deliveries/${delivery.id}/retry`);
      await loadDeliveries();
      toast({ title: result.sent ? "Image sent" : "Image could not be delivered", description: result.sent ? "The provider acknowledged the image." : "Check the updated delivery outcome before retrying.", variant: result.sent ? "default" : "destructive" });
    } catch (error) { toast({ title: "Image could not be retried", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" }); }
    finally { setSaving(false); }
  }

  return <div className="ak-workspace ak-media-workspace">
    <PageHeader className="ak-page-header" icon={Images} title="Media Galleries" subtitle="Governed customer-facing images for support agents across every channel" actions={<div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => router.push("/dashboard/knowledge-base")}><ArrowLeft className="mr-2 h-4 w-4" />Knowledge base</Button>
      {recoverableGallery && <Button variant="outline" size="sm" onClick={resumePendingGallery}>Resume gallery upload</Button>}
      <Button size="sm" onClick={openNewGallery}><Plus className="mr-2 h-4 w-4" />New gallery</Button>
    </div>} />

    <Card className="ak-media-safeguards"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4 text-emerald-600" />Publication safeguards</CardTitle>
      <CardDescription>Images are decoded safely, metadata is stripped, and privacy, rights, face/children, secret, and moderation checks fail closed. Media never counts as text knowledge or transactional evidence.</CardDescription></CardHeader></Card>

    {loadError ? <Card><CardContent role="alert" className="space-y-3 p-6"><p className="text-sm">Could not load media galleries: {loadError}</p><Button variant="outline" onClick={() => void load()}>Retry loading</Button></CardContent></Card> : loading ? <LoadingState className="py-16" label="Loading media galleries…" />
      : galleries.length === 0 ? <Card><CardContent className="flex flex-col items-center gap-3 py-16 text-center"><Images className="h-10 w-10 text-muted-foreground" /><div><p className="font-medium">No media galleries yet</p><p className="text-sm text-muted-foreground">Upload approved room, product, property, or service images.</p></div><Button onClick={openNewGallery}><Upload className="mr-2 h-4 w-4" />Create gallery</Button></CardContent></Card>
        : <div className="ak-gallery-grid">{galleries.map((gallery) =>
          <Card key={gallery.id} role="button" tabIndex={0} aria-label={`Open ${gallery.title} gallery`}
            className="ak-gallery-card cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void openGallery(gallery.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void openGallery(gallery.id); } }}>
            <div className="ak-gallery-cover" aria-hidden="true"><Images className="h-10 w-10" /></div><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><CardTitle className="break-words text-base">{gallery.title}</CardTitle><CardDescription className="mt-1 line-clamp-2 break-words">{gallery.description || "No description"}</CardDescription></div><Badge data-gallery-status={gallery.version_status || gallery.status} variant={gallery.version_status === "published" ? "default" : "secondary"}>{gallery.version_status || gallery.status}</Badge></div></CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground"><p>{gallery.published_asset_count || 0} of {gallery.asset_count || 0} images approved in this version{gallery.helpful_auto_attach ? " · helpful attachment enabled" : ""}</p>
              {gallery.current_published_version_id && gallery.version_status !== 'published' && <p className="text-xs">Previous approved version remains live while this draft is reviewed.</p>}
              <Badge variant="outline">{gallery.audience === 'internal' ? 'Support team only' : 'Customer images'}</Badge>
            </CardContent>
          </Card>)}</div>}

    <MediaDeliveryAttention deliveries={deliveries} loadError={deliveryError} saving={saving}
      onReload={() => void loadDeliveries()} onRetry={(delivery) => void retryDelivery(delivery)}
      onConnections={() => router.push("/dashboard/integrations")}
      onVerify={(delivery) => { setReconciliation(delivery); setOutcome("delivered"); setProviderMessageId(""); setDeliveryReason(""); }} />

    <Dialog open={dialogOpen} onOpenChange={(open) => {
      if (!open) { uploadGeneration.current += 1; setSaving(false); }
      setDialogOpen(open);
    }}>
      <DialogContent className="ak-dialog ak-media-dialog ak-media-upload">
        <DialogHeader>
          <DialogTitle>{uploadMode === "new" ? "Create media gallery" : `Add images to ${form.title}`}</DialogTitle>
          <DialogDescription>Every image needs a clear owner-authored name. Up to 50 JPEG, PNG, or WebP files, 5 MB each.</DialogDescription>
        </DialogHeader>
        <div className="ak-media-form">
          {uploadMode === "new" && <GalleryScope value={form} onChange={(fields) => setForm((current) => ({ ...current, ...fields }))} profiles={profiles} />}
          {profileError && <p role="alert" className="text-sm text-destructive">Business profiles could not be loaded. Reload this page to choose a property.</p>}
          {saving && <div className="space-y-1 text-sm text-muted-foreground"><p role="status">{uploadStage}</p><p>Closing this dialog does not undo an accepted upload. Refresh the library to check its outcome.</p></div>}
          {uploadErrors.length > 0 && <div role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm"><p className="font-medium">Saved files were removed from this upload. Retry the files below.</p>{uploadErrors.map((message) => <p key={message} className="mt-1 break-words text-destructive">{message}</p>)}</div>}
          {uploadMode === "new" ? <>
            <div className="space-y-2"><Label htmlFor="gallery-title">Gallery title *</Label><Input id="gallery-title" value={form.title} onChange={(e) => setForm((current) => ({ ...current, title: e.target.value }))} placeholder="Premium club rooms" /></div>
            <div className="space-y-2"><Label htmlFor="gallery-description">Description</Label><Textarea id="gallery-description" value={form.description} onChange={(e) => setForm((current) => ({ ...current, description: e.target.value }))} placeholder="Owner-approved description used for retrieval and captions" /></div>
            <div className="space-y-2"><Label htmlFor="gallery-tags">Product or entity tags</Label><Input id="gallery-tags" value={form.tags} onChange={(e) => setForm((current) => ({ ...current, tags: e.target.value }))} placeholder="premium club room, sanctuary villa, pool" /></div>
          </> : <div className="rounded-lg border bg-muted/40 p-3 text-sm"><p className="font-medium">{form.title}</p><p className="mt-1 text-muted-foreground">New images inherit this gallery&apos;s description and retrieval tags. Use Edit gallery to change them.</p></div>}
          <div className="ak-media-form-wide space-y-2"><Label htmlFor="gallery-images">Images *</Label><Input id="gallery-images" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => { const next = Array.from(e.target.files || []).slice(0, 50); setFiles(next); setNames(next.map((file) => file.name.replace(/\.[^.]+$/, ""))); }} /><p className="text-xs text-muted-foreground">{files.length} files · {(selectedSize / 1024 / 1024).toFixed(1)} MB</p></div>
          {files.map((file, index) => <div key={`${file.name}-${file.lastModified}`} className="ak-media-form-wide grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border p-3"><div><p className="truncate text-xs text-muted-foreground">{file.name}</p><Input aria-label={`Name for ${file.name}`} value={names[index] || ""} onChange={(e) => setNames((current) => current.map((name, itemIndex) => itemIndex === index ? e.target.value : name))} /></div><Button type="button" aria-label={`Remove ${file.name} from upload`} size="icon" variant="ghost" onClick={() => { setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index)); setNames((current) => current.filter((_, itemIndex) => itemIndex !== index)); }}><Trash2 className="h-4 w-4" /></Button></div>)}
          {uploadMode === "new" && <label className="ak-media-form-wide flex items-start gap-3 rounded-lg border p-3"><Checkbox checked={form.helpful} onCheckedChange={(checked) => setForm((current) => ({ ...current, helpful: checked === true }))} /><span><span className="block text-sm font-medium">Allow when highly helpful</span><span className="block text-xs text-muted-foreground">The agent may attach relevant images for visual comparisons, even without the word “photo”.</span></span></label>}
          <label className="ak-media-form-wide flex items-start gap-3 rounded-lg border border-amber-300/60 p-3"><Checkbox checked={form.certified} onCheckedChange={(checked) => setForm((current) => ({ ...current, certified: checked === true }))} /><span className="text-xs">I certify lawful authority and rights to use these images, that their descriptions are accurate, and that customer delivery is permitted.</span></label>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => { uploadGeneration.current += 1; setSaving(false); setDialogOpen(false); }}>{saving ? 'Close upload' : 'Cancel'}</Button><Button loading={saving} onClick={() => void createGallery()}>{uploadMode === "new" ? "Create and scan" : uploadMode === "resume" ? "Retry image upload" : "Add and scan images"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
      <DialogContent className="ak-dialog ak-media-dialog max-w-5xl">
        <DialogHeader><DialogTitle>{detail?.title}</DialogTitle><DialogDescription>{detail?.description || "Published media assets"}</DialogDescription></DialogHeader>
        <div className="flex flex-wrap gap-2 text-xs"><Badge variant="outline">{detail?.audience === "internal" ? "Support team only" : "Customer images"}</Badge><Badge variant="outline">{detail?.business_profile_id ? `Business profile ${detail.business_profile_id}` : "Current business"}</Badge><Badge variant="outline">{detail?.allowed_channels?.join(", ") || "All channels"}</Badge>{detail?.current_published_version_id && detail.current_published_version_id !== detail.version_id && <Badge variant="secondary">Draft shown · previous approved version is live</Badge>}</div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{detail?.assets.map((asset) => <div key={asset.id} className="space-y-2 rounded-xl border p-2">
          <SupportMediaPreview assetId={asset.id} alt={asset.alt_text} />
          <div className="flex items-start justify-between gap-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{asset.name}</p><p className="line-clamp-2 text-xs text-muted-foreground">{asset.owner_description || asset.alt_text}</p></div><Badge className="shrink-0" variant={asset.publication_state === "published" ? "default" : "secondary"}>{asset.publication_state}</Badge></div>
          {supportMediaScanNotice(asset.publication_state, asset.scan_results) && <p className="text-xs text-amber-600 dark:text-amber-400">{supportMediaScanNotice(asset.publication_state, asset.scan_results)}</p>}
          <div className="flex justify-end gap-1 border-t pt-2">
            {asset.publication_state === "ready_for_review" && <Button size="sm" variant="outline" onClick={() => { if (detail) { setReview({ asset, galleryId: detail.id, decision: "approve" }); setReviewReason(""); } }}>Review</Button>}
            <Button size="sm" variant="ghost" onClick={() => detail && editAsset(detail.id, asset)}><Pencil className="mr-2 h-3.5 w-3.5" />Edit</Button>
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => detail && setDeleteTarget({ kind: "asset", galleryId: detail.id, assetId: asset.id, name: asset.name })}><Trash2 className="mr-2 h-3.5 w-3.5" />Delete</Button>
          </div>
          <details><summary className="cursor-pointer text-xs text-muted-foreground">Safety and review details</summary><div className="mt-2"><MediaScanSummary scan={asset.scan_results} /></div></details>
        </div>)}</div>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button variant="destructive" onClick={() => detail && setDeleteTarget({ kind: "gallery", galleryId: detail.id, name: detail.title })}><Trash2 className="mr-2 h-4 w-4" />Delete gallery</Button>
          <div className="flex flex-wrap justify-end gap-2">
            {detail && <Button variant="outline" onClick={() => editGallery(detail)}><Pencil className="mr-2 h-4 w-4" />Edit gallery</Button>}
            {detail && <Button onClick={() => addImagesToGallery(detail)}><ImagePlus className="mr-2 h-4 w-4" />Add images</Button>}
            {detail?.version_status !== "published" && <Button variant="outline" onClick={() => detail && continueDraftUpload(detail)}><Upload className="mr-2 h-4 w-4" />Continue image upload</Button>}
            {detail?.assets.some((asset) => ["failed", "ready_for_review"].includes(asset.publication_state)) && <Button disabled={saving} variant="outline" onClick={() => void retryScans()}><RefreshCw className="mr-2 h-4 w-4" />Retry scans</Button>}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(galleryEditor)} onOpenChange={(open) => !open && setGalleryEditor(null)}>
      <DialogContent className="ak-dialog ak-media-dialog max-w-xl"><DialogHeader><DialogTitle>Edit gallery</DialogTitle><DialogDescription>Update how this gallery is described and found by support agents.</DialogDescription></DialogHeader>
        {galleryEditor && <div className="space-y-4">
          <GalleryScope value={galleryEditor} onChange={(fields) => setGalleryEditor((current) => current && ({ ...current, ...fields }))} profiles={profiles} />
          <div className="space-y-2"><Label htmlFor="edit-gallery-title">Gallery title *</Label><Input id="edit-gallery-title" value={galleryEditor.title} onChange={(e) => setGalleryEditor((current) => current && ({ ...current, title: e.target.value }))} /></div>
          <div className="space-y-2"><Label htmlFor="edit-gallery-description">Description</Label><Textarea id="edit-gallery-description" value={galleryEditor.description} onChange={(e) => setGalleryEditor((current) => current && ({ ...current, description: e.target.value }))} /></div>
          <div className="space-y-2"><Label htmlFor="edit-gallery-tags">Product or entity tags</Label><Input id="edit-gallery-tags" value={galleryEditor.tags} onChange={(e) => setGalleryEditor((current) => current && ({ ...current, tags: e.target.value }))} /></div>
          <label className="flex items-start gap-3 rounded-lg border p-3"><Checkbox checked={galleryEditor.helpful} onCheckedChange={(checked) => setGalleryEditor((current) => current && ({ ...current, helpful: checked === true }))} /><span><span className="block text-sm font-medium">Allow when highly helpful</span><span className="block text-xs text-muted-foreground">Permit relevant visual attachments even when the customer does not explicitly say “photo”.</span></span></label>
        </div>}
        <DialogFooter><Button variant="outline" onClick={() => setGalleryEditor(null)}>Cancel</Button><Button loading={saving} loadingText="Saving gallery…" disabled={!galleryEditor?.title.trim()} onClick={() => void saveGallery()}>Save gallery</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(assetEditor)} onOpenChange={(open) => { if (!open) { setAssetEditor(null); setReplacementFile(null); } }}>
      <DialogContent className="ak-dialog ak-media-dialog max-w-xl"><DialogHeader><DialogTitle>Edit image</DialogTitle><DialogDescription>Change this image&apos;s approved metadata or choose a replacement file. Replacements pass every media scan again.</DialogDescription></DialogHeader>
        {assetEditor && <div className="space-y-4">
          <div className="space-y-2"><Label htmlFor="edit-image-name">Image name *</Label><Input id="edit-image-name" value={assetEditor.name} onChange={(e) => setAssetEditor((current) => current && ({ ...current, name: e.target.value }))} /></div>
          <div className="space-y-2"><Label htmlFor="edit-image-description">Description</Label><Textarea id="edit-image-description" value={assetEditor.description} onChange={(e) => setAssetEditor((current) => current && ({ ...current, description: e.target.value }))} /></div>
          <div className="space-y-2"><Label htmlFor="edit-image-alt">Accessible alt text</Label><Input id="edit-image-alt" value={assetEditor.altText} onChange={(e) => setAssetEditor((current) => current && ({ ...current, altText: e.target.value }))} /></div>
          <div className="space-y-2"><Label htmlFor="edit-image-tags">Search tags</Label><Input id="edit-image-tags" value={assetEditor.tags} onChange={(e) => setAssetEditor((current) => current && ({ ...current, tags: e.target.value }))} /></div>
          <div className="space-y-2"><Label htmlFor="edit-image-order">Display order</Label><Input id="edit-image-order" type="number" min={0} max={49} value={assetEditor.sortOrder} onChange={(e) => setAssetEditor((current) => current && ({ ...current, sortOrder: Number(e.target.value) }))} /></div>
          <div className="space-y-2"><Label htmlFor="replace-image">Replace image file</Label><Input id="replace-image" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setReplacementFile(e.target.files?.[0] || null)} /><p className="text-xs text-muted-foreground">Optional. JPEG, PNG, or WebP up to 5 MB.</p></div>
        </div>}
        <DialogFooter><Button variant="outline" onClick={() => { setAssetEditor(null); setReplacementFile(null); }}>Cancel</Button><Button loading={saving} loadingText="Saving image…" disabled={!assetEditor?.name.trim()} onClick={() => void saveAsset()}>Save image</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(review)} onOpenChange={(open) => !open && !saving && setReview(null)}><DialogContent className="ak-dialog ak-media-dialog"><DialogHeader><DialogTitle>Review {review?.asset.name}</DialogTitle><DialogDescription>Automated scanning could not finish. Inspect the image and confirm it contains no personal data, faces, children, secrets, or unsafe content before approving. Your decision and reason are recorded.</DialogDescription></DialogHeader>{review && <SupportMediaPreview assetId={review.asset.id} alt={review.asset.alt_text} />}<details className="text-xs"><summary>Scan results</summary><pre className="mt-2 whitespace-pre-wrap break-words rounded bg-muted p-3">{JSON.stringify(review?.asset.scan_results, null, 2)}</pre></details><label className="space-y-1 text-sm">Decision<select aria-label="Review decision" className="h-10 w-full rounded-md border bg-background px-3" value={review?.decision || "approve"} onChange={(event) => setReview((current) => current && ({ ...current, decision: event.target.value as "approve" | "reject" }))}><option value="approve">Approve for the configured audience</option><option value="reject">Reject and quarantine</option></select></label><Textarea aria-label="Media review reason" maxLength={2000} value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder="Describe what you checked and the reason for this decision" /><DialogFooter><Button variant="outline" disabled={saving} onClick={() => setReview(null)}>Cancel</Button><Button disabled={saving || !reviewReason.trim()} onClick={() => void submitReview()}>Record review</Button></DialogFooter></DialogContent></Dialog>

    <Dialog open={Boolean(reconciliation)} onOpenChange={(open) => !open && !saving && setReconciliation(null)}><DialogContent className="ak-dialog ak-media-dialog"><DialogHeader><DialogTitle>Verify image delivery</DialogTitle><DialogDescription>Open the provider conversation and verify whether this exact image was sent. This action records the outcome; it does not send an image.</DialogDescription></DialogHeader><label className="space-y-1 text-sm">Confirmed outcome<select aria-label="Confirmed delivery outcome" className="h-10 w-full rounded-md border bg-background px-3" value={outcome} onChange={(event) => setOutcome(event.target.value as typeof outcome)}><option value="delivered">Delivered — prevent another send</option><option value="not_delivered">Not delivered — allow a retry</option></select></label>{outcome === "delivered" && <Input aria-label="Provider message ID" value={providerMessageId} onChange={(event) => setProviderMessageId(event.target.value)} placeholder="Provider message ID" />}<Textarea aria-label="Delivery verification evidence" maxLength={2000} value={deliveryReason} onChange={(event) => setDeliveryReason(event.target.value)} placeholder="Record how you verified the outcome" /><DialogFooter><Button variant="outline" disabled={saving} onClick={() => setReconciliation(null)}>Cancel</Button><Button disabled={saving || !deliveryReason.trim() || (outcome === "delivered" && !providerMessageId.trim())} onClick={() => void submitReconciliation()}>Record outcome</Button></DialogFooter></DialogContent></Dialog>

    <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{deleteTarget?.kind === "gallery" ? "Delete gallery?" : "Delete image?"}</AlertDialogTitle><AlertDialogDescription>{deleteTarget?.kind === "gallery" ? `“${deleteTarget.name}” and all of its images will stop being available to support agents.` : `“${deleteTarget?.name}” will be removed from this gallery. Historical audit versions are retained.`}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel><AlertDialogAction disabled={saving} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={(event) => { event.preventDefault(); void confirmDelete(); }}>{saving && <Spinner size="sm" label={null} className="mr-2" />}Delete</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
