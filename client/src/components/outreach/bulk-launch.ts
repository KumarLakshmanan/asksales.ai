export interface BulkOutreachResult {
  success: boolean;
  total: number;
  queued: number;
  errors: number;
  uncertain?: number;
  inProgress?: boolean;
  attachmentSourceMessageId?: number;
  /** The tracking record for this launch; opens its Message tracking page. */
  batchId?: string;
  results?: Array<{
    leadId: number;
    conversationId: number;
    messageId: number;
    status: "queued" | "error" | "uncertain";
    error?: string;
  }>;
}

export interface BulkLaunchAttempt {
  fingerprint: string;
  idempotencyKey: string;
}

/**
 * Reuse the same idempotency key while retrying an identical campaign payload.
 * Editing recipients or content produces a new attempt automatically.
 */
export function prepareBulkLaunch<T extends Record<string, unknown>>(
  channel: string,
  messages: T[],
  previous: BulkLaunchAttempt | null,
  providerAccountId?: string,
  options: { creationVersion?: 1; outreachName?: string; preparedOutreachId?:string; useSavedFollowUpSettings?: true; followUpSource?: 'outreach'; campaignManualReviewId?: string; scheduledAt?: string; whatsappOptInConfirmed?: boolean; attachments?: string[]; attachmentSourceMessageId?: number; brandToolkitId?: number } = {},
): {
  attempt: BulkLaunchAttempt;
  payload: {
    channel: string;
    providerAccountId?: string;
    messages: T[];
    idempotencyKey: string;
    confirmation: { confirmed: true; channel: string; recipientCount: number };
    creationVersion?: 1;
    /** Shown on the Message tracking pages; the server makes a name when this is empty. */
    outreachName?: string;
    preparedOutreachId?:string;
    useSavedFollowUpSettings?: true;
    followUpSource?: 'outreach';
    campaignManualReviewId?: string;
    scheduledAt?: string;
    whatsappOptInConfirmed?: boolean;
    attachments?: string[];
    attachmentSourceMessageId?: number;
    /** Brand saved on this outreach; its follow-ups keep it even if the default brand changes. */
    brandToolkitId?: number;
  };
} {
  const fingerprint = JSON.stringify({ channel, messages, providerAccountId, options });
  const attempt = previous?.fingerprint === fingerprint
    ? previous
    : { fingerprint, idempotencyKey: crypto.randomUUID() };

  return {
    attempt,
    payload: {
      ...options,
      channel,
      ...(providerAccountId ? { providerAccountId } : {}),
      messages,
      idempotencyKey: attempt.idempotencyKey,
      confirmation: { confirmed: true, channel, recipientCount: messages.length },
    },
  };
}

