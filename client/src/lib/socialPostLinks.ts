export function socialPostHref(
  id: string,
  platform: string,
  credentialId: string,
  window: { startDate?: string; endDate?: string } = {},
) {
  const query = new URLSearchParams({ platform, account: credentialId });
  if (window.startDate) query.set("start", window.startDate);
  if (window.endDate) query.set("end", window.endDate);
  return `/dashboard/marketing/analytics/posts/${encodeURIComponent(id)}?${query}`;
}
