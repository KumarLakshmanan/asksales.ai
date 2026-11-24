interface QueueTicketContent {
  ticketNumber: string;
  subject: string | null;
  description: string | null;
  handoffReason: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: string | null;
  lastMessageInternal?: boolean;
}

/** Customer text is stored with privacy-vault tokens such as [NAME_2522]; show a readable stand-in. */
const PRIVACY_TOKEN = /\[(NAME|EMAIL|PHONE|ADDRESS|CARD|ACCOUNT|ID|URL)_\d+\]/g;
const PRIVACY_LABEL: Record<string, string> = { NAME: "(name)", EMAIL: "(email)", PHONE: "(phone)", ADDRESS: "(address)" };

export function withReadablePrivacyTokens(value: string | null | undefined) {
  return (value || "").replace(PRIVACY_TOKEN, (_token, type: string) => PRIVACY_LABEL[type] || "(hidden)");
}

function plainText(value: string | null) {
  return withReadablePrivacyTokens(value).replace(/\s+/g, " ").trim();
}

/** Present only content already returned by the tenant-scoped queue API.
 * Prefer the original request over a changing reply or internal note. */
export function supportQueuePresentation(ticket: QueueTicketContent) {
  const subject = plainText(ticket.subject);
  const placeholderSubject = /^classification unavailable[.!]?$/i.test(subject);
  const classificationUnavailable = placeholderSubject
    || /\bclassification (?:is )?unavailable\b/i.test(ticket.handoffReason || "");
  const request = plainText(ticket.description)
    || (ticket.lastMessageDirection === "inbound" && !ticket.lastMessageInternal ? plainText(ticket.lastMessagePreview) : "");
  const summary = request.length > 140 ? `${request.slice(0, 139).trimEnd()}…` : request;
  const headline = subject && !placeholderSubject ? subject : summary || `Support request · ${ticket.ticketNumber}`;
  return { headline, classificationUnavailable };
}
