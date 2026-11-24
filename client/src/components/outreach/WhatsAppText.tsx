import type { ReactNode } from "react";

/**
 * WhatsApp message text as people see it in WhatsApp: http(s) links are
 * clickable, and *bold*, _italic_, ~strikethrough~ and ```monospace``` are
 * formatted. Everything is built as React nodes (never HTML), so message text
 * cannot inject markup.
 *
 * No lookbehind: Safari before 16.4 cannot parse it, and one bad literal would
 * break the whole inbox bundle. A marker must instead follow the start of the
 * text or a character that is not a word character or the same marker; that
 * character is captured and kept as plain text.
 */
const marker = (m: string) => {
  const e = m === "*" ? "\\*" : m;
  return `(^|[^\\w${e}])${e}(\\S(?:[^${e}\\n]*?\\S)?)${e}(?![\\w${e}])`;
};
const TOKEN = new RegExp(
  [
    String.raw`(https?:\/\/[^\s<>"]+[^\s<>".,:;'!?)\]])`,
    "```([\\s\\S]+?)```",
    marker("*"),
    marker("_"),
    marker("~"),
  ].join("|"),
  "g",
);
const BOLD = new RegExp(marker("*"), "g");
const ITALIC = new RegExp(marker("_"), "g");
const STRIKE = new RegExp(marker("~"), "g");

const SAFE_LINK = /^https?:\/\//i;

function render(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const key = `${keyPrefix}-${index++}`;
    const [whole, url, mono, boldLead, bold, italicLead, italic, strikeLead, strike] = match;
    if (url && SAFE_LINK.test(url)) {
      nodes.push(
        <a key={key} href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-[#027eb5] underline underline-offset-2 dark:text-[#53bdeb]">
          {url}
        </a>,
      );
    } else if (mono !== undefined) {
      nodes.push(<code key={key} className="font-mono text-[0.92em]">{mono}</code>);
    } else if (bold !== undefined) {
      if (boldLead) nodes.push(boldLead);
      nodes.push(<strong key={key} className="font-semibold">{render(bold, key)}</strong>);
    } else if (italic !== undefined) {
      if (italicLead) nodes.push(italicLead);
      nodes.push(<em key={key}>{render(italic, key)}</em>);
    } else if (strike !== undefined) {
      if (strikeLead) nodes.push(strikeLead);
      nodes.push(<s key={key}>{render(strike, key)}</s>);
    } else {
      nodes.push(whole);
    }
    cursor = start + whole.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function WhatsAppText({ text }: { text: string }) {
  return <>{render(text, "wa")}</>;
}

/** Plain text for one-line previews: formatting markers removed, words kept. */
export function whatsAppPlainText(text: string): string {
  return text
    .replace(/```([\s\S]+?)```/g, "$1")
    .replace(BOLD, "$1$2")
    .replace(ITALIC, "$1$2")
    .replace(STRIKE, "$1$2");
}

/** Text the webhook stores when a media message has no caption. */
const MEDIA_PLACEHOLDER = /^\[(image|video|audio|document|sticker) message\]$/i;
const MEDIA_NAMES: Record<string, string> = { image: "photo", video: "video", audio: "voice message", document: "document", sticker: "sticker" };

/** null when the caption-less placeholder should be hidden (the media is shown);
 * a plain sentence when the media was not saved; otherwise the text unchanged. */
export function whatsAppDisplayBody(text: string, hasAttachment: boolean): string | null {
  const placeholder = MEDIA_PLACEHOLDER.exec(text.trim());
  if (!placeholder) return text;
  if (hasAttachment) return null;
  return `This ${MEDIA_NAMES[placeholder[1].toLowerCase()]} wasn't saved, so it can't be shown here.`;
}

/** One-line list preview: "Video" for a caption-less media message, else plain text. */
export function whatsAppPreviewText(text: string): string {
  const placeholder = MEDIA_PLACEHOLDER.exec(text.trim());
  if (placeholder) {
    const name = MEDIA_NAMES[placeholder[1].toLowerCase()];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return whatsAppPlainText(text);
}
