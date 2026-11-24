export function buildLeadRetryActionMessage(input: {
  failedToolName?: string;
  selectedWorkflows?: string[];
  originalRequest?: string;
}): string {
  const toolName = input.failedToolName === 'list_available_workflows'
    ? 'list_available_workflows'
    : 'generate_lead_inputs';
  const strategies = [...new Set((input.selectedWorkflows || []).filter(Boolean))];
  const strategyContext = strategies.length
    ? `Keep the selected strategy unchanged: ${strategies.join(', ')}.`
    : 'If no strategy is saved, show the available lead-generation strategies and wait for my selection.';
  const requestContext = input.originalRequest?.trim()
    ? `Preserve the original targeting request exactly: ${input.originalRequest.trim()}`
    : 'Preserve the original targeting requirements from this conversation.';
  return `Marcus, retry only the failed lead-generation step (${toolName}). Prepare search settings for review only; do not run a search, contact leads, or switch to Outreach. ${strategyContext} ${requestContext}`;
}
