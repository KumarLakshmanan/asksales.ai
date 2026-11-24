"use client";

import { useEffect, useState } from "react";
import api from "@/lib/api";
import { normalizeUploadUrl } from "@/lib/utils";
import { downloadContentMedia } from "@/lib/contentMediaTools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { fetchWithReadRetry } from "@/lib/api-client";

type ImageProof = { id: string; imageUrl: string; title: string };

/** Center crop calculations keep source pixels inside the original image. */
export function centeredCrop(width: number, height: number, ratio: number | null) {
  const cropWidth = ratio ? Math.min(width, height * ratio) : width;
  const cropHeight = ratio ? Math.min(height, width / ratio) : height;
  return { x: (width - cropWidth) / 2, y: (height - cropHeight) / 2, width: cropWidth, height: cropHeight };
}

/** Remove only a contiguous, near-white border background; never erase enclosed whites. */
export function clearWhiteBorder(pixels: Uint8ClampedArray, width: number, height: number) {
  const queue = new Uint32Array(width * height);
  const seen = new Uint8Array(width * height);
  let head = 0;
  let tail = 0;
  const visit = (index: number) => {
    if (seen[index]) return;
    seen[index] = 1;
    const offset = index * 4;
    if (pixels[offset] < 240 || pixels[offset + 1] < 240 || pixels[offset + 2] < 240) return;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++];
    pixels[index * 4 + 3] = 0;
    if (index % width) visit(index - 1);
    if (index % width < width - 1) visit(index + 1);
    if (index >= width) visit(index - width);
    if (index < width * (height - 1)) visit(index + width);
  }
}

export function ImageProofTools({ image, alternatives }: { image: ImageProof; alternatives: ImageProof[] }) {
  const [comparisonId, setComparisonId] = useState("");
  const [altText, setAltText] = useState("");
  const [crop, setCrop] = useState("original");
  const [transparent, setTransparent] = useState(false);
  const [editedUrl, setEditedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const assetId = image.id.startsWith("db-") ? Number(image.id.slice(3)) : null;
  const comparison = alternatives.find((candidate) => candidate.id === comparisonId);

  useEffect(() => {
    let active = true;
    if (assetId) void api.get<{ metadata?: { altText?: string } }>(`/api/content/assets/${assetId}`).then((asset) => {
      if (active) setAltText(asset.metadata?.altText || "");
    }).catch(() => { if (active) setError("Saved alt text could not be loaded. Try reopening this image."); });
    return () => { active = false; };
  }, [assetId]);
  useEffect(() => () => { if (editedUrl) URL.revokeObjectURL(editedUrl); }, [editedUrl]);

  const saveAltText = async () => {
    if (!assetId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const asset = await api.get<{ metadata?: Record<string, unknown>; version: number }>(`/api/content/assets/${assetId}`);
      await api.put(`/api/content/assets/${assetId}`, { metadata: { ...asset.metadata, altText: altText.trim() } });
      setNotice("Alt text saved to this image draft.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Alt text could not be saved."); }
    finally { setBusy(false); }
  };

  const prepareEdit = async () => {
    setBusy(true); setError(""); setNotice("");
    let sourceUrl: string | null = null;
    try {
      const response = await fetchWithReadRetry(normalizeUploadUrl(image.imageUrl));
      if (!response.ok) throw new Error("The original image could not be loaded.");
      const blob = await response.blob();
      sourceUrl = URL.createObjectURL(blob);
      const source = new Image();
      source.src = sourceUrl;
      await source.decode();
      // Bound memory for large images (RGBA pixels + flood-fill queue).
      const scale = Math.min(1, 2048 / Math.max(source.naturalWidth, source.naturalHeight));
      const ratio = crop === "original" ? null : crop.split(":").map(Number).reduce((a, b) => a / b);
      const bounds = centeredCrop(source.naturalWidth, source.naturalHeight, ratio);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bounds.width * scale));
      canvas.height = Math.max(1, Math.round(bounds.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image editing is not supported by this browser.");
      context.drawImage(source, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, canvas.width, canvas.height);
      if (transparent) {
        const data = context.getImageData(0, 0, canvas.width, canvas.height);
        clearWhiteBorder(data.data, canvas.width, canvas.height);
        context.putImageData(data, 0, 0);
      }
      const result = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Image export failed.")), "image/png"));
      setEditedUrl(URL.createObjectURL(result));
      setNotice("Preview ready. Download as PNG, then upload it as a new image draft. The original is unchanged.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Image editing failed."); }
    finally { if (sourceUrl) URL.revokeObjectURL(sourceUrl); setBusy(false); }
  };

  return <section className="mx-auto max-w-[760px] space-y-4 rounded-xl border border-border bg-card p-4" aria-label="Image review tools">
    <div><h3 className="text-sm font-semibold">Image review</h3><p className="text-xs text-muted-foreground">Describe accessibility, compare versions, and prepare a separate crop.</p></div>
    <div className="space-y-2"><Label htmlFor={`alt-${image.id}`}>Alt text</Label><Input id={`alt-${image.id}`} value={altText} maxLength={500} onChange={(event) => setAltText(event.target.value)} placeholder="Describe the image, not its generation instructions" /><Button size="sm" variant="outline" disabled={busy || !assetId} onClick={saveAltText}>Save alt text</Button></div>
    {alternatives.length > 0 && <div className="space-y-2"><Label htmlFor={`compare-${image.id}`}>Compare with another generation</Label><select id={`compare-${image.id}`} className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm" value={comparisonId} onChange={(event) => setComparisonId(event.target.value)}><option value="">Choose an image</option>{alternatives.map((candidate, index) => <option key={candidate.id} value={candidate.id}>{candidate.title} · {index + 1}</option>)}</select>{comparison && <div className="grid grid-cols-2 gap-3"><figure><img src={image.imageUrl} alt={altText || image.title} className="aspect-square w-full rounded-lg object-contain bg-muted" /><figcaption className="mt-1 text-xs">Current</figcaption></figure><figure><img src={comparison.imageUrl} alt={comparison.title} className="aspect-square w-full rounded-lg object-contain bg-muted" /><figcaption className="mt-1 text-xs">Comparison</figcaption></figure></div>}</div>}
    <div className="space-y-3 border-t pt-3"><Label htmlFor={`crop-${image.id}`}>Center crop</Label><select id={`crop-${image.id}`} className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm" value={crop} onChange={(event) => { setCrop(event.target.value); setEditedUrl(null); }}><option value="original">Original framing</option>{["1:1", "4:5", "16:9", "9:16"].map((ratio) => <option key={ratio}>{ratio}</option>)}</select><label className="flex items-center justify-between gap-3 text-sm">Remove white background<Switch checked={transparent} onCheckedChange={(value) => { setTransparent(value); setEditedUrl(null); }} /></label><p className="text-xs text-muted-foreground">Makes the near-white outer background transparent. Best for products on white; not AI subject cutout. PNG exports are limited to 2048 pixels on the longest side.</p><Button size="sm" variant="outline" disabled={busy} onClick={prepareEdit}>{busy ? "Working…" : "Preview edit"}</Button>{editedUrl && <><img src={editedUrl} alt={altText || image.title} className="max-h-80 w-full rounded-lg border bg-muted object-contain" /><Button size="sm" onClick={() => void downloadContentMedia(editedUrl, `${image.title}-edited`, "png").catch(() => setError("Download failed. Please retry."))}>Download edited PNG</Button></>}</div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
  </section>;
}
