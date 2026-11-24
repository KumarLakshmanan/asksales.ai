/** Internal payment responsibility is resolved by the server from the selected business.
 * The legacy header is only set by a captured billing request, never by a separate selector. */
export const BILLING_ORGANIZATION_HEADER = 'X-Billing-Organization-Id';
export function billingOrganizationHeaders(_endpoint: string, _method?: string): Record<string, string> {
  return {};
}
