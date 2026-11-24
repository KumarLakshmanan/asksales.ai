/** Score persisted profile fields, not model confidence or purchase likelihood. */
export const ICP_SCORABLE_FIELDS = [
  'campaignName', 'campaignObjective', 'targetAudience', 'summary',
  'industry', 'subIndustry', 'targetCompanySizeRange', 'targetBusinessModel',
  'targetRevenueRange', 'primaryRegions', 'primaryJobTitles',
  'budgetRange', 'primaryChannels', 'primaryValueProposition', 'primaryPainPoint',
] as const;

export function getIcpCompleteness(icp: object) {
  const record = icp as Record<string, unknown>;
  const isFilled = (field: string) => {
    const value = record[field];
    if (value == null || value === '') return false;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return typeof value === 'number' || typeof value === 'boolean';
  };
  const filledFields = ICP_SCORABLE_FIELDS.filter(isFilled);
  const missingFields = ICP_SCORABLE_FIELDS.filter(field => !isFilled(field));
  return { filledFields, missingFields, totalFields: ICP_SCORABLE_FIELDS.length, score: Math.round(filledFields.length / ICP_SCORABLE_FIELDS.length * 100) };
}

export function icpDraftReceipt(icp: { revision?: number; fitScore?: number }) {
  return `Saved ICP draft${icp.revision ? ` revision ${icp.revision}` : ''} with a **${icp.fitScore ?? 0}% completeness score**. Review the profile before approving it. This score measures filled profile fields, not predicted campaign performance; saving the draft has not started a lead search or outreach.`;
}
