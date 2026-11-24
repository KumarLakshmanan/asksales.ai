export interface ToolExecutionResult extends Record<string, unknown> {
  success: boolean;
  toolName: string;
  error?: string;
  output?: unknown;
}

/** Mastra validation errors are returned objects, not exceptions. Never turn
 * a missing success flag (or error:true) into evidence of completed work. */
export function normalizeToolExecutionResult(toolName: string, value: unknown): ToolExecutionResult {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const valid = record && typeof record.success === 'boolean'
    && (!record.toolName || record.toolName === toolName)
    && !(record.success && record.error);
  if (!valid) return {
    success: false, toolName, code: 'invalid_tool_result',
    error: 'The tool returned an invalid execution result. Check its saved operation before retrying.',
    output: { retrySafe: false, status: 'failed', reconciliationRequired: true },
  };
  return { ...record, success: record.success as boolean, toolName,
    ...(record.success === false ? { error: typeof record.error === 'string' && record.error.trim()
      ? record.error : 'The tool did not complete successfully.' } : {}) };
}
