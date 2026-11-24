/** Provider callbacks may be duplicated or arrive in reverse order. */
const deliveryPriority: Record<string, number> = {
  pending: 0, queued: 0, sending: 1, sent: 2, delivered: 3, read: 4,
  failed: 5, bounced: 5, complained: 5,
};

export function deliveryStatusesProtectedFrom(incomingStatus: string): string[] {
  const priority = deliveryPriority[incomingStatus];
  if (priority === undefined) return [];
  return Object.entries(deliveryPriority).filter(([, rank]) => rank > priority).map(([status]) => status);
}
