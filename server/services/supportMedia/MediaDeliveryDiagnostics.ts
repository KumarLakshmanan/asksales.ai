/** Provider diagnostics only; never used to classify customer intent. */
export function mediaDeliveryFailureCode(error: unknown): string {
  const value = error as { errorCode?: string; code?: string; message?: string } | null;
  const code = String(value?.errorCode || value?.code || '').toUpperCase();
  const message = String(value?.message || '').toLowerCase();
  if (code === 'PROVIDER_ACCOUNT_UNBOUND') return code;
  if (code === 'META_GRAPH_190' || message.includes('authorization is no longer valid') || message.includes('invalid oauth access token')) return 'PROVIDER_AUTHORIZATION_INVALID';
  if (['META_GRAPH_3', 'META_GRAPH_10', 'META_GRAPH_200'].includes(code)
    || message.includes('application does not have the capability') || message.includes('unsupported request - method type')) return 'PROVIDER_CAPABILITY_UNAVAILABLE';
  if (message.includes('upload failed') || message.includes('upload attachment failure') || message.includes('should represent a valid url')) return 'PROVIDER_MEDIA_FETCH_FAILED';
  return 'DELIVERY_FAILED';
}

export function mediaDeliveryDiagnostics(part: Record<string, unknown>) {
  const failureCode = part.failure_code === 'DELIVERY_FAILED'
    ? mediaDeliveryFailureCode({ message: String(part.failure_reason || '') }) : String(part.failure_code || 'DELIVERY_FAILED');
  const needsAccount = ['facebook', 'instagram'].includes(String(part.channel)) && !part.provider_account_id;
  const inactive = !part.external_thread_id || part.conversation_status === 'closed';
  let summary = 'The provider did not accept this image.';
  let guidance = 'Check the conversation and connection before retrying. Only resend if the customer still needs this image.';
  let action: 'retry' | 'connection' | 'verify' | 'new_reply' = 'retry';
  if (failureCode === 'PROVIDER_AUTHORIZATION_INVALID') {
    summary = 'Meta rejected the connection token.';
    guidance = 'Review current account status in Integrations and reconnect if authorization is still invalid. Retrying this failed attempt does not repair authorization; an old error alone does not prove the connection is still broken.';
    action = 'connection';
  } else if (failureCode === 'PROVIDER_CAPABILITY_UNAVAILABLE') {
    summary = 'Meta rejected the messaging capability or transport.';
    guidance = 'Review the connected Page/account and messaging permissions in Integrations before sending a new reply.';
    action = 'connection';
  } else if (failureCode === 'PROVIDER_MEDIA_FETCH_FAILED') {
    summary = 'Meta could not fetch or upload the image.';
    guidance = 'Older failures may predate signed image URLs. Check the customer conversation before retrying; this record alone does not mean current sends are failing.';
  }
  if ((needsAccount || inactive) && action === 'retry') action = 'new_reply';
  if (part.status === 'uncertain') {
    summary = 'Delivery was not confirmed; the image may already have arrived.';
    guidance = 'Check the provider conversation and record evidence of the outcome. Do not resend until non-delivery is confirmed.';
    action = 'verify';
  }
  return { failure_code: failureCode, failure_summary: summary, recovery_guidance: guidance, recovery_action: action,
    retry_eligible: part.status === 'failed' && !needsAccount && !inactive,
    account_binding_required: needsAccount };
}
