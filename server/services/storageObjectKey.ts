import path from "node:path";

export function normalizeStorageKey(key: string, allowEmpty = false): string {
  if (typeof key !== "string" || key.includes("\0"))
    throw new Error("Invalid storage key");
  const normalized = key.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    (!normalized && !allowEmpty) ||
    normalized.startsWith("/") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error("Invalid storage key");
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => segment === ".." || (!segment && normalized.length > 0),
    )
  ) {
    throw new Error("Invalid storage key");
  }
  return normalized;
}
