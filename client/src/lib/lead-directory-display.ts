export const optionalLeadColumns = [
  { key: 'role', label: 'Role' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'source', label: 'Source' },
] as const;

export type OptionalLeadColumn = typeof optionalLeadColumns[number]['key'];

// Only presentation identifiers are saved here, never lead or tenant data.
export const leadColumnPreferenceKey = 'asksales.leads.optional-columns.v1';

export function parseLeadColumnPreferences(value: string | null): OptionalLeadColumn[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    return Array.isArray(parsed)
      ? optionalLeadColumns.filter(column => parsed.includes(column.key)).map(column => column.key)
      : [];
  } catch {
    return [];
  }
}

export function leadSourceLabel(source: string | null | undefined): string {
  if (!source) return '—';
  const labels: Record<string, string> = {
    crm_import: 'CRM import', crm_sync: 'CRM sync', csv_import: 'CSV import',
    manual: 'Manual entry', manual_entry: 'Manual entry', linkedin: 'LinkedIn',
    twitter: 'Twitter / X', whatsapp: 'WhatsApp', justdial: 'JustDial',
    'google-maps': 'Google Maps', 'lead generation': 'Lead Generation Agent',
  };
  return labels[source.toLowerCase()] || source.replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}
