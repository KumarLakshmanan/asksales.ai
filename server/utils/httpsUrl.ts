/** The normalized URL when the value parses as an https: URL, otherwise null. */
export const httpsUrlOrNull = (value: unknown): string | null => {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};
