import { type ConfirmationRecovery } from '../../../shared/bookingConfirmationRecovery.js';
export type { ConfirmationRecovery };

export function confirmationRecoveryFor(booking: Record<string, unknown>, nowMs: number): ConfirmationRecovery {
  if (booking.status !== 'confirmed') return { state: 'not_applicable', canRetry: false };
  const metadata = booking.metadata as Record<string, unknown> | undefined;
  const state = (metadata?.hotelConfirmationRecovery || {}) as Record<string, unknown>;
  if (state.claimToken && Number(state.claimExpiresAtMs) > nowMs) return { state: 'in_progress', canRetry: false };
  if (state.alertDispatch === 'started' || state.alertDispatch === 'uncertain') {
    return { state: 'needs_review', canRetry: !state.contactReady || !state.remindersReady, step: 'alert' };
  }
  if (state.version !== 1) {
    // The old completion marker allows idempotent local recovery; it does not
    // prove delivery. Existing orchestration retains its alert as uncertain.
    return { state: 'needs_review', canRetry: Boolean(booking.side_effects_processed_at), step: 'unknown' };
  }
  if (booking.side_effects_processed_at) return { state: 'complete', canRetry: false };
  return { state: 'pending', canRetry: true, step: !state.contactReady ? 'contact'
    : !state.remindersReady ? 'reminders' : state.alertDispatch !== 'returned' ? 'alert' : 'completion' };
}
