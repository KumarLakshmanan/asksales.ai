/** Public workflow status. Never expose claim tokens or arbitrary booking metadata. */
export interface ConfirmationRecovery {
  state: 'not_applicable' | 'complete' | 'pending' | 'in_progress' | 'needs_review';
  canRetry: boolean;
  step?: 'contact' | 'reminders' | 'alert' | 'completion' | 'unknown';
}
