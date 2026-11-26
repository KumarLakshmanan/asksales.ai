/**
 * What a customer sees when a lead search saved nothing. Provider, credential
 * and workflow-node details stay in the execution log for administrators.
 */
export function leadSearchFailureMessage(providerError?: string): string {
  const text = providerError || '';
  const reason = /api key|token|credential|unauthori[sz]ed|forbidden|billing|capacity|quota|plan limit/i.test(text)
    ? 'The lead data provider is not available right now. Please try again later, or contact support if this continues.'
    : /rate limit|too many requests|timed? ?out|timeout/i.test(text)
      ? 'The lead data provider is busy. Please try again in a few minutes.'
      : 'Please try again. If it keeps failing, contact support.';
  return `The lead search could not run, so no leads were saved. ${reason}`;
}
