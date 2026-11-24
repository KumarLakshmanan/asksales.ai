import DOMPurify from "dompurify";

/** Produces inert markup for an iframe srcDoc or inline email preview. */
export function sanitizeEmailPreviewHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "option",
      "base",
      "meta",
    ],
    FORBID_ATTR: [
      "srcdoc",
      "formaction",
      "autofocus",
      "onerror",
      "onload",
      "onclick",
      "onmouseover",
      "onfocus",
    ],
  });
}
