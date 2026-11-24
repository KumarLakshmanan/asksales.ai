import { buildLeadRetryActionMessage } from '../mastra/utils/leadRetryAction.js';

it('builds a retry instruction that preserves the exact lead strategy and original request', () => {
  const message = buildLeadRetryActionMessage({
    failedToolName: 'generate_lead_inputs',
    selectedWorkflows: ['facebook_competitor_pages', 'facebook_competitor_pages'],
    originalRequest: 'Find 5 followers of Acme competitor pages in California.',
  });

  expect(message).toContain('Marcus');
  expect(message).toContain('generate_lead_inputs');
  expect(message).toContain('facebook_competitor_pages');
  expect(message).toContain('Find 5 followers of Acme competitor pages in California.');
  expect(message).toContain('do not run a search');
  expect(message).toContain('switch to Outreach');
});

it('does not invent a strategy if a retry has no saved selection', () => {
  const message = buildLeadRetryActionMessage({ originalRequest: 'Find CTOs in Bengaluru.' });

  expect(message).toContain('show the available lead-generation strategies and wait for my selection');
  expect(message).toContain('Find CTOs in Bengaluru.');
  expect(message).not.toContain('Keep the selected strategy unchanged:');
});
