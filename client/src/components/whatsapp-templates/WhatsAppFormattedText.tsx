import type { ReactNode } from "react";

// React escapes every text segment. WhatsApp formatting never becomes raw HTML.
function formatText(value: string, depth = 0): ReactNode {
  if (depth > 4) return value;
  const pattern = /```([\s\S]+?)```|(?<!\w)\*(\S(?:[\s\S]*?\S)?)\*(?!\w)|(?<!\w)_(\S(?:[\s\S]*?\S)?)_(?!\w)|(?<!\w)~(\S(?:[\s\S]*?\S)?)~(?!\w)/g;
  const parts: ReactNode[] = [];
  let position = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    parts.push(value.slice(position, start));
    const key = `${depth}:${start}`;
    if (match[1] !== undefined) parts.push(<code key={key} className="whitespace-pre-wrap font-mono">{match[1]}</code>);
    else if (match[2] !== undefined) parts.push(<strong key={key}>{formatText(match[2], depth + 1)}</strong>);
    else if (match[3] !== undefined) parts.push(<em key={key}>{formatText(match[3], depth + 1)}</em>);
    else parts.push(<s key={key}>{formatText(match[4], depth + 1)}</s>);
    position = start + match[0].length;
  }
  parts.push(value.slice(position));
  return parts;
}

export function WhatsAppFormattedText({ children }: { children: string }) {
  return <>{formatText(children)}</>;
}
