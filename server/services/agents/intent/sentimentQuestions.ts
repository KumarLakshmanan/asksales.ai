import { choice } from './decisionContract.js';

export const SENTIMENT_LABEL_QUESTION = choice('Classify the customer\'s current emotional tone, using context and sarcasm/negation. Politeness is not buying intent, and quoted sentiment is not necessarily the customer\'s sentiment.', {
  positive: 'Genuinely pleased, appreciative or enthusiastic.',
  neutral: 'Factual, mixed or emotionally neutral.',
  negative: 'Dissatisfied, frustrated, disappointed or angry.',
});
export const SENTIMENT_QUESTIONS = {
  'sentiment.label': SENTIMENT_LABEL_QUESTION,
  intensity: choice('How strong is the expressed emotion? Classify intensity, not confidence. Neutral or unemotional content is mild.', {
    mild: 'Mild or moderate emotion, or neutral tone.', strong: 'Strong delight, anger, distress, or repeated emphatic dissatisfaction.',
  }),
};
