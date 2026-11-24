type Header = { key: string; value: string };

/** The public widget is intentionally frameable; dashboard routes keep their
 * clickjacking protections. All other widget security directives stay intact. */
export function supportWidgetHeaders(headers: Header[]): Header[] {
  return headers.filter((header) => header.key.toLowerCase() !== "x-frame-options").map((header) => header.key.toLowerCase() === "content-security-policy"
    ? { ...header, value: header.value.replace(/frame-ancestors [^;]+/, "frame-ancestors http: https:") }
    : header);
}
