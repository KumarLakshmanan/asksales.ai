import DOMPurify from "dompurify";

export function plainTextToHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\r?\n/g, "<br>");
}

/** Preserve paragraph/list breaks in the text alternative sent with an email. */
export function emailHtmlToText(html: string): string {
  const element = document.createElement("div");
  element.innerHTML = DOMPurify.sanitize(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, "\n");
  return (element.textContent || "").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trimEnd();
}
