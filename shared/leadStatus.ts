/** Lead pipeline states accepted by CRUD, including inbound email's replied state.
 * Engagement counters and CRM deal stages remain separate concepts.
 */
export const LEAD_STATUSES = [
  'new', 'contacted', 'replied', 'engaged', 'qualified', 'converted',
  'unqualified', 'rejected', 'lost',
] as const;

export function getLeadStatus(lead: { leadStatus?: string | null; status?: string | null }): string {
  return lead.leadStatus || lead.status || 'new';
}

export function formatLeadStatus(status: string): string {
  return status.replace(/[_-]/g, ' ').replace(/(^|\s)\S/g, letter => letter.toUpperCase());
}

/** Keep legacy/provider states selectable without treating them as new CRUD states. */
export function getLeadStatusOptions(observed: readonly string[] = []): string[] {
  return [...new Set<string>([...LEAD_STATUSES, ...observed.filter(Boolean)])];
}
