/** Per-competitor visibility metrics computed by CompetitorIntelligenceService. */
export interface CompetitorVisibilityMetrics {
  mentions: number;
  mentionRate: number | null;
  shareOfVoice: number | null;
  promptWins: number;
  promptWinRate: number | null;
  citationCount: number;
  citationShare: number | null;
  crawledPages: number;
  schemaCoverage: number | null;
  contentTypes: Record<string, number>;
}

/** A reviewer's correction to an extracted provider answer. */
export interface ExtractionCorrection {
  brandMentioned?: boolean;
  brandRank?: number | null;
  sentiment?: 'positive' | 'neutral' | 'negative' | null;
  competitors?: string[];
  recommendationReason?: string | null;
  exclusionReason?: string | null;
}
