import {
  buildReviewedLeadTotals,
  resolveReviewedLeadTotal,
} from '../models/leadInputs/reviewedTotals.js';

describe('lead input reviewed total recovery', () => {
  it('recovers the most recent explicit cap for the same exact workflow', () => {
    const history = [
      { platform: 'instagram_post_search', workflowId: 'wf-instagram-post', schema: {} },
      { platform: 'instagram_post_search', workflowId: 'wf-instagram-post', schema: { requestedLeadTotal: 1 } },
      { platform: 'instagram_post_search', workflowId: 'wf-instagram-post', schema: { requestedLeadTotal: 5 } },
    ];

    const totals = buildReviewedLeadTotals(history);

    expect(resolveReviewedLeadTotal(history[0], totals)).toBe(1);
  });

  it('does not infer a reviewed cap from a provider fetch limit', () => {
    const input = {
      platform: 'instagram_post_search',
      workflowId: 'wf-instagram-post',
      schema: {},
      inputs: { resultsLimit: 20 },
    };

    expect(resolveReviewedLeadTotal(input, buildReviewedLeadTotals([input]))).toBeUndefined();
  });
});
