import { buildLeadStrategySelectionMessage, LEAD_SETTINGS_PREPARATION_MESSAGE } from '../mastra/utils/leadStrategyActionMessage.js';

describe('bound lead strategy selection message', () => {
  it('uses the review-only preparation protocol for catalog choices', () => {
    expect(buildLeadStrategySelectionMessage('linkedin_company_employees_posts',
      'Use LinkedIn Company Employee Posts and prepare the search settings for my review.'))
      .toBe(LEAD_SETTINGS_PREPARATION_MESSAGE);
  });
  it('preserves custom requirements without making them execution approval', () => {
    expect(buildLeadStrategySelectionMessage('linkedin', 'Use Full mode and global cap 1.'))
      .toBe(`${LEAD_SETTINGS_PREPARATION_MESSAGE}\nUse Full mode and global cap 1.`);
  });
  it('does not turn an unbound catalog action into preparation', () => {
    expect(buildLeadStrategySelectionMessage(undefined, 'Show me all available strategies for each channel'))
      .toBe('Show me all available strategies for each channel');
  });
});
