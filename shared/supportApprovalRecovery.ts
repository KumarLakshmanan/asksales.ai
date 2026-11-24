/** Public recovery diagnostics contain no protected payload or provider error. */
export const APPROVAL_RESUME_BLOCKED_MESSAGE = 'Protected approval data could not be verified. Check support encryption configuration and review any existing execution before retrying.';

export interface ApprovalResumeRecoveryItem {
  id: number;
  threadId: number | null;
  toolName: string;
  status: string;
  resumeStatus: string;
  expiresAt: string | null;
  updatedAt: string;
  message: string;
}
