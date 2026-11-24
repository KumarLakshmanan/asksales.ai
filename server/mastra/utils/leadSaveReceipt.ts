/** Lead counts shown to the client must be backed by exact saved identities.
 * Save-node counts may include repeated upserts of the same lead.
 */
export function readLeadSaveReceipt(value: unknown, outcome?: string): { leadIds: number[]; leadsCount: number } {
  // A provider-confirmed empty search may legitimately skip its save node.
  // Any other absent receipt is incomplete execution, not an empty result.
  if (value == null && outcome === 'succeeded_empty') return { leadIds: [], leadsCount: 0 };
  const receipt = value && typeof value === 'object' && !Array.isArray(value)
    ? value as { leadIds?: unknown; leadsCount?: unknown } : {};
  if (!Array.isArray(receipt.leadIds) && receipt.leadsCount !== 0) {
    if (Number(receipt.leadsCount) > 0) {
      throw new Error('Lead persistence reported a count without saved lead IDs. Reload saved leads before approving outreach.');
    }
    throw new Error('Lead execution returned no verifiable save receipt. Reload the workflow status before retrying.');
  }
  const rawIds = Array.isArray(receipt.leadIds) ? receipt.leadIds : [];
  const leadIds = rawIds.map(id => typeof id === 'string' && /^[1-9]\d*$/.test(id) ? Number(id) : id);
  if (leadIds.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Lead persistence returned invalid IDs. Reload saved leads before approving outreach.');
  }
  const uniqueIds = [...new Set(leadIds as number[])];
  if (Number(receipt.leadsCount) > 0 && uniqueIds.length === 0) {
    throw new Error('Lead persistence reported a count without saved lead IDs. Reload saved leads before approving outreach.');
  }
  return { leadIds: uniqueIds, leadsCount: uniqueIds.length };
}
