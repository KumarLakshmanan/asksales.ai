import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shared by upload serving and storage, in both source and bundled builds. */
export function localStoragePath(moduleUrl = import.meta.url, configured = process.env.LOCAL_STORAGE_PATH || ''): string {
  if (configured.trim()) return path.resolve(configured);
  let root = path.dirname(fileURLToPath(moduleUrl));
  if (path.basename(root) === 'utils') root = path.dirname(root);
  if (path.basename(root) === 'dist') root = path.dirname(root);
  return path.join(root, 'uploads');
}
