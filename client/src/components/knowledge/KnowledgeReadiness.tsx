export interface KnowledgeReadiness {
  status: string;
  versionId: number;
  versionNo: number;
  isLive: boolean;
  privacyClassification: string;
  chunkCount: number;
  embeddedChunkCount: number;
  activeIndexId: number | null;
  embeddingModel: string | null;
  lexicalIndexStatus: string;
  semanticIndexStatus: string;
}

export const readinessLabels: Record<string, string> = {
  privacy_blocked: 'Blocked by privacy review', safety_blocked: 'Blocked by safety review',
  partially_blocked: 'Some chunks blocked by privacy or safety rules', not_published: 'Not published',
  expired: 'Expired', scheduled: 'Scheduled', not_indexed: 'Indexing required', available: 'Published evidence',
};

export function KnowledgeReadinessDetails({ readiness }: { readiness: KnowledgeReadiness }) {
  const blocked = ['privacy_blocked', 'safety_blocked', 'partially_blocked'].includes(readiness.status);
  return <div className="space-y-1 text-xs text-muted-foreground">
    <p className={blocked ? 'font-medium text-destructive' : ''}>{readinessLabels[readiness.status] || readiness.status}</p>
    <p>{readiness.isLive ? 'Stored live version' : 'Latest version'}: v{readiness.versionNo} · Privacy: {readiness.privacyClassification}</p>
    <p>Keyword index: {readiness.lexicalIndexStatus} · Semantic index: {readiness.semanticIndexStatus}</p>
    <p>{readiness.embeddedChunkCount}/{readiness.chunkCount} chunks embedded in {readiness.activeIndexId ? `active index ${readiness.activeIndexId}` : 'an unavailable active index'}.</p>
    {blocked && <p>Indexing does not grant retrieval access. Review the source for personal or unsafe content, correct or replace it, then rebuild the index and review the new version before publishing. Reprocessing may keep it blocked. Changing audience alone cannot clear this block.</p>}
  </div>;
}
