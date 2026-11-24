/** Read-only provider measurements. Unlike units must never share a token counter. */
export interface AdminUserUsageResponse {
  success: true;
  userId: number;
  days: number;
  dateRange: { start: string; end: string };
  usage: {
    openai?: { totalCalls: number; totalTokens: number; estimatedCostCents: number };
    apify?: { totalRuns: number; totalItemsScraped: number; totalCostCents: number };
    gemini?: { totalRequests: number; totalInputTokens: number; totalOutputTokens: number; totalCostCents: number };
    zerobounce?: { totalRequests: number; totalEmailsValidated: number; totalCostCents: number };
  };
  totals: { totalApiCalls: number; totalCostCents: number };
}
