"use client";

import { useId, useRef, useState } from "react";
import { Check, ImageIcon, Upload } from "lucide-react";
import api, { buildApiUrl } from "@/lib/api";
import { Callout } from "@/components/ui/callout";
import { Spinner } from "@/components/ui/spinner";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";
import Link from "next/link";
import { BRAND_IMAGE_LIMITS } from "../../../../shared/workspaceOnboarding";
import type { BrandImageAsset } from "@/lib/workspace-profile";
import { trackSetupEvent } from "@/lib/setup-analytics";
import "./brand-toolkit.css";

function ImagePreview({ url, alt, onDimensions }: { url: string; alt: string; onDimensions?: (width: number, height: number) => void }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span className="flex h-36 items-center justify-center bg-muted text-xs text-muted-foreground">
      Preview unavailable
    </span>
  ) : (
    <img
      src={buildApiUrl(url)}
      alt={alt}
      loading="lazy"
      decoding="async"
      onLoad={(event) => onDimensions?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
      onError={() => setFailed(true)}
      className="h-36 w-full object-cover"
    />
  );
}

/** Keep the upload unchanged when browser decoding or compression is unavailable. */
export async function optimizeBrandUpload(file: File): Promise<{ file: File; width?: number; height?: number }> {
  if (typeof createImageBitmap !== "function") return { file };
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return { file, width: bitmap.width, height: bitmap.height };
    context.drawImage(bitmap, 0, 0, width, height);
    const compressed = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.86));
    if (!compressed || compressed.size >= file.size) return { file, width: bitmap.width, height: bitmap.height };
    return { file: new File([compressed], file.name.replace(/\.[^.]+$/, "") + ".webp", { type: compressed.type || "image/webp" }), width, height };
  } catch { return { file }; }
  finally { bitmap?.close(); }
}

export function uniqueBrandImages(assets: BrandImageAsset[]): BrandImageAsset[] {
  return [...new Map(assets.map((asset) => [asset.url, asset])).values()];
}

