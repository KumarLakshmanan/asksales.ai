export interface ReplyAttachment { fileId: number; name: string; type: string }
interface ReplyIntent { key: string; uploads: ReplyAttachment[] }
type Ledger = Record<string, ReplyIntent>;
const pendingScopes = new Set<string>();
const prefix = 'support-reply-intents:v1:';

async function digest(bytes: BufferSource): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Tab-scoped retry metadata only: never persist reply text or attachment bytes. */
export async function sendSupportReply(options: {
  scope: string;
  content: string;
  files: File[];
  upload: (file: File) => Promise<ReplyAttachment>;
  send: (body: { content: string; isInternal: false; idempotencyKey: string; attachments: ReplyAttachment[] }) => Promise<unknown>;
  isCurrent: () => boolean;
}): Promise<void> {
  const { scope, content, files, upload, send, isCurrent } = options;
  if (!scope || !isCurrent()) throw new Error('The ticket or signed-in account changed. Reopen the ticket before replying.');
  if (pendingScopes.has(scope)) throw new Error('A reply is already being prepared for this ticket.');
  pendingScopes.add(scope);
  try {
    const fileHashes = await Promise.all(files.map(async file => [file.name, file.type, file.size, await digest(await file.arrayBuffer())]));
    const fingerprint = await digest(new TextEncoder().encode(JSON.stringify([content.trim(), fileHashes])));
    const storageKey = prefix + scope;
    const read = (): Ledger => {
      try {
        const value = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
        return value;
      } catch { throw new Error('Safe reply retry storage is unavailable. Restore browser storage before sending.'); }
    };
    const write = (ledger: Ledger) => {
      try { sessionStorage.setItem(storageKey, JSON.stringify(ledger)); }
      catch { throw new Error('Safe reply retry storage is unavailable. Restore browser storage before sending.'); }
    };
    const ledger = read();
    if (!ledger[fingerprint] && Object.keys(ledger).length > 0 && !window.confirm('An earlier reply may already have been accepted. Review the conversation before sending different content or attachments. Send this as a new reply?')) {
      throw new Error('New reply cancelled. Review the earlier reply outcome before sending different content or attachments.');
    }
    const intent = ledger[fingerprint] ?? { key: crypto.randomUUID(), uploads: [] };
    if (typeof intent.key !== 'string' || !Array.isArray(intent.uploads)) throw new Error('Reply recovery metadata is invalid. Review the conversation before sending.');
    ledger[fingerprint] = intent;
    // Persist before uploads/send: a lost response must not become a new intent.
    write(ledger);
    for (let index = intent.uploads.length; index < files.length; index++) {
      if (!isCurrent()) throw new Error('The ticket or signed-in account changed. Reopen the ticket before replying.');
      const uploaded = await upload(files[index]);
      intent.uploads.push({ fileId: uploaded.fileId, name: uploaded.name, type: uploaded.type });
      write(ledger);
    }
    if (!isCurrent()) throw new Error('The ticket or signed-in account changed. Reopen the ticket before replying.');
    try {
      await send({ content: content.trim(), isInternal: false, idempotencyKey: intent.key, attachments: intent.uploads });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : 'Reply outcome unavailable.'} The reply may have been accepted. Review the conversation before changing it; retry the same reply to reuse its saved intent.`);
    }
    // Preserve other uncertain attempts, including edits made while this one ran.
    const latest = read();
    if (latest[fingerprint]?.key === intent.key) { delete latest[fingerprint]; write(latest); }
  } finally { pendingScopes.delete(scope); }
}
