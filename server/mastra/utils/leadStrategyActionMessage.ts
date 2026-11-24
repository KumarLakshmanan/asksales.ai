export const LEAD_SETTINGS_PREPARATION_MESSAGE = 'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.';

/** A bound UI selection requests settings, not another catalog or execution. */
export function buildLeadStrategySelectionMessage(workflowId: string | undefined, message: string): string {
  if (!workflowId) return message;
  if (message === LEAD_SETTINGS_PREPARATION_MESSAGE
    || /^Use [^\n]+ and prepare the search settings for my review\.$/.test(message)) {
    return LEAD_SETTINGS_PREPARATION_MESSAGE;
  }
  // Preserve custom retry requirements while making the selection intent clear.
  return `${LEAD_SETTINGS_PREPARATION_MESSAGE}\n${message}`;
}
