import { load } from 'cheerio';
import { EMAIL_BLOCKS, EMAIL_NON_CONTENT, normalizeEmailText, type EmailTextFormat } from '../../shared/emailDisplay.js';

export function emailDisplayText(input: string, format: EmailTextFormat = 'text'): string {
  if (format === 'text') {
    let text = input;
    for (let pass = 0; pass < 3 && /&(?:#\d+|#x[\da-f]+|\w+);/i.test(text); pass++) {
      text = load(text.replace(/</g, '&lt;'))('body').text();
    }
    return normalizeEmailText(text);
  }
  const html = load(input);
  html(EMAIL_NON_CONTENT).remove();
  html('[style]').each((_, node) => {
    if (/(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)/i.test(html(node).attr('style') || '')) html(node).remove();
  });
  html('br').replaceWith('\n');
  html(EMAIL_BLOCKS).append('\n');
  html('td,th').append(' ');
  let text = html('body').text();
  // Some providers escape entities twice. Decode only text, never reparse it as HTML.
  for (let pass = 0; pass < 2 && /&(?:#\d+|#x[\da-f]+|\w+);/i.test(text); pass++) {
    text = load(text.replace(/</g, '&lt;'))('body').text();
  }
  return normalizeEmailText(text);
}

/** Historical receipts have no MIME field. Recognize complete email templates only;
 * addresses and literal script/style examples must remain plain text. New Gmail
 * receipts persist their explicit MIME format alongside the original body.
 */
export function legacyEmailFormat(input: string, channel: string, storedFormat?: string | null): EmailTextFormat {
  if (storedFormat === 'text' || storedFormat === 'html') return storedFormat;
  if (channel !== 'email' && channel !== 'gmail') return 'text';
  const body = input.trimStart();
  if (/^(?:<!doctype\s+html\b|<html\b)/i.test(body)) return 'html';
  if (/^<style\b[^>]*>[^<]*\{\s*[-\w]+\s*:[^<]*\}[^<]*<\/style>\s*<(?:p|div|table|body)\b/i.test(body)) return 'html';
  if (/^<(p|div|table|body)\b[^>]*>[\s\S]*<\/\1>\s*$/i.test(body)) return 'html';
  return 'text';
}
