export type KnowledgePurpose =
  | 'support_answer'
  | 'outreach_reply'
  | 'content_draft'
  | 'proposal'
  | 'hotel_policy'
  | 'internal_assist';

export type KnowledgeAudience = 'customer' | 'internal';
export type KnowledgeRisk = 'low' | 'medium' | 'high' | 'transactional';

export interface KnowledgeQuery {
  tenantId: number;
  businessProfileId?: number | null;
  purpose: KnowledgePurpose;
  channel: string;
  audience: KnowledgeAudience;
  /** Must already be privacy-processed; the gateway applies a second boundary. */
  redactedText: string;
  /** Untrusted translated search terms only; never evidence or authorization. */
  retrievalText?: string;
  redactedHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  intent?: string;
  entities?: {
    product?: string;
    productVersion?: string;
    device?: string;
    errorCodes?: string[];
    locale?: string;
  };
  risk: KnowledgeRisk;
}

export interface KnowledgeEvidence {
  evidenceId: string;
  documentId: number;
  versionId: number;
  chunkId: string;
  title: string;
  sectionPath?: string[];
  page?: number;
  sourceUrl?: string;
  /** Exact public contact values verified against a server-owned business catalog before publication. */
  verifiedBusinessContacts?: string[];
  excerpt: string;
  authority: string;
  effectiveAt?: string;
  expiresAt?: string;
  scores: {
    lexical?: number;
    vector?: number;
    fused: number;
    reranker?: number;
  };
}

export type KnowledgeRetrievalStatus =
  | 'sufficient'
  | 'insufficient'
  | 'unavailable'
  | 'conflict_detected'
  | 'stale_only'
  | 'access_denied';

export interface KnowledgeRetrievalResult {
  status: KnowledgeRetrievalStatus;
  evidence: KnowledgeEvidence[];
  indexVersion: string;
  diagnostics: {
    queryFingerprint: string;
    candidateCount: number;
    reranked: boolean;
    latencyMs: number;
    degraded?: boolean;
    reason?: string;
  };
}

export interface ClaimEvidence {
  claimId: string;
  claim: string;
  origin: 'knowledge' | 'tool' | 'reference' | 'general';
  evidenceIds: string[];
  verdict: 'supported' | 'unsupported' | 'conflicting';
}

export interface KnowledgeContextLanes {
  /** Immutable platform-owned safety and policy instructions. */
  platformSafety?: string[];
  /** Versioned tenant/persona instructions; never treated as factual evidence. */
  personaInstructions?: string[];
  /** Privacy-processed conversation data. */
  redactedConversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  knowledge?: KnowledgeRetrievalResult;
  operationalFacts?: Array<{ source: string; value: unknown; confirmed: boolean }>;
  referenceEvidence?: Array<{ source: string; excerpt: string }>;
  channelRules?: string[];
}

export type AnswerGroundingStatus = 'grounded' | 'partially_grounded' | 'not_required' | 'blocked';

export interface VerifiedKnowledgeAnswer {
  answerGrounding: AnswerGroundingStatus;
  claims: ClaimEvidence[];
  unsupportedClaims: string[];
  mayDeliver: boolean;
  reason?: string;
}
