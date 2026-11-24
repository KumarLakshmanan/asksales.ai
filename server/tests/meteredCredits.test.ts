import { describe, expect, it } from '@jest/globals';
import { meteredCreditsFromInr, meteredCreditsFromUsd } from '../utils/currency.js';

describe('metered credit rounding', () => {
  it('rounds any non-zero cost up to a whole credit, minimum one', () => {
    expect(meteredCreditsFromInr(0.001, 10)).toBe(1);   // was 0 under Math.round for Gemini media
    expect(meteredCreditsFromInr(0.175, 10)).toBe(2);
    expect(meteredCreditsFromInr(4, 10)).toBe(40);
  });

  it('does not round float noise up by a whole credit', () => {
    expect(meteredCreditsFromInr(0.1 + 0.2, 100)).toBe(30);
  });

  it('charges nothing for zero, negative or invalid input', () => {
    expect(meteredCreditsFromInr(0, 10)).toBe(0);
    expect(meteredCreditsFromInr(-1, 10)).toBe(0);
    expect(meteredCreditsFromInr(Number.NaN, 10)).toBe(0);
    expect(meteredCreditsFromInr(1, 0)).toBe(0);
  });

  it('converts USD with the given exchange rate', () => {
    expect(meteredCreditsFromUsd(0.04, 10, 100)).toBe(40);
    expect(meteredCreditsFromUsd(0.039, 10, 100)).toBe(39);
    expect(meteredCreditsFromUsd(0, 10, 100)).toBe(0);
  });
});
