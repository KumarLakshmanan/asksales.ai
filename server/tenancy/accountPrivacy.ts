/** These controls act only on the authenticated account. Business exports need
 * a separate authorized scope; never expand this to all privacy subroutes. */
export function isAccountPrivacyPath(path: string): boolean {
  return /^\/api\/privacy\/(?:consents|status|opt-out|opt-in|data-export)\/?$/.test(path);
}
