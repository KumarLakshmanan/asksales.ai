export interface SupportTranscriptMessage {
  id: number;
  role: string;
  content: string;
  createdAt: string;
  processingStatus?: string | null;
}

export function supportReplyStatus(message: Pick<SupportTranscriptMessage, 'role' | 'processingStatus'>): string | null {
  if (message.role !== 'assistant' || !message.processingStatus || message.processingStatus === 'completed') return null;
  if (message.processingStatus === 'reconciliation_required') return 'Delivery not confirmed · review required';
  if (message.processingStatus === 'cancelled') return 'Response cancelled';
  if (message.processingStatus === 'superseded') return 'Response superseded';
  return 'Response pending';
}

/** Keep exports as inert text, including channel markup, instead of executable HTML. */
export function formatSupportTranscript(messages: readonly SupportTranscriptMessage[], title = "Support conversation") {
  return [title, "", ...messages.map((message) => {
    const date = new Date(message.createdAt);
    const timestamp = Number.isNaN(date.getTime()) ? "Unknown time" : date.toISOString();
    const status = supportReplyStatus(message);
    return `${message.role === "assistant" ? "Assistant" : "User"} · ${timestamp}${status ? ` · ${status}` : ''}\n${message.content}`;
  })].join("\n\n");
}

export async function copySupportTranscript(messages: readonly SupportTranscriptMessage[], title?: string) {
  await navigator.clipboard.writeText(formatSupportTranscript(messages, title));
}

export function exportSupportTranscript(messages: readonly SupportTranscriptMessage[], title?: string) {
  const objectUrl = URL.createObjectURL(new Blob([formatSupportTranscript(messages, title)], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `${(title || "Support conversation").replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 80) || "Support conversation"}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
