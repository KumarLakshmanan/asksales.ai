const proposalStatusLabels: Record<string, string> = {
  draft: 'Draft', sending: 'Sending', delivery_unknown: 'Delivery needs review',
  sent: 'Sent', viewed: 'Viewed', accepted: 'Accepted', rejected: 'Declined',
  expired: 'Expired', superseded: 'Superseded',
};

export function proposalStatusLabel(status: string): string {
  return proposalStatusLabels[status] || status.replaceAll('_', ' ').replace(/^./, char => char.toUpperCase());
}
