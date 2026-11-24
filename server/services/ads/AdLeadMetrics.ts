export function measuredLeads(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.leads != null && Number.isFinite(Number(row.leads)) && Number(row.leads) >= 0) return Number(row.leads);
  if (Array.isArray(row.actions)) {
    return row.actions.reduce((largest: number, item: unknown) => {
      if (!item || typeof item !== 'object') return largest;
      const action = item as Record<string, unknown>;
      const type = String(action.action_type || '');
      const isLead = type === 'lead' || type.endsWith('.lead') || ['onsite_conversion.lead_grouped', 'offsite_lead_add_20_s_calls'].includes(type);
      return isLead && Number.isFinite(Number(action.value)) ? Math.max(largest, Number(action.value)) : largest;
    }, 0);
  }
  for (const key of ['insights', 'raw_data', 'source']) {
    const result = measuredLeads(row[key]);
    if (result !== null) return result;
  }
  return null;
}

