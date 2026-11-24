import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getCandidateServerRoots(): string[] {
  return [
    path.join(process.cwd(), 'server'),
    process.cwd(),
    path.join(__dirname, '..'),
    path.join(__dirname, '..', '..'),
  ];
}

export function resolveServerDataPath(...parts: string[]): string {
  const roots = Array.from(new Set(getCandidateServerRoots()));

  for (const root of roots) {
    const candidate = path.join(root, 'data', ...parts);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(roots[0], 'data', ...parts);
}

export function resolveWorkflowsDir(): string {
  return resolveServerDataPath('workflows');
}

export function resolveActorsDir(): string {
  return resolveServerDataPath('actors');
}

export function resolveWorkflowPath(workflowName: string): string {
  return resolveServerDataPath('workflows', `${workflowName}.json`);
}