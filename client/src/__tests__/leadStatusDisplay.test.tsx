import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_LEAD_FORM, LeadForm } from '@/components/leads/LeadForm';
import { LeadDetailSheet } from '@/components/LeadDetailSheet';
import LeadViewPage from '@/app/dashboard/(main)/leads/view/[id]/page';
import type { Lead } from '@/models/lead';
import { api } from '@/lib/api';
import { LEAD_STATUSES } from '../../../shared/leadStatus';

const navigation = vi.hoisted(() => ({ params: { id: '42' }, router: { push: vi.fn() }, toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('next/navigation', () => ({ useParams: () => navigation.params, useRouter: () => navigation.router }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: navigation.toast }) }));

describe('consistent lead status display', () => {
  it.each(LEAD_STATUSES)('represents saved %s in the edit form', status => {
    render(<LeadForm value={{ ...EMPTY_LEAD_FORM, leadStatus: status }} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Pipeline status' })).toHaveTextContent(status[0].toUpperCase() + status.slice(1));
  });

  it.each([
    { leadStatus: 'qualified', status: 'replied', label: 'Qualified' },
    { leadStatus: null, status: 'replied', label: 'Replied' },
  ])('uses pipeline status and legacy fallback in both detail surfaces: $label', async ({ label, ...statuses }) => {
    const lead = { id: 42, name: 'Status QA', email: 'status@example.test',
      source: 'manual', score: 0, createdAt: '2026-10-09T12:00:00Z', ...statuses };
    vi.mocked(api.get).mockImplementation((url: string) => Promise.resolve(url === '/api/leads/42' ? lead : []) as never);
    const page = render(<LeadViewPage />);
    expect(await screen.findByText(label)).toBeInTheDocument();
    page.unmount();
    render(<LeadDetailSheet lead={lead as Lead} open onOpenChange={vi.fn()} outreachLocked />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
