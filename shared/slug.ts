/** Lower-case slug: runs of anything but a-z/0-9 become one dash, with no leading or trailing dash. */
export function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
