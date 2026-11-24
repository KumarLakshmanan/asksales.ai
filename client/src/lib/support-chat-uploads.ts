export const SUPPORT_CHAT_FILE_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.gif,.webp";
const extensions = new Set(SUPPORT_CHAT_FILE_ACCEPT.split(","));
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** Match the upload endpoint's per-file limit and the support reference lane's total limit. */
export function validateSupportChatFiles(files: readonly Pick<File, "name" | "size">[], existing: readonly { size?: number }[] = []): string | null {
  if (files.length + existing.length > MAX_FILES) return "Attach up to five files per message. Remove a file before adding more.";
  for (const file of files) {
    const extension = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
    if (!extensions.has(extension)) return `${file.name}: use a PDF, Word document, spreadsheet, text file, or supported image.`;
    if (!file.size) return `${file.name} is empty. Choose a file with contents.`;
    if (file.size > MAX_FILE_BYTES) return `${file.name} exceeds 10 MB. Choose a smaller file.`;
  }
  if ([...files, ...existing].reduce((sum, file) => sum + (file.size || 0), 0) > MAX_TOTAL_BYTES) {
    return "Attachments exceed 20 MB in total. Remove a file or choose smaller files.";
  }
  return null;
}
