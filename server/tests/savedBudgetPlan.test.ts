import { describe, expect, it } from '@jest/globals';
import { describeSavedBudgetPlan } from '../mastra/utils/savedBudgetPlan.js';

describe('budget plan saved from the Performance Marketing tab', () => {
  it('gives Sarah the total, daily figure and split as a proposal to confirm', () => {
    const note = describeSavedBudgetPlan({
      total_budget: '30000.00', duration_days: 30, currency: 'inr', daily_budget: '1000.00',
      channel_allocation: [{ channel: 'Meta', percentage: 60 }, { channel: 'Google', percentage: 40 }],
    });
    expect(note).toContain('INR 30,000 over 30 days, about INR 1,000 per day; split: Meta 60%, Google 40%');
    expect(note).toContain('proposal, not the explicit budget');
  });

  it('works out the daily figure when the plan has none', () => {
    expect(describeSavedBudgetPlan({ total_budget: 3000, duration_days: 10, currency: 'USD' })).toContain('about USD 300 per day');
  });

  it('says nothing when there is no usable plan', () => {
    expect(describeSavedBudgetPlan(null)).toBe('');
    expect(describeSavedBudgetPlan({ total_budget: 0, duration_days: 30, currency: 'USD' })).toBe('');
  });
});
