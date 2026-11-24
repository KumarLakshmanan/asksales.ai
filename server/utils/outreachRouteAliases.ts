/** Existing bookmarked/API URLs keep the canonical campaign policy and handlers. */
export function canonicalOutreachPath(path: string): string | null {
  path = path.replace(/\/+$/, '') || '/';
  const aliases: Record<string, string> = {
    '/generate-email-sequence': '/sequences/email',
    '/generate-sms-sequence': '/sequences/sms',
    '/create-campaign': '/campaigns',
    '/campaigns': '/campaigns',
    '/sequences': '/sequences',
  };
  if (aliases[path]) return aliases[path];
  const scheduled = /^\/schedule-campaign\/([^/]+)$/.exec(path);
  if (scheduled) return `/campaigns/${scheduled[1]}/schedule`;
  return /^\/campaigns\/[^/]+$/.test(path) ? path : null;
}
