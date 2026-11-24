import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanCards } from '@/components/pricing/PlanCards';
import { SUBSCRIPTION_PLANS } from '../../../shared/subscriptions';

afterEach(cleanup);

describe('Organization pricing purchase identity', () => {
  it('reserves the emphasized card border for the recommended plan', () => {
    render(<PlanCards plans={SUBSCRIPTION_PLANS} term="monthly" selected="starter" onSelect={vi.fn()} />);
    const starter = screen.getByRole('article', { name: 'Starter plan' });
    const growth = screen.getByRole('article', { name: 'Growth plan' });
    expect(starter).not.toHaveClass('ring-2');
    expect(starter).toHaveClass('border-border');
    expect(within(starter).getByRole('button', { name: 'Selected: Starter' })).toHaveAttribute('aria-pressed', 'true');
    expect(growth).toHaveClass('ring-1', 'ring-primary');
  });
  it('does not mark a legacy plan with the same slug as the current catalog plan', () => {
    render(<PlanCards plans={SUBSCRIPTION_PLANS} term="monthly" current={{ version: 1, plan: 'starter', term: 'monthly' }} />);
    const starter = screen.getByRole('article', { name: 'Starter plan' });
    expect(within(starter).getByRole('link', { name: 'Choose Starter' })).toHaveAttribute('href', '/subscribe?plan=starter&term=monthly&version=2');
    expect(within(starter).queryByRole('button', { name: 'Current plan' })).toBeNull();
  });
  it('disables the exact purchased version, plan and term', () => {
    const select = vi.fn();
    render(<PlanCards plans={SUBSCRIPTION_PLANS} term="monthly" current={{ version: 2, plan: 'growth', term: 'monthly' }} onSelect={select} />);
    expect(within(screen.getByRole('article', { name: 'Growth plan' })).getByRole('button', { name: 'Current plan' })).toBeDisabled();
    expect(select).not.toHaveBeenCalled();
  });
  it('allows changing the billing term and links the published version', () => {
    render(<PlanCards plans={SUBSCRIPTION_PLANS} term="yearly" current={{ version: 2, plan: 'growth', term: 'monthly' }} />);
    const growth = within(screen.getByRole('article', { name: 'Growth plan' }));
    expect(growth.getByRole('link', { name: 'Choose Growth' })).toHaveAttribute('href', '/subscribe?plan=growth&term=yearly&version=2');
    expect(growth.getByText(/₹14,400 billed yearly/)).toBeInTheDocument();
    expect(growth.getByText('₹1,200')).toBeInTheDocument();
  });
  it('shows read-only billing actions to staff members', () => {
    render(<PlanCards plans={SUBSCRIPTION_PLANS} term="monthly" canManageBilling={false} />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    const actions = screen.getAllByRole('button', { name: 'Ask your business owner' });
    expect(actions).toHaveLength(3);
    actions.forEach(action => expect(action).toBeDisabled());
  });
});
