import { describe, expect, it } from '@jest/globals';
import { hotelNegotiationToolPolicy } from '../services/agents/orchestration/HotelToolPolicy.js';
import { semanticIntent } from './helpers/supportSemanticFixture.js';

describe('hotel tool exposure policy', () => {
  it('does not expose negotiation tools for a room selection or booking summary', () => {
    expect(hotelNegotiationToolPolicy(
      semanticIntent('booking', 'stay'),
    )).toEqual({ allowNegotiation: false, allowObjectionHandling: false });
  });

  it('exposes negotiation and objection help only for current-turn signals', () => {
    expect(hotelNegotiationToolPolicy(semanticIntent('negotiation', 'stay')))
      .toEqual({ allowNegotiation: true, allowObjectionHandling: true });
    expect(hotelNegotiationToolPolicy(semanticIntent('objection', 'stay')))
      .toEqual({ allowNegotiation: false, allowObjectionHandling: true });
  });
  it('does not guess on absent or uncertain classifications', () => {
    for (const request of [undefined, semanticIntent('negotiation', 'stay', { confidence: 0.2 }),
      semanticIntent('negotiation', 'stay', { explicit: false })]) {
      expect(hotelNegotiationToolPolicy(request)).toEqual({ allowNegotiation: false, allowObjectionHandling: false });
    }
  });
});
