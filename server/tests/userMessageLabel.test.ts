import { describe, expect, it } from '@jest/globals';
import { outreachPrepareLabel, shortDisplayContent } from '../mastra/userMessageLabel.js';
import { sendMessageSchema } from '../middleware/schemas.js';

describe('short chat labels for button-sent instructions', () => {
  it('names the channel and counts leads in plain words', () => {
    expect(outreachPrepareLabel('whatsapp', 1)).toBe('Prepare WhatsApp outreach for 1 selected lead');
    expect(outreachPrepareLabel('email', 3)).toBe('Prepare Email outreach for 3 selected leads');
    expect(outreachPrepareLabel(null, 2)).toBe('Prepare outreach for 2 selected leads');
  });

  it('keeps a label only when it is text that differs from the instruction', () => {
    expect(shortDisplayContent('  Prepare  outreach\n', 'Use exactly these lead IDs: 4')).toBe('Prepare outreach');
    expect(shortDisplayContent('Same text', 'Same text')).toBeUndefined();
    expect(shortDisplayContent(42, 'text')).toBeUndefined();
    expect(shortDisplayContent('x'.repeat(400), 'text')).toHaveLength(200);
  });

  it('is accepted by the HTTP chat message check', () => {
    expect(sendMessageSchema.safeParse({ content: 'full instruction', displayContent: 'Short label' }).success).toBe(true);
  });
});
