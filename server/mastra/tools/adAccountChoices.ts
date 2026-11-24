import { asRecord as record } from '../../../shared/records.js';
import { trimmedTextOrUndefined as text } from '../../utils/optionalText.js';

/** Allowlist only review fields. Never return credential objects or page tokens. */
export function metaAccountChoices(configValue: unknown, selectedValue: unknown) {
  const config = record(configValue);
  const selected = record(selectedValue);
  const selectedAccountId = text(selected.adAccountId) ?? text(config.adAccountId);
  const selectedPageId = text(selected.pageId) ?? text(config.pageId);
  const candidates = Array.isArray(config.adAccounts) ? [...config.adAccounts] : [];
  if (selectedAccountId) candidates.push({ id: selectedAccountId, name: selected.adAccountName,
    currency: selected.adAccountCurrency, timezone_name: selected.adAccountTimezone });
  const accounts = new Map<string, { id: string; name?: string; currency?: string; timezone?: string; selected: boolean }>();
  for (const value of candidates) {
    const candidate = record(value);
    const id = text(candidate.id);
    if (!id || accounts.has(id)) continue;
    accounts.set(id, { id, name: text(candidate.name), currency: text(candidate.currency),
      timezone: text(candidate.timezone_name), selected: id === selectedAccountId });
  }
  const pageCandidates = Array.isArray(config.pages) ? [...config.pages] : [];
  if (selectedPageId) pageCandidates.push({ id: selectedPageId, name: selected.pageName });
  const pages = new Map<string, { id: string; name?: string; selected: boolean }>();
  for (const value of pageCandidates) {
    const candidate = record(value);
    const id = text(candidate.id);
    if (id && !pages.has(id)) pages.set(id, { id, name: text(candidate.name), selected: id === selectedPageId });
  }
  return { accounts: [...accounts.values()], pages: [...pages.values()],
    selectedAccountId: selectedAccountId ?? null, selectedPageId: selectedPageId ?? null,
    source: 'saved_connection', providerVerified: false,
    note: 'These are saved account choices, not live eligibility confirmation. Ask the client to choose; verify provider readiness again before activation.' };
}

/** Google currently stores one selected customer, not a discoverable inventory. */
export function googleAccountChoices(value: unknown): ReturnType<typeof metaAccountChoices> {
  const config = record(value);
  const id = text(config.customerId);
  return {
    accounts: id ? [{ id, name: text(config.accountName), currency: text(config.currency),
      timezone: text(config.timeZone), selected: true }] : [],
    pages: [], selectedAccountId: id ?? null, selectedPageId: null,
    source: 'saved_connection', providerVerified: false,
    note: 'Only the configured Google Ads customer is shown, not all accessible accounts. Confirm this selection with the client and verify live provider readiness before activation.',
  };
}
