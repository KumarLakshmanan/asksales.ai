/**
 * Publishing copies (cross-post children, per-destination attempts) must not
 * inherit the generation key: it identifies the one gallery row for a file.
 * Kept outside the model module so tests that mock the model still load it.
 */
export function withoutGenerationKey<T extends Record<string, unknown> | null | undefined>(metadata: T): T {
  if (!metadata || typeof metadata !== 'object' || !('generationKey' in metadata)) return metadata;
  const { generationKey: _generationKey, ...rest } = metadata as Record<string, unknown>;
  return rest as T;
}
