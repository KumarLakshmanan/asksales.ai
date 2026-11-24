"use client";

import { useCallback, useEffect, useState } from "react";
import { Images, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { LoadingState } from "@/components/ui/loading-state";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { buildApiUrl, supportApi } from "@/lib/support-api";
import { useToast } from "@/hooks/use-toast";
import { fetchWithReadRetry } from "@/lib/api-client";

type Gallery = {
  id: number; title: string; description?: string | null; entity_tags?: string[];
  allowed_channels?: string[]; helpful_auto_attach?: boolean; asset_count: number; version_no: number;
  audience?: 'customer' | 'internal'; business_profile_id?: number | null;
};
type Asset = {
  id: number; name: string; owner_description?: string | null; alt_text?: string | null;
  owner_tags?: string[]; width?: number; height?: number;
};
type GalleryDetail = Gallery & { assets: Asset[] };

function MemberMediaPreview({ asset, ticketId }: { asset: Asset; ticketId: string }) {
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setSrc(undefined); setFailed(false);
    const token = localStorage.getItem("support_token");
    void fetchWithReadRetry(buildApiUrl(`/api/support-portal/media-galleries/assets/${asset.id}/content${ticketId ? `?ticketId=${encodeURIComponent(ticketId)}` : ""}`), {
      credentials: "include",
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).then((response) => response.ok ? response.blob() : Promise.reject(new Error("Preview unavailable")))
      .then((blob) => { if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setSrc(objectUrl); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [asset.id, retry, ticketId]);
  return src
    ? <img src={src} alt={asset.alt_text || asset.name} className="aspect-[4/3] w-full rounded-lg object-cover" />
    : <div role="status" className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-lg bg-muted"><Images className="h-7 w-7 text-muted-foreground" /><p className="text-xs text-muted-foreground">{failed ? "Preview unavailable" : "Loading preview…"}</p>{failed && <Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>Retry preview</Button>}</div>;
}

export default function SupportMediaLibraryPage() {
  const router = useRouter();
  const { member, isLoading: authLoading } = useSupportAuth();
  const { toast } = useToast();
  const [galleries, setGalleries] = useState<Gallery[]>([]);
  const [selected, setSelected] = useState<GalleryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticketInput, setTicketInput] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [resolvedScope, setResolvedScope] = useState<{ ticketId: number | null; businessProfileId: number | null }>({ ticketId: null, businessProfileId: null });

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await supportApi.get<{ galleries: Gallery[]; resolvedScope?: typeof resolvedScope }>(`/api/support-portal/media-galleries${ticketId ? `?ticketId=${encodeURIComponent(ticketId)}` : ""}`);
      setGalleries(result.galleries || []);
      setResolvedScope(result.resolvedScope || { ticketId: null, businessProfileId: null });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Try again.");
      toast({ title: "Media library unavailable", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    } finally { setLoading(false); }
  }, [toast, ticketId]);

  useEffect(() => {
    if (!authLoading && !member) { router.push("/support/login"); return; }
    if (member) void load();
  }, [authLoading, load, member, router]);

  const openGallery = async (gallery: Gallery) => {
    try { setSelected(await supportApi.get<GalleryDetail>(`/api/support-portal/media-galleries/${gallery.id}${ticketId ? `?ticketId=${encodeURIComponent(ticketId)}` : ""}`)); }
    catch (error) { toast({ title: "Gallery unavailable", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" }); }
  };
  const filtered = galleries.filter((gallery) => `${gallery.title} ${gallery.description || ""} ${(gallery.entity_tags || []).join(" ")}`.toLowerCase().includes(search.toLowerCase()));

  if (authLoading || loading) return <LoadingState className="min-h-72" label="Loading media library…" />;
  if (!member) return null;
  if (loadError) return <div role="alert" className="space-y-3 rounded-xl border p-6"><p className="text-sm">Media library could not be loaded: {loadError}</p><Button variant="outline" onClick={() => void load()}>Retry loading</Button>{ticketId && <Button variant="ghost" onClick={() => { setTicketId(""); setTicketInput(""); }}>Return to shared workspace media</Button>}</div>;
  return <div className="mx-auto max-w-screen-xl space-y-5">
    <div className="flex items-start gap-3"><div className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10"><Images className="h-4 w-4 text-primary" /></div><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold tracking-tight">Media Library</h1><Badge variant="outline" className="text-[10px] uppercase tracking-wide">Read only</Badge></div><p className="mt-0.5 text-sm text-muted-foreground">View approved images while handling customer conversations</p></div></div>
    <Card className="border-success/20 bg-success/5 shadow-none"><CardContent className="space-y-3 p-4"><div className="flex gap-3"><ShieldCheck className="mt-0.5 h-4 w-4 text-success" /><div><p className="text-sm font-medium">Approved images for your support workspace</p><p className="mt-1 text-xs text-muted-foreground">Scope: {resolvedScope.businessProfileId ? `business profile ${resolvedScope.businessProfileId} and shared workspace media` : "shared workspace media"}{resolvedScope.ticketId ? ` · ticket ${resolvedScope.ticketId}` : ""}. Draft, retired, and failed-review images never appear here.</p></div></div><form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); setSelected(null); setTicketId(ticketInput.trim()); }}><Input aria-label="Ticket ID for media context" type="number" min="1" step="1" placeholder="Ticket ID (optional)" value={ticketInput} onChange={(event) => setTicketInput(event.target.value)} className="max-w-56" /><Button type="submit" variant="outline" size="sm">Use ticket context</Button>{ticketId && <Button type="button" variant="ghost" size="sm" onClick={() => { setSelected(null); setTicketId(""); setTicketInput(""); }}>Clear</Button>}</form><p className="text-xs text-muted-foreground">A ticket available to your team can add its linked property's media. Tickets without a linked property show shared media only.</p></CardContent></Card>
    <SearchInput aria-label="Search media library" value={search} onValueChange={setSearch} placeholder="Search galleries and tags…" />
    {filtered.length ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{filtered.map((gallery) =>
      <Card key={gallery.id} role="button" tabIndex={0} aria-label={`Open ${gallery.title} gallery`} onClick={() => void openGallery(gallery)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void openGallery(gallery); } }}
        className="min-w-0 cursor-pointer shadow-none transition hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <CardHeader><div className="flex items-start justify-between gap-3"><div className="min-w-0"><CardTitle className="break-words text-base">{gallery.title}</CardTitle><CardDescription className="mt-1 line-clamp-2 break-words">{gallery.description || "Approved support imagery"}</CardDescription></div><Badge variant="secondary">{gallery.asset_count}</Badge></div></CardHeader>
        <CardContent className="flex flex-wrap gap-1.5"><Badge variant="secondary">{gallery.audience === 'internal' ? 'Support team only' : 'Customer images'}</Badge><Badge variant="outline">{gallery.allowed_channels?.join(', ') || 'All delivery channels'}</Badge>{(gallery.entity_tags || []).slice(0, 4).map((tag) => <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>)}</CardContent>
      </Card>)}</div> : <div className="rounded-xl border border-dashed py-16 text-center"><Images className="mx-auto h-7 w-7 text-muted-foreground" /><p className="mt-3 text-sm font-medium">No published media matches this view</p><p className="mt-1 text-xs text-muted-foreground">Ask the workspace owner to publish approved support images.</p></div>}
    <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}><DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto"><DialogHeader><DialogTitle>{selected?.title}</DialogTitle><DialogDescription>{selected?.description || "Published support images"}</DialogDescription></DialogHeader><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{selected?.assets.map((asset) => <article key={asset.id} className="space-y-2 rounded-xl border p-2"><MemberMediaPreview asset={asset} ticketId={ticketId} /><div><p className="text-sm font-medium">{asset.name}</p><p className="mt-1 text-xs text-muted-foreground">{asset.owner_description || asset.alt_text}</p></div></article>)}</div></DialogContent></Dialog>
  </div>;
}
