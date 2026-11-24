/** Read-only activity. Authority review never authorizes delivery or rewrites its recorded status. */
export interface FollowUpAuthorityReview {
  reason: string | null;
  origin: { table: 'sent_messages' | 'outreach_messages'; messageId: number | null; step: number | null; userId: number | null; businessProfileId: number | null };
  /** Only persisted snapshot fields; null means unavailable, never the current reader. */
  identity: { userId: number | null; businessProfileId: number | null; businessActorUserId: number | null; billingOrganizationId: number | null; billingActorUserId: number | null };
}
export interface FollowUpActivity {
  id: number; activityKey: string; kind: 'conversation' | 'historical' | 'configured_outbox';
  channel: string; leadName: string | null; subject: string | null; message: string;
  status: string; deliveryStatus: string | null; followUpStep: number | null;
  sentAt: string | null; createdAt: string | null; scheduledAt: string | null;
  /** Recorded native/tracking ID, not by itself proof of delivery. Never the original SMS receipt for a held follow-up. */
  recordedMessageId: string | null;
  authorityReview: FollowUpAuthorityReview | null;
}
