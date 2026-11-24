import { creatorSessionScope } from './creator-session';

export type YouTubeUploadCheckpoint = {
  version: 1;
  scope: string;
  sessionToken: string;
  expiresAt: string;
  credentialId: number;
  file: { name: string; size: number; type: string; lastModified: number };
  details: { title: string; description: string; privacyStatus: 'private' | 'unlisted' | 'public'; publishAt: string };
  uploadedBytes: number;
  videoId?: string;
};
const key = () => `youtube-upload:v1:${creatorSessionScope()}`;
export function loadYouTubeUploadCheckpoint(): YouTubeUploadCheckpoint | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key()) || 'null') as YouTubeUploadCheckpoint | null;
    return saved?.version === 1 && saved.scope === creatorSessionScope() && typeof saved.sessionToken === 'string'
      && saved.sessionToken.length > 0 && Number.isSafeInteger(saved.credentialId) && saved.credentialId > 0
      && Number.isSafeInteger(saved.file?.size) && saved.file.size > 0 && typeof saved.file.name === 'string'
      && Number.isSafeInteger(saved.uploadedBytes) && saved.uploadedBytes >= 0 && saved.uploadedBytes <= saved.file.size
      && typeof saved.details?.title === 'string' && Number.isFinite(Date.parse(saved.expiresAt)) ? saved : null;
  } catch { return null; }
}
export function saveYouTubeUploadCheckpoint(value: YouTubeUploadCheckpoint) {
  if (value.scope !== creatorSessionScope()) throw new Error('The business changed. Return to the original business to recover this upload.');
  sessionStorage.setItem(key(), JSON.stringify(value));
}
export function clearYouTubeUploadCheckpoint(value: YouTubeUploadCheckpoint) {
  if (value.scope === creatorSessionScope()) sessionStorage.removeItem(key());
}
export function acknowledgedYouTubeOffset(value: unknown, length: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > length) {
    throw new Error('YouTube returned an invalid upload offset. Check upload status before continuing.');
  }
  return value;
}
export function matchesYouTubeUploadFile(saved: YouTubeUploadCheckpoint['file'], file: File) {
  return saved.name === file.name && saved.size === file.size && saved.type === file.type && saved.lastModified === file.lastModified;
}
