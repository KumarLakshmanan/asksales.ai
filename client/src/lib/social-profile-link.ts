const PLATFORMS: Record<string, { domains: string[]; base: string }> = {
  facebook: { domains: ['facebook.com', 'fb.com', 'fb.me'], base: 'https://www.facebook.com/' },
  instagram: { domains: ['instagram.com'], base: 'https://www.instagram.com/' },
  twitter: { domains: ['twitter.com', 'x.com'], base: 'https://x.com/' },
  linkedin: { domains: ['linkedin.com'], base: 'https://www.linkedin.com/in/' },
};

/** Historical imports also need domain checks before displaying platform-labelled links. */
export function socialProfileLink(platform: string, url?: string | null, handle?: string | null): string | null {
  const config = PLATFORMS[platform.toLowerCase()];
  if (!config) return null;
  if (url?.trim()) {
    try {
      const parsed = new URL(url.includes('://') ? url.trim() : `https://${url.trim()}`);
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
        && config.domains.some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) {
        return parsed.href;
      }
    } catch { /* Invalid persisted URL: do not render it as a social profile. */ }
    return null;
  }
  const username = handle?.trim().replace(/^@/, '');
  return username && /^[a-z0-9_.-]+$/i.test(username) ? `${config.base}${encodeURIComponent(username)}` : null;
}
