export interface PlatformPublicationOutcome { status: string; error?: string }

/** Aggregate only observed states; created and queued are never activation receipts. */
export function summarizeAdPublication(outcomes: PlatformPublicationOutcome[]) {
  const progress = new Set(['queued', 'running', 'active', 'provider_created']);
  const successful = outcomes.filter(outcome => progress.has(outcome.status));
  const pending = outcomes.some(outcome => ['queued', 'running'].includes(outcome.status));
  let status: string;
  if (outcomes.length === 0) status = 'failed';
  else if (successful.length === 0) {
    status = outcomes.every(outcome => outcome.status === 'gated') ? 'gated'
      : outcomes.every(outcome => ['blocked', 'gated'].includes(outcome.status)) ? 'blocked' : 'failed';
  } else if (successful.length !== outcomes.length) status = 'partial_success';
  else if (outcomes.some(outcome => outcome.status === 'running')) status = 'running';
  else if (pending) status = 'queued';
  else if (outcomes.every(outcome => outcome.status === 'active')) status = 'active';
  else if (outcomes.every(outcome => outcome.status === 'provider_created')) status = 'provider_created';
  else status = 'partial_success';
  const message = status === 'active'
    ? 'Saved provider receipts confirm activation on each selected platform.'
    : status === 'provider_created'
      ? 'Provider resources were created. Live activation is not confirmed; review each platform before taking further action.'
      : pending
        ? 'Some provider actions are queued or running. Review each platform; queued work is not proof of activation.'
        : successful.length > 0
          ? 'Platform outcomes differ. Review the saved creation, activation, and failure receipts below.'
          : 'No selected platform was launched. Review the per-platform reason before retrying.';
  return { status, pending, success: successful.length > 0, message };
}
