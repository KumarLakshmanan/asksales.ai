export function isPageChunkError(error?: Error | null): boolean {
  return Boolean(error && /ChunkLoadError|Loading (?:CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i.test(`${error.name}: ${error.message}`));
}

export function reloadCurrentPage() {
  window.location.reload();
}
