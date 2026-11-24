export interface StorageUsage {
  storageUsedBytes: number;
  maxStorageBytes: number;
  fileCount: number;
  usagePercent: number;
  planName: string | null;
  breakdown: Array<{ category: string; bytes: number; count: number }>;
}

export interface StorageFile {
  id: number;
  fileName: string;
  originalName: string | null;
  mimeType: string | null;
  fileSizeBytes: number;
  category: string;
  url: string | null;
  createdAt: string;
  storageKey: string;
}

export type StorageSort = "newest" | "oldest" | "name" | "size";

export const STORAGE_CATEGORIES: Record<
  string,
  { label: string; description: string }
> = {
  image: { label: "Images", description: "Generated and uploaded images" },
  video: { label: "Videos", description: "Generated and uploaded videos" },
  audio: { label: "Audio", description: "Music, recordings, and audio files" },
  content_asset: {
    label: "Content assets",
    description: "Files created for your content",
  },
  brand_asset: {
    label: "Brand assets",
    description: "Logos and brand resources",
  },
  knowledge_base: {
    label: "Knowledge base",
    description: "Resources used by your agents",
  },
  actor_output: {
    label: "Actor outputs",
    description: "Results organized by actor run",
  },
  document: {
    label: "Documents",
    description: "Documents, spreadsheets, and data",
  },
  support_media: {
    label: "Support attachments",
    description: "Files from support conversations",
  },
  lead_import: {
    label: "Lead imports",
    description: "Files uploaded to import leads",
  },
  general: { label: "Other files", description: "Additional workspace files" },
};

export function storageCategoryLabel(category: string): string {
  return (
    STORAGE_CATEGORIES[category]?.label ||
    category.replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase())
  );
}

export function formatStorageBytes(value: number): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(
    Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))),
    units.length - 1,
  );
  return `${Number((bytes / 1024 ** index).toFixed(2))} ${units[index]}`;
}

export function storageFileName(file: StorageFile): string {
  return file.originalName || file.fileName;
}

export function storageFileType(file: StorageFile): string {
  const extension = storageFileName(file).split(".").pop();
  if (extension && extension !== storageFileName(file) && extension.length <= 8)
    return extension.toUpperCase();
  const mime = file.mimeType?.split("/")[1]?.split(";")[0];
  return (
    (
      { plain: "TXT", jpeg: "JPG", mpeg: "MP3", "svg+xml": "SVG" } as Record<
        string,
        string
      >
    )[mime || ""] || (mime && mime.length <= 8 ? mime.toUpperCase() : "File")
  );
}

export function actorFolderName(folder: string): string {
  const parts = folder.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : folder;
}

export function actorRunName(folder: string): string {
  return folder.split("/").pop() || folder;
}

export function storageCapacity(usage: StorageUsage) {
  const used = Math.max(0, Number(usage.storageUsedBytes) || 0);
  const limit = Math.max(0, Number(usage.maxStorageBytes) || 0);
  const unlimited = limit >= Number.MAX_SAFE_INTEGER;
  const percent = unlimited
    ? 0
    : limit > 0
      ? (used / limit) * 100
      : used > 0
        ? 100
        : 0;
  return {
    used,
    limit,
    unlimited,
    percent,
    remaining: Math.max(0, limit - used),
  };
}
