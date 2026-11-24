import { whatsappVariableIndexes } from "@/lib/whatsapp-template-variables";

export type WhatsAppTextEdit = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

export function editWhatsAppText(
  value: string,
  start: number,
  end: number,
  replacement: string,
  limit: number,
  selectionOffset = replacement.length,
  selectionLength = 0,
): WhatsAppTextEdit | null {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  const nextValue = value.slice(0, from) + replacement + value.slice(to);
  if (nextValue.length > limit) return null;
  return {
    value: nextValue,
    selectionStart: from + selectionOffset,
    selectionEnd: from + selectionOffset + selectionLength,
  };
}

export function formatWhatsAppSelection(value: string, start: number, end: number, delimiter: string, limit = 1024): WhatsAppTextEdit | null {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  const selected = value.slice(from, to);
  if (selected && from >= delimiter.length && value.slice(from - delimiter.length, from) === delimiter && value.slice(to, to + delimiter.length) === delimiter) {
    return editWhatsAppText(value, from - delimiter.length, to + delimiter.length, selected, limit, 0, selected.length);
  }
  if (selected.length > delimiter.length * 2 && selected.startsWith(delimiter) && selected.endsWith(delimiter)) {
    const plain = selected.slice(delimiter.length, -delimiter.length);
    return editWhatsAppText(value, from, to, plain, limit, 0, plain.length);
  }
  const content = selected || "text";
  return editWhatsAppText(value, from, to, `${delimiter}${content}${delimiter}`, limit, delimiter.length, content.length);
}

export function nextWhatsAppVariable(value: string): number {
  const used = new Set(whatsappVariableIndexes(value).map(Number));
  let index = 1;
  while (used.has(index)) index += 1;
  return index;
}
