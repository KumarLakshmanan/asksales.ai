/** Customer-facing analytics contracts. Provider expenditure is deliberately absent. */
export const INSIGHT_CHANNELS = ['all', 'whatsapp', 'instagram', 'facebook', 'email', 'sms', 'widget', 'workspace', 'unattributed'] as const;
export type InsightChannel = typeof INSIGHT_CHANNELS[number];
export type InsightInterval = 'daily' | 'weekly' | 'monthly';
export type InsightConversationKind = 'outreach' | 'widget' | 'workspace';
export interface InsightConversationRef { kind: InsightConversationKind; id: number }
export interface InsightsQuery {
  from: string;
  to: string;
  timezone: string;
  interval: InsightInterval;
  channel: InsightChannel;
  process?: string;
  provider?: string;
  model?: string;
}
export interface InsightCoverage {
  status: 'complete' | 'partial' | 'unsupported' | 'restricted';
  notes: string[];
}
/** Decimal strings retain the ledger's precision. INR is null when rates are unknown. */
export interface InsightCharge { credits: string; inr: string | null; unvaluedCredits: string }
export interface InsightBreakdown extends InsightCharge { key: string; label: string; count: number }
export interface InsightTrend extends InsightCharge {
  bucket: string;
  total: number;
  series: Record<string, number>;
}
export interface InsightMoney { currency: string; amount: string }
export interface WorkspaceInsights {
  query: InsightsQuery;
  generatedAt: string;
  capabilities: { supported: string[]; unsupported: string[] };
  dataCoverage: { instrumentationStartedAt: string | null; historicalUsage: InsightCoverage; paymentEvidence: InsightCoverage };
  channels: Array<{ key: InsightChannel; label: string }>;
  filters: { processes: string[]; providers: string[]; models: string[] };
  costs: InsightCoverage & {
    deductions: InsightCharge;
    refunds: InsightCharge;
    net: InsightCharge;
    byProcess: InsightBreakdown[];
    byChannel: InsightBreakdown[];
    byModel: InsightBreakdown[];
    trend: InsightTrend[];
    conversationCharge: InsightCharge;
    averageConversationInr: string | null;
    chargedConversations: number;
    followUpCharge: InsightCharge;
  };
  conversations: InsightCoverage & {
    total: number;
    averageMessages: number | null;
    averageDurationSeconds: number | null;
    durationSamples: number;
    byChannel: InsightBreakdown[];
    trend: InsightTrend[];
  };
  performance: InsightCoverage & {
    calls: number;
    successfulCalls: number;
    failedCalls: number;
    pendingCalls: number;
    successRate: number | null;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
    media: { images: number; videos: number; audio: number; embeddings: number };
    latencyP50Ms: number | null;
    latencyP95Ms: number | null;
    byKind: InsightBreakdown[];
    trend: InsightTrend[];
    tools: {
      calls: number;
      pending: number;
      successRate: number | null;
      byName: InsightBreakdown[];
      trend: InsightTrend[];
    };
  };
  messages: InsightCoverage & {
    incoming: number;
    outgoing: number;
    failed: number;
    followUps: number;
    audio: number;
    trend: InsightTrend[];
  };
  engagement: InsightCoverage & {
    activeContacts: number;
    engagedCrmContacts: number;
    outreachReplyRate: number | null;
    responseCoverage: number | null;
    averageResponseSeconds: number | null;
    peakHours: Array<{ weekday: number; hour: number; count: number }>;
    topContacts: Array<{ key: string; contactId: number | null; name: string; channel: string; incoming: number; outgoing: number; conversations: number }>;
  };
  sales: InsightCoverage & {
    moneyCoverage: InsightCoverage;
    newContacts: number;
    convertedContacts: number;
    linkedConversions: number;
    conversionRate: number | null;
    confirmedBookings: number;
    cancelledBookings: number;
    unattributedOutcomes: number;
    dealValue: InsightMoney[];
    bookingValue: InsightMoney[];
    paymentsReceived: InsightMoney[];
    paymentsRefunded: InsightMoney[];
    netPayments: InsightMoney[];
    byChannel: InsightBreakdown[];
    trend: InsightTrend[];
  };
}
export type InsightDetailKind = 'usage' | 'charges' | 'conversations' | 'tools' | 'sales';
export interface InsightDetail {
  id: string;
  occurredAt: string;
  title: string;
  kind: string;
  channel: string;
  process?: string | null;
  provider?: string | null;
  model?: string | null;
  status?: string;
  conversation?: InsightConversationRef | null;
  contactId?: number | null;
  tokens?: number;
  durationMs?: number | null;
  credits?: string;
  inr?: string | null;
  amount?: string | null;
  currency?: string | null;
  evidence?: string | null;
}
export interface InsightDetailsResponse { items: InsightDetail[]; nextCursor: string | null }
export const INSIGHT_CHANNEL_LABELS: Record<InsightChannel, string> = {
  all: 'All platforms', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Messenger',
  email: 'Email', sms: 'SMS', widget: 'Website widget', workspace: 'Workspace AI', unattributed: 'Unattributed',
};
