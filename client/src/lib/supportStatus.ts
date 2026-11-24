export function formatSupportTicketStatus(status: string): string {
  return status.replaceAll("_", " ");
}
