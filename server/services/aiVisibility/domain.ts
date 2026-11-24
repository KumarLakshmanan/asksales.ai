export class AiVisibilityDomainValidationError extends Error {}

export function normalizeDomain(value: string): string {
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new AiVisibilityDomainValidationError('Enter a public HTTP or HTTPS domain without credentials.');
  }
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AiVisibilityDomainValidationError('Enter a valid HTTP or HTTPS domain.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new AiVisibilityDomainValidationError('Enter a public HTTP or HTTPS domain without credentials.');
  }
  url.hash = '';
  url.search = '';
  url.pathname = '/';
  return url.toString().replace(/\/$/, '');
}
