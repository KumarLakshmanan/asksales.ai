import type { ExternalBookingHandoff } from '../agents/BaseOutreachAgent.js';
import { escapeHtml } from '../../../shared/html.js';

/** Render the canonical wording while preserving the owner-approved URL.
 * Models never call this function and never receive the URL. */
export function renderExternalBookingMessage(
  handoff: ExternalBookingHandoff,
  channel: string,
  includeLink = true,
): string {
  const isSearch = handoff.stage === 'search';
  if (!includeLink) {
    return isSearch
      ? 'Please message us privately so we can share the hotel’s live room search securely.'
      : 'Your room selection is ready to continue. Please message us privately so we can share the hotel’s booking page securely.';
  }
  const notice = 'Availability, final price, payment, and confirmation are completed on that page.';
  const introduction = isSearch
    ? 'Please view the hotel’s live rooms and rates for your stay on the booking page'
    : 'Your room selection is ready to continue. Please complete and confirm your booking on the hotel’s booking page';
  if (channel === 'email') {
    return `<p>${introduction}: <a href="${escapeHtml(handoff.url)}">${escapeHtml(handoff.title)}</a>.</p><p>${notice}</p><p>Booking page: ${escapeHtml(handoff.url)}</p>`;
  }
  return `${introduction}:\n${handoff.url}\n\n${notice}`;
}

export function plainTextEmailFallback(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
