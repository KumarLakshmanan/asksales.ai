import DOMPurify from 'dompurify';
import { EMAIL_BLOCKS, EMAIL_NON_CONTENT, normalizeEmailText, type EmailTextFormat } from '../../../shared/emailDisplay';

/** Convert email HTML into inert readable text without loading remote content. */
export function emailDisplayText(input: string, format: EmailTextFormat = 'text'): string {
  if (typeof DOMParser === 'undefined') return normalizeEmailText(format === 'text' ? input : input.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' '));
  if (format === 'text') {
    let text = input;
    for (let pass = 0; pass < 3 && /&(?:#\d+|#x[\da-f]+|\w+);/i.test(text); pass++) {
      text = new DOMParser().parseFromString(text.replace(/</g, '&lt;'), 'text/html').body.textContent || '';
    }
    return normalizeEmailText(text);
  }
  const safe = DOMPurify.sanitize(input, { FORBID_TAGS: ['img', 'video', 'audio', 'source', 'iframe', 'object', 'embed', 'link', 'script', 'style'] });
  const doc = new DOMParser().parseFromString(safe, 'text/html');
  doc.querySelectorAll(EMAIL_NON_CONTENT).forEach(node => node.remove());
  doc.querySelectorAll('[style]').forEach(node => {
    if (/(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)/i.test(node.getAttribute('style') || '')) node.remove();
  });
  doc.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  doc.querySelectorAll(EMAIL_BLOCKS).forEach(node => node.append('\n'));
  doc.querySelectorAll('td,th').forEach(node => node.append(' '));
  let text = doc.body.textContent || '';
  for (let pass = 0; pass < 2 && /&(?:#\d+|#x[\da-f]+|\w+);/i.test(text); pass++) {
    text = new DOMParser().parseFromString(text.replace(/</g, '&lt;'), 'text/html').body.textContent || '';
  }
  return normalizeEmailText(text);
}

/**
 * Email content cleaning utilities
 * Strips quoted text, forward headers, and other email client artifacts
 * from inbound email content to improve readability in conversation views
 */

/**
 * Strip quoted reply content from email body
 * Removes lines starting with ">", "On [date] wrote:", and other email quote markers
 */
export function stripEmailQuotes(content: string): string {
  if (!content) return '';

  const lines = content.split('\n');
  const cleanedLines: string[] = [];
  let inQuoteBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect quote markers at the start of a line
    // Standard email quote: "> "quoted text"
    if (trimmed.startsWith('>')) {
      inQuoteBlock = true;
      continue;
    }

    // Detect "On [date] [sender] wrote:" pattern
    const wrotePattern = /^On\s+\w+?\s+\d{1,2}[^a-zA-Z0-9\s]+wrote:/i;
    if (wrotePattern.test(trimmed)) {
      inQuoteBlock = true;
      continue;
    }

    // Detect "-----Original Message-----" or similar separators
    const separatorPattern = /^-{3,}\s*(Original Message|Forwarded message|Reply separator|BEGIN PGP)/i;
    if (separatorPattern.test(trimmed)) {
      inQuoteBlock = true;
      continue;
    }

    // Detect "From:" marker (often in forwarded emails)
    if (trimmed.startsWith('From:') && i > 0) {
      inQuoteBlock = true;
      continue;
    }

    // Exit quote block on empty line or "On " pattern after quote
    if (inQuoteBlock) {
      if (trimmed === '' || trimmed.startsWith('---') || trimmed.startsWith('==')) {
        inQuoteBlock = false;
      }
      continue;
    }

    // Keep the line if we're not in a quote block
    cleanedLines.push(line);
  }

  return cleanedLines.join('\n').trim();
}

/**
 * Extract only the actual reply content from an email
 * Returns content before any quoted section starts
 */
export function extractReplyContent(content: string): string {
  if (!content) return '';

  // Find common quote marker patterns
  const patterns = [
    // "On [date] wrote:"
    /\nOn\s+\w+?\s+\d{1,2}[^a-zA-Z0-9\s]+wrote:/i,
    // "-----Original Message-----"
    /\n-{3,}\s*Original Message/i,
    // "From:" in new line (forwarded emails)
    /\nFrom:\s*\n/,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match.index !== undefined) {
      return content.substring(0, match.index).trim();
    }
  }

  return content.trim();
}

/**
 * Clean email content for display in conversation view
 * Combines quote stripping with other cleanup
 */
export function cleanEmailForDisplay(content: string): string {
  if (!content) return '';

  // First try to extract just the reply portion
  let cleaned = extractReplyContent(content);

  // If no reply pattern found, strip quote lines
  if (cleaned === content) {
    cleaned = stripEmailQuotes(content);
  }

  // Remove excessive whitespace
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}