export function BrandImagesStep({
  profileId,
  available,
  selected,
  onChange,
  onAdd,
  screenshot,
  keepScreenshot,
  onScreenshot,
  onUploading,
}: {
  profileId: number;
  available: BrandImageAsset[];
  selected: BrandImageAsset[];
  onChange: (images: BrandImageAsset[]) => void;
  onAdd: (images: BrandImageAsset[]) => void;
  screenshot: string;
  keepScreenshot: boolean;
  onScreenshot: (keep: boolean) => void;
  onUploading: (uploading: boolean) => void;
}) {
  const inputId = useId();
  const screenshotId = useId();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dimensions, setDimensions] = useState<Record<string, { width: number; height: number }>>({});
  const uploadedHashes = useRef(new Set<string>());
  const moveImage = (url: string, direction: -1 | 1) => {
    const index = selected.findIndex((image) => image.url === url);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= selected.length) return;
    const reordered = [...selected];
    [reordered[index], reordered[next]] = [reordered[next], reordered[index]];
    onChange(reordered);
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length || uploading) return;
    setError("");
    setNotice("");
    setUploading(true);
    onUploading(true);
    const added: BrandImageAsset[] = [];
    const startedAt = Date.now();
    try {
      const requested = Array.from(files);
      if (requested.some((file) => !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > BRAND_IMAGE_LIMITS.uploadBytes))
        throw new Error("Choose PNG, JPG, or WebP images up to 5 MB each.");
      let duplicates = 0;
      for (const file of requested) {
        if (
          !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
          file.size > BRAND_IMAGE_LIMITS.uploadBytes
        )
          throw new Error("Choose PNG, JPG, or WebP images up to 5 MB each.");
        const digest = globalThis.crypto?.subtle
          ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))).map((byte) => byte.toString(16).padStart(2, "0")).join("")
          : "";
        if (digest && uploadedHashes.current.has(digest)) { duplicates++; continue; }
        if (selected.length + added.length >= BRAND_IMAGE_LIMITS.count) throw new Error("Keep up to 100 images in your toolkit.");
        const optimized = await optimizeBrandUpload(file);
        const form = new FormData();
        form.append("image", optimized.file);
        const result = await api.postForm<{ url: string; thumbnailUrl?: string; width?: number; height?: number; sizeBytes?: number; originalName?: string }>(
          "/api/content/brand-toolkits/upload-image",
          form,
          { headers: { [BUSINESS_PROFILE_HEADER]: String(profileId) } },
        );
        if (!result.url)
          throw new Error("The image could not be uploaded. Try again.");
        trackSetupEvent("asset_uploaded", { phase: "brand_images", durationMs: Date.now() - startedAt });
        added.push({ url: result.url, source: "upload", originalName: result.originalName || file.name, sizeBytes: result.sizeBytes ?? optimized.file.size, ...(result.thumbnailUrl ? { thumbnailUrl: result.thumbnailUrl } : {}), ...((result.width || optimized.width) && (result.height || optimized.height) ? { width: result.width || optimized.width, height: result.height || optimized.height } : {}) });
        if (digest) uploadedHashes.current.add(digest);
      }
      if (duplicates) setNotice(`${duplicates} duplicate ${duplicates === 1 ? "image was" : "images were"} skipped.`);
    } catch (failure) {
      trackSetupEvent("asset_upload_failed", { phase: "brand_images", durationMs: Date.now() - startedAt });
      setError(
        failure instanceof Error
          ? failure.message
          : "The images could not be uploaded. Try again.",
      );
    } finally {
      if (added.length) onAdd(uniqueBrandImages(added));
      setUploading(false);
      onUploading(false);
    }
  };
  return (
    <section className="space-y-7" aria-label="Brand images">
      <div>
        <h3 className="font-semibold">Images for your brand</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Select the website images you want to keep, or upload your own. You
          can change them later.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">Unselected uploads remain in your storage library. <Link className="underline" href="/dashboard/storage">Manage stored files</Link> to remove files you no longer need.</p>
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      {error && <Callout tone="danger">{error}</Callout>}
      <div className="rounded-xl border border-dashed bg-background p-5">
        <label
          htmlFor={inputId}
          className="mb-3 flex items-center gap-2 text-sm font-medium"
        >
          <Upload size={18} />
          Upload brand images
        </label>
        <input
          id={inputId}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          disabled={uploading}
          className="w-full text-sm"
          onChange={(event) => {
            void upload(event.target.files);
            event.target.value = "";
          }}
        />
        <p className="mt-3 text-xs text-muted-foreground">
          PNG, JPG, or WebP · Up to 5 MB per image. Larger images are compressed when possible.
        </p>
        {uploading && (
          <p role="status" className="mt-3 flex items-center gap-2 text-sm">
            <Spinner size="sm" label={null} />
            Uploading images…
          </p>
        )}
      </div>
      <div>
        <p className="mb-4 text-sm font-medium">
          {selected.length} {selected.length === 1 ? "image" : "images"}{" "}
          selected
        </p>
        {available.length ? (
          <div className="brand-images-grid">
            {uniqueBrandImages(available).map((asset, index) => {
              const selectedIndex = selected.findIndex((image) => image.url === asset.url);
              const active = selectedIndex >= 0;
              const current = active ? selected[selectedIndex] : asset;
              const size = (asset.width && asset.height ? { width: asset.width, height: asset.height } : null) || dimensions[asset.url];
              const source = asset.originalUrl ? "Website" : asset.source === "upload" ? "Uploaded" : "Brand library";
              return <article key={asset.url} className={`brand-image-card ${active ? "is-selected" : ""}`}>
                <button type="button" aria-label={`Keep brand image ${index + 1}`} aria-pressed={active} disabled={uploading} className="brand-image-select focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
                  onClick={() => onChange(active ? selected.filter((image) => image.url !== asset.url) : [...selected, { ...asset, ...(size || {}) }])}>
                  <ImagePreview url={asset.thumbnailUrl || asset.url} alt={current.alt || `Brand image ${index + 1}`} onDimensions={asset.thumbnailUrl ? undefined : (width, height) => setDimensions((previous) => previous[asset.url]?.width === width && previous[asset.url]?.height === height ? previous : { ...previous, [asset.url]: { width, height } })} />
                  <span className={`absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full border ${active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background"}`}>{active && <Check size={14} />}</span>
                  <span className="block bg-background px-3 py-2 text-xs">Image {index + 1}</span>
                </button>
                <div className="brand-image-meta">
                  <p>{source}{size ? ` · ${size.width} × ${size.height}` : ""}{asset.sizeBytes ? ` · ${Math.ceil(asset.sizeBytes / 1024)} KB` : ""}</p>
                  {asset.originalName && <p title={asset.originalName}>{asset.originalName}</p>}
                  {asset.originalUrl && <a className="text-xs underline" href={asset.originalUrl} target="_blank" rel="noopener noreferrer">View source image</a>}
                  {active && <>
                    <label>Alt text for image {index + 1}<input value={current.alt || ""} placeholder="Describe what the image shows" maxLength={500} disabled={uploading} onChange={(event) => onChange(selected.map((image) => image.url === asset.url ? { ...image, alt: event.target.value } : image))} /></label>
                    <div className="brand-image-order"><span>Position {selectedIndex + 1}</span><button type="button" aria-label={`Move image ${index + 1} earlier`} disabled={uploading || selectedIndex === 0} onClick={() => moveImage(asset.url, -1)}>Earlier</button><button type="button" aria-label={`Move image ${index + 1} later`} disabled={uploading || selectedIndex === selected.length - 1} onClick={() => moveImage(asset.url, 1)}>Later</button></div>
                  </>}
                </div>
              </article>;
            })}
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border bg-muted/20 p-5 text-sm text-muted-foreground">
            <ImageIcon size={22} />
            <p>
              No website images found. Upload an image or continue without one.
            </p>
          </div>
        )}
      </div>
      {screenshot && (
        <div className="space-y-4 rounded-xl border bg-background p-5">
          <label
            htmlFor={screenshotId}
            className="flex items-center gap-3 text-sm font-medium"
          >
            <input
              id={screenshotId}
              type="checkbox"
              checked={keepScreenshot}
              onChange={(event) => onScreenshot(event.target.checked)}
              className="h-4 w-4 accent-violet-600"
            />
            Keep website screenshot
          </label>
          <img
            src={buildApiUrl(screenshot)}
            alt="Website screenshot for your brand toolkit"
            className="max-h-72 w-full rounded-lg object-contain"
            loading="lazy"
          />
        </div>
      )}
    </section>
  );
}
