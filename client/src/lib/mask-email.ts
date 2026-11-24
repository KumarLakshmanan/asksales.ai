/**
 * Masks a personal email for list views: "person@gmail.com" -> "p***@gmail.com".
 * Keeps the first character and the domain so a row stays recognisable without showing the full address.
 * Returns null for an empty value so callers can fall back to other text.
 */
export function maskEmail(email?: string | null): string | null {
  const value = email?.trim();
  if (!value) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${value.charAt(0)}***${value.slice(at)}`;
}
