/** Formats generated text for the actual capabilities of each delivery
 * channel. Block structure is normalized before inline emphasis so a Markdown
 * list marker cannot be confused with WhatsApp's single-star bold syntax.
 */

import { load } from 'cheerio';

type ChannelFamily = 'whatsapp' | 'social' | 'email' | 'plain';

/** Render only email-safe content. Provider output and attachment text are untrusted. */
export function sanitizeSupportEmailHtml(html: string): string {
  const $ = load(html, null, false);
  $('script,style,iframe,object,embed,form,input,button,svg,math,template').remove();
  const allowed = new Set(['p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'del', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
  $('*').each((_, element) => {
    if (element.type !== 'tag') return;
    if (!allowed.has(element.name)) { $(element).replaceWith($(element).contents()); return; }
    const href = element.attribs.href;
    for (const key of Object.keys(element.attribs)) $(element).removeAttr(key);
    if (element.name === 'a' && href && /^(?:https?:\/\/|mailto:)/i.test(href.trim())
      && !Array.from(href).some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) {
      $(element).attr('href', href).attr('rel', 'noopener noreferrer');
    }
  });
  return $.html().replace(/<br>/g, '<br />');
}

function channelFamily(channel: string): ChannelFamily {
  const normalized = channel.trim().toLowerCase();
  if (normalized === 'email' || normalized === 'gmail') return 'email';
  if (normalized === 'whatsapp' || normalized === 'wa') return 'whatsapp';
  if (normalized.startsWith('instagram') || normalized.startsWith('facebook')) return 'social';
  return 'plain';
}

function plainTextFromHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li(?:\s[^>]*)?>/gi, '\n• ')
    .replace(/<\/(?:p|div|li|ul|ol|h[1-6])>/gi, '\n')
    .replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/gi, '');
}

function normalizeBlocks(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // Models occasionally put the first list item directly after the
    // introduction ("Options: * **First:** ..."). Start it on its own line.
    .replace(/:([\t ]+)(?=(?:[-+*•][\t ]+|\d+[.)][\t ]+))(?=[^\n])/g, ':\n')
    // A visible bullet is portable across WhatsApp, Meta DMs, email and plain
    // text, and cannot collide with WhatsApp's *bold* delimiter.
    .replace(/^[\t ]*[-+*•][\t ]+/gm, '• ')
    .replace(/^[\t ]*(\d+)[.)][\t ]+/gm, '$1. ')
    .replace(/^[\t ]*#{1,6}[\t ]+/gm, '')
    .replace(/[\t ]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

function stripMarkdownEmphasis(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)/g, '$1')
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1 ($2)');
}

export function formatMessageForChannel(text: string, channel: 'whatsapp' | 'instagram' | 'facebook' | 'email' | string): string {
  if (!text) return '';

  const family = channelFamily(channel);
  if (family === 'email' && /<[a-z][\s\S]*>/i.test(text)) return sanitizeSupportEmailHtml(text.trim());

  let formatted = normalizeBlocks(family === 'email' ? text : plainTextFromHtml(text));

  if (family === 'whatsapp') {
    formatted = formatted
      // WhatsApp clients can collapse the ordinary space after the first
      // visible bullet. A non-breaking space keeps every list marker aligned.
      .replace(/^• /gm, '•\u00A0')
      // Convert Markdown italic before bold; converting bold first would turn
      // its new single stars into underscores on the next replacement.
      .replace(/(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)/g, '_$1_')
      .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
      .replace(/~~([^~\n]+)~~/g, '~$1~')
      .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1 ($2)');
  } else if (family === 'email') {
    formatted = formatted
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\n/g, '<br />');
  } else {
    formatted = stripMarkdownEmphasis(formatted);
  }

  return family === 'email' ? sanitizeSupportEmailHtml(formatted.trim()) : formatted.trim();
}
