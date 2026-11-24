interface AttachmentExtraction {
  id?: string;
  originalName?: string;
  fileName?: string;
  filename?: string;
  extractionStatus?: string;
}

export function AttachmentExtractionNotices({ attachments }: { attachments: AttachmentExtraction[] }) {
  const notices = attachments.flatMap((attachment, index) => {
    const status = attachment.extractionStatus;
    const detail = status === "failed" || status === "quarantined"
      ? "Contents could not be read. Upload another copy or paste the relevant text."
      : status === "not_applicable" || status === "unsupported"
        ? "Contents are not available for analysis. Paste the relevant text if needed."
        : status === "pending" || status === "processing"
          ? "Contents are still being processed and are not yet available for analysis."
          : null;
    return detail ? [{ key: attachment.id || index, name: attachment.originalName || attachment.fileName || attachment.filename || "Attachment", detail }] : [];
  });
  if (!notices.length) return null;
  return <ul className="mt-2 space-y-1 text-xs text-muted-foreground" aria-live="polite" aria-label="Attachment readability">{notices.map((notice) => <li key={notice.key} className="break-words"><span className="font-medium text-foreground">{notice.name}: </span>{notice.detail}</li>)}</ul>;
}
