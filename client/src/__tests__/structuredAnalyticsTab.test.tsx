import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StructuredAnalyticsTab from '@/components/tabs/StructuredAnalyticsTab';

describe('structured chat analytics', () => {
  it('shows the returned scope and unavailable measurements honestly', () => {
    render(<StructuredAnalyticsTab data={{ scopeLabel: 'Current conversation #226', queryType: 'campaign', analyticsData: [], visualizations: [{ title: 'Spend by Campaign', data: [] }] }} />);
    expect(screen.getByText('Current conversation #226')).toBeInTheDocument();
    expect(screen.getByText('No data is available for this view.')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
  it('labels currency and renders a true zero-width bar for a measured zero', () => {
    render(<StructuredAnalyticsTab data={{ analyticsData: [], visualizations: [{ title: 'Spend', data: [{ label: 'Measured campaign', value: 0, currency: 'INR' }] }] }} />);
    expect(screen.getByText('INR 0')).toBeInTheDocument();
    expect(screen.getByRole('progressbar').firstElementChild).toHaveStyle({ width: '0%' });
  });
});
