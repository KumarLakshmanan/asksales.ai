import type { KnowledgePurpose } from '../knowledge/types.js';

export type MediaIntent = 'none' | 'helpful' | 'explicit';

export interface MediaQuery {
  tenantId: number;
  businessProfileId?: number | null;
  conversationId?: number;
  purpose: KnowledgePurpose;
  channel: string;
  audience: 'customer' | 'internal';
  redactedText: string;
  intent?: string;
  entities?: Record<string, string | string[]>;
  mediaIntent: MediaIntent;
  limit: 5;
}

export interface MediaEvidence {
  evidenceId: string;
  galleryId: number;
  galleryVersionId: number;
  assetId: number;
  name: string;
  ownerDescription?: string;
  altText: string;
  entityTags: string[];
  score: number;
}

export interface MediaRetrievalResult {
  intent: MediaIntent;
  status: 'selected' | 'none' | 'insufficient' | 'unavailable' | 'access_denied';
  evidence: MediaEvidence[];
  reason: string;
  diagnostics: { queryFingerprint: string; candidateCount: number; latencyMs: number };
}

export interface SupportMediaDecision {
  intent: MediaIntent;
  reason: string;
  selections: Array<{ evidenceId: string; caption?: string; order: number }>;
}

export interface VerifiedSupportMedia {
  evidenceId: string;
  assetId: number;
  galleryId: number;
  galleryVersionId: number;
  name: string;
  caption?: string;
  altText: string;
  checksum: string;
  derivativeStorageFileId: number;
  mimeType: string;
  intent: Exclude<MediaIntent, 'none'>;
}

export interface DeliveryManifest {
  text: string;
  media: Array<{
    assetId: number;
    evidenceId: string;
    kind: 'image';
    caption?: string;
    altText: string;
    order: number;
  }>;
}
