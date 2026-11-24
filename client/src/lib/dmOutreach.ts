export const DM_DESTINATIONS = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'twitter', label: 'X (Twitter)' },
  { value: 'whatsapp', label: 'WhatsApp' },
] as const;

export function dmOutreachPath(platform: string | undefined, message: string): string | null {
  if (!DM_DESTINATIONS.some(destination => destination.value === platform)) return null;
  return `/dashboard/outreach/${platform}/create?message=${encodeURIComponent(message)}`;
}
