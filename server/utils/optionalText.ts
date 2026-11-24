/** The trimmed string, or undefined when the value is not a string or is blank. */
export function trimmedTextOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
