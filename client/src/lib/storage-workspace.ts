import { api, buildApiUrl } from "./api";
import { businessProfileHeaders } from "./business-profile";
import type { StorageFile, StorageUsage, StorageSort } from "./storage";
import { fetchWithReadRetry } from "./api-client";

export interface WorkspaceFile extends StorageFile {
  businessProfileId: number | null;
  updatedAt: string;
  referenceType: string | null;
  referenceId: string | null;
  workspace: {
    trashedAt?: string;
    uploadedByUserId?: number | null;
    tags?: string[];
    collection?: string;
    events?: Array<{ action: string; at: string; actorUserId: number }>;
  };
  source: { label: string; href: string | null } | null;
  dependency: { linked: boolean; needsReview: boolean; message: string };
}
export interface WorkspaceUsage extends StorageUsage {
  activeCount: number;
  activeBytes: number;
  trashCount: number;
  trashBytes: number;
  collections: string[];
  businessProfileId: number | null;
  businessName?: string;
  retentionDays: number;
}
export interface StorageFilters {
  view: "files" | "trash" | "cleanup" | "activity" | "folders";
  category: string;
  search: string;
  sort: StorageSort;
  type: string;
  after: string;
  before: string;
  minSize: string;
  maxSize: string;
  tag: string;
  collection: string;
  folder: string;
  cleanup: "large" | "old" | "unlinked";
}
export const DEFAULT_STORAGE_FILTERS: StorageFilters = {
  view: "files",
  category: "",
  search: "",
  sort: "newest",
  type: "all",
  after: "",
  before: "",
  minSize: "",
  maxSize: "",
  tag: "",
  collection: "",
  folder: "",
  cleanup: "large",
};
export function storageFiltersFromUrl(search: string): StorageFilters {
  const params = new URLSearchParams(search),
    result = { ...DEFAULT_STORAGE_FILTERS };
  for (const key of Object.keys(result) as Array<keyof StorageFilters>) {
    const value = params.get(key);
    if (value !== null) (result as Record<string, string>)[key] = value;
  }
  if (
    !["files", "trash", "cleanup", "activity", "folders"].includes(result.view)
  )
    result.view = "files";
  if (!["newest", "oldest", "name", "size"].includes(result.sort))
    result.sort = "newest";
  if (!["all", "image", "video", "audio", "document"].includes(result.type))
    result.type = "all";
  if (!["large", "old", "unlinked"].includes(result.cleanup))
    result.cleanup = "large";
  return result;
}
export function storageQuery(filters: StorageFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value && value !== DEFAULT_STORAGE_FILTERS[key as keyof StorageFilters])
      params.set(key, value);
  return params;
}
export function storageHeaders(): Headers {
  const headers = new Headers(businessProfileHeaders());
  const token =
    typeof window === "undefined" ? null : localStorage.getItem("token");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}
export async function storageBlob(
  id: number,
  thumbnail = false,
  signal?: AbortSignal,
) {
  const response = await fetchWithReadRetry(
    buildApiUrl(
      `/api/settings/storage/workspace/files/${id}/${thumbnail ? "thumbnail" : "content?inline=true"}`,
    ),
    { credentials: "include", headers: storageHeaders(), signal },
  );
  if (!response.ok) throw new Error("This file could not be loaded.");
  return response.blob();
}
export async function downloadStorageFiles(fileIds: number[], signal?: AbortSignal) {
  const result = await api.post<{ url: string }>(
    "/api/settings/storage/workspace/download",
    { fileIds },
    { signal },
  );
  if (signal?.aborted) return;
  const link = document.createElement("a");
  link.href = buildApiUrl(result.url);
  link.referrerPolicy = "no-referrer";
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}
export function storageFileDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
export function previewable(file: StorageFile) {
  return (
    /^(image|video|audio|text)\//.test(file.mimeType || "") ||
    /json|pdf/.test(file.mimeType || "")
  );
}
