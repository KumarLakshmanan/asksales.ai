import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LeadsPage from '@/app/dashboard/(main)/leads/page';
import { api } from '@/lib/api';
import { leadColumnPreferenceKey, leadSourceLabel, parseLeadColumnPreferences } from '@/lib/lead-directory-display';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const lead = { id: 7, name: 'Alexandra Example with a long name', company: 'Example Research', role: 'Director', email: 'alexandra.long.address@example.test', phone: '+1 555 0100', source: 'crm_import', status: 'qualified', score: 91, repliedEmails: 1, campaignData: { campaignName: 'Example campaign' } };

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(url => Promise.resolve(url === '/api/leads/stats' ? { success: false } : { data: [lead], total: 1, totalPages: 1 }) as never);
  vi.mocked(api.put).mockResolvedValue({} as never);
});

describe('lead directory presentation', () => {
  it('prioritizes qualification and actions, and reveals every secondary field', async () => {
    render(<LeadsPage />);
    const table = within(await screen.findByRole('table', { name: 'Leads list' }));
    expect(table.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['', 'Name / Company', 'Status', 'Engagement', 'Quality score', 'Actions']);
    const disclosure = table.getByRole('button', { name: `Contact details for ${lead.name}` });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const details = within(document.getElementById('lead-contact-7')!);
    for (const text of [lead.name, lead.company, lead.role, lead.email, lead.phone, 'Example campaign', 'CRM import']) {
      expect(details.getByText(text)).toBeVisible();
    }
    fireEvent.click(disclosure);
    expect(details.getByText(lead.email)).not.toBeVisible();
    expect(table.getByText('Replied')).toBeVisible();
    expect(table.getByRole('button', { name: 'View lead details' })).toBeVisible();
  });

  it('keeps name, company and role editable in the expanded row', async () => {
    render(<LeadsPage />);
    const table = within(await screen.findByRole('table', { name: 'Leads list' }));
    fireEvent.click(table.getByRole('button', { name: 'Edit lead' }));
    fireEvent.change(table.getByRole('textbox', { name: 'Edit name' }), { target: { value: 'Updated Example' } });
    fireEvent.change(table.getByRole('textbox', { name: 'Edit company' }), { target: { value: 'Updated Company' } });
    fireEvent.change(table.getByRole('textbox', { name: 'Edit role' }), { target: { value: 'Updated Role' } });
    fireEvent.click(table.getByRole('button', { name: 'Save' }));
    expect(api.put).toHaveBeenCalledWith('/api/leads/7', { name: 'Updated Example', company: 'Updated Company', role: 'Updated Role' });
    expect(await table.findByRole('button', { name: 'Updated Example' })).toBeVisible();
  });

  it('restores only supported column preferences', async () => {
    localStorage.setItem(leadColumnPreferenceKey, '["email","source","unknown"]');
    render(<LeadsPage />);
    const table = within(await screen.findByRole('table', { name: 'Leads list' }));
    expect(table.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['', 'Name / Company', 'Status', 'Engagement', 'Quality score', 'Email', 'Source', 'Actions']);
    expect(parseLeadColumnPreferences('invalid')).toEqual([]);
    expect(parseLeadColumnPreferences('{}')).toEqual([]);
    expect(parseLeadColumnPreferences('["phone","phone","email",7]')).toEqual(['email', 'phone']);
  });

  it.each([['crm_import', 'CRM import'], ['manual', 'Manual entry'], ['csv_import', 'CSV import'], ['instagram_webhook', 'Instagram Webhook'], ['custom-source_name', 'Custom Source Name'], ['', '—']])('formats source %s as %s without changing source identifiers', (value, label) => {
    expect(leadSourceLabel(value)).toBe(label);
  });
});
