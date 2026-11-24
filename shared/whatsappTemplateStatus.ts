/** Meta uses NONE when a template has no rejection feedback. */
export function whatsappTemplateRejectionReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  return reason && reason.toUpperCase() !== 'NONE' ? reason : null;
}
