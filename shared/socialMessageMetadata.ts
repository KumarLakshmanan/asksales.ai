/** Durable social message provenance. Provider/account identity remains authoritative on the message and conversation. */
export interface SocialMessageMetadata extends Record<string, unknown> {
  origin?: 'ai' | 'native_app' | 'external_app' | 'api';
  replySurface?: 'message' | 'comment';
  providerAccountId?: string;
  recipient?: string;
  commentId?: string;
  postId?: string;
  parentCommentId?: string;
  sourceTurnId?: string | null;
  sourceMessageIds?: number[];
  suppressionReason?: string;
  nativeEventAt?: string;
  nativeEventType?: 'message' | 'edit' | 'revoke';
  deleted?: boolean;
}
