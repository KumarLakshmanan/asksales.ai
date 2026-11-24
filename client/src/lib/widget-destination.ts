export function widgetDestination(toolName: string, values: Record<string, unknown> = {}): { href: string; label: string } | null {
  if (toolName === 'send_outreach_messages' || toolName === 'send_proposal') {
    const channel = typeof values.channel === 'string' ? values.channel.toLowerCase() : '';
    const path = ['email', 'sms', 'whatsapp', 'instagram', 'facebook', 'linkedin', 'twitter'].includes(channel)
      ? `/dashboard/outreach/${channel}` : '/dashboard/outreach';
    return { href: path, label: 'Open Outreach status' };
  }
  if (toolName === 'publish_social_post') return { href: '/dashboard/content-calendar', label: 'Open Content Calendar' };
  if (['publish_ads', 'publish_meta_ads', 'publish_google_ads', 'stop_ads'].includes(toolName)) {
    return { href: '/dashboard/ads?tab=campaigns', label: 'Open Ads status' };
  }
  if (toolName === 'analytics_query') return { href: '/dashboard/ads?tab=overview', label: 'Open Analytics' };
  return null;
}
