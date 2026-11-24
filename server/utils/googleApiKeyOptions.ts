/** Vertex Express keys must use the Vertex API rather than AI Studio. */
export function googleApiKeyOptions(value: string): { apiKey: string; vertexai: boolean } {
  const apiKey = value.trim();
  return { apiKey, vertexai: apiKey.startsWith('AQ.') };
}
