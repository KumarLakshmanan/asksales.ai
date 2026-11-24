import { describe, expect, it } from '@jest/globals';
import { routeCriticalBusinessJourney, routeMessageFallback, routeNavigationFallback } from '../mastra/routerFallback.js';

describe('legacy router compatibility fails closed', () => {
  it.each([
    'Find leads and write content, but do not send outreach',
    'Prepare ads but do not launch',
    'Open the leads page',
    'Continue',
    'சரி, அடுத்த படிக்குச் செல்லலாம்',
  ])('does not guess a direction from %s', message => {
    expect(routeCriticalBusinessJourney(message)).toBeNull();
    expect(routeNavigationFallback(message)).toBeNull();
    expect(routeMessageFallback(message)).toMatchObject({
      needsClarification: true, nextAgent: null, hiredAgents: [], isAffirmative: false,
    });
  });
});
