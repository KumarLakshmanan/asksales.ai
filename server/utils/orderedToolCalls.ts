export interface FunctionToolCall { id: string; function: { name: string; arguments?: unknown } }

export function parseToolArguments(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
  return parsed as Record<string, unknown>;
}

/** Only consecutive independent reads overlap. Yield in call order and wait for
 * the caller to consume each group before a later stateful operation starts. */
export async function* orderedToolCalls<T, R>(
  calls: T[], safe: (call: T) => boolean, execute: (call: T) => Promise<R>, concurrency = 3,
): AsyncGenerator<{ call: T; result: R }> {
  const bound = Math.max(1, Math.min(4, Math.floor(concurrency) || 1));
  for (let index = 0; index < calls.length;) {
    const group = [calls[index++]];
    if (safe(group[0])) while (index < calls.length && group.length < bound && safe(calls[index])) group.push(calls[index++]);
    // Drain every launched read even if one fails, before exposing the failure.
    const results = await Promise.allSettled(group.map(execute));
    for (let offset = 0; offset < group.length; offset++) {
      const result = results[offset];
      if (result.status === 'rejected') throw result.reason;
      yield { call: group[offset], result: result.value };
    }
  }
}
