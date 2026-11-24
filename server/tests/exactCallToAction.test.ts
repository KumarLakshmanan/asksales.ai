import { describe, expect, it } from '@jest/globals';
import { withExactCallToAction, withReviewedEmailCta } from '../utils/exactCallToAction.js';

describe('reviewed literal call to action', () => {
  it('replaces a model-written closing ask with the reviewed email CTA', () => {
    expect(withReviewedEmailCta({ body: 'Hotel workflows.', closing: 'Would you book a demo?', cta: 'Book now', signature: 'The team' }, 'Ask for a workflow review.'))
      .toEqual({ body: 'Hotel workflows.\n\nAsk for a workflow review.', closing: '', cta: 'Ask for a workflow review.', signature: 'The team' });
  });
  it('preserves exact punctuation rather than using generated paraphrases', () => {
    expect(withExactCallToAction('Make hotel workflows easier.', 'Ask for a workflow review.'))
      .toBe('Make hotel workflows easier.\n\nAsk for a workflow review.');
  });
  it('does not duplicate an already preserved CTA or add one if none was supplied', () => {
    expect(withExactCallToAction('Text\n\nAsk for a workflow review.', 'Ask for a workflow review.')).toBe('Text\n\nAsk for a workflow review.');
    expect(withExactCallToAction('Text')).toBe('Text');
  });
  it('preserves multilingual user-authored literals', () => {
    expect(withExactCallToAction('Draft', 'செயல்முறை மதிப்பாய்வைக் கேளுங்கள்.')).toBe('Draft\n\nசெயல்முறை மதிப்பாய்வைக் கேளுங்கள்.');
  });
});
