import { describe, expect, it } from '@jest/globals';
import { findRepeatedFailure } from '../mastra/utils/toolCallingLoop.js';

describe('stopping after the same failure twice in one turn', () => {
  it('spots the same step failing the same way twice, ignoring numbers and spacing', () => {
    expect(findRepeatedFailure([
      { toolName: 'prepare_outreach_campaign', success: false, error: 'Imported audience 41 not found.' },
      { toolName: 'get_outreach_preparation_options', success: true },
      { toolName: 'prepare_outreach_campaign', success: false, error: 'Imported  audience 42 not found.' },
    ])).toEqual({ toolName: 'prepare_outreach_campaign', error: 'Imported  audience 42 not found.' });
  });

  it('lets a different error or a different step try again', () => {
    expect(findRepeatedFailure([
      { toolName: 'prepare_outreach_campaign', success: false, error: 'Imported audience not found.' },
      { toolName: 'prepare_outreach_campaign', success: false, error: 'Sending account unavailable.' },
      { toolName: 'generate_email_template', success: false, error: 'Imported audience not found.' },
      { toolName: 'prepare_outreach_campaign', success: true },
    ])).toBeNull();
  });
});
