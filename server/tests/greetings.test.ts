import { describe, it, expect } from '@jest/globals';
import { isConversationalMessage, listLocales } from '../shared/agents/greetings';

describe('greetings.json loader (Phase 7.4 / LANG-004)', () => {
  it('exposes en and hi locales', () => {
    const locales = listLocales();
    expect(locales).toContain('en');
    expect(locales).toContain('hi');
  });

  it('matches English conversational openers', () => {
    expect(isConversationalMessage('hi')).toBe(true);
    expect(isConversationalMessage('Hello!')).toBe(true);
    expect(isConversationalMessage('thanks a lot')).toBe(true);
    expect(isConversationalMessage('good morning')).toBe(true);
  });

  it('does NOT match task-bearing messages', () => {
    expect(isConversationalMessage('Create an email campaign for me.')).toBe(false);
    expect(isConversationalMessage('Find me 50 leads on LinkedIn.')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(isConversationalMessage('')).toBe(false);
    expect(isConversationalMessage('   ')).toBe(false);
  });

  it('falls back to English when an unknown locale is requested', () => {
    // No throw, matches English pattern
    expect(isConversationalMessage('hi', 'fr-CA')).toBe(true);
  });

  it('matches Hindi conversational openers', () => {
    expect(isConversationalMessage('namaste', 'hi')).toBe(true);
    expect(isConversationalMessage('dhanyavaad', 'hi')).toBe(true);
  });
});
