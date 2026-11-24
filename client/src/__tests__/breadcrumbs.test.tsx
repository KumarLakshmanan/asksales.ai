import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Breadcrumbs } from '@/components/Breadcrumbs';

const navigation = vi.hoisted(() => ({ pathname: '/dashboard/leads/view/1490' }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 1 } }) }));
vi.mock('@/lib/business-profile', () => ({ selectedBusinessProfileId: () => 1 }));

afterEach(cleanup);

function renderBreadcrumbs(pathname: string) {
  navigation.pathname = pathname;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Breadcrumbs />
    </QueryClientProvider>,
  );
}

function expectTrail(labels: string[], destinations: string[], currentLabel: string) {
  const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
  const links = within(breadcrumb).getAllByRole('link');
  expect(links.map(link => link.getAttribute('href'))).toEqual(destinations);
  expect(links.map(link => link.getAttribute('aria-label') || link.textContent)).toEqual(labels);
  const current = within(breadcrumb).getByText(currentLabel);
  expect(current).toHaveAttribute('aria-current', 'page');
  expect(current.tagName).toBe('SPAN');
  expect(current.closest('a')).toBeNull();
  expect(current).not.toHaveAttribute('tabindex');
  expect(breadcrumb.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
}

describe('dashboard breadcrumbs', () => {
  it('keeps acronyms such as CRM upper-case instead of title-casing the route', () => {
    renderBreadcrumbs('/dashboard/crm/import/analyze');
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByText('CRM')).toBeInTheDocument();
    expect(within(breadcrumb).queryByText('Crm')).not.toBeInTheDocument();
  });

  it('gives assistant settings a readable trail without an internal UUID or collection link', () => {
    renderBreadcrumbs('/dashboard/settings/outreach/assistants/51b5927b-1d5e-434e-81be-51eb92aebb04');
    expectTrail(['Home dashboard', 'Settings', 'Assistants'], ['/dashboard/home', '/dashboard/settings', '/dashboard/settings/outreach'], 'Assistant settings');
    expect(screen.queryByText(/51b5927b/)).not.toBeInTheDocument();
  });
  it.each(['1490', '42'])('links only to real parents for lead %s', id => {
    renderBreadcrumbs(`/dashboard/leads/view/${id}`);
    expectTrail(['Home dashboard', 'Leads'], ['/dashboard/home', '/dashboard/leads'], `Lead #${id}`);
    expect(screen.queryByText('View')).not.toBeInTheDocument();
  });

  it('omits the nonexistent edit parent on the sibling lead route', () => {
    renderBreadcrumbs('/dashboard/leads/edit/1490');
    expectTrail(['Home dashboard', 'Leads'], ['/dashboard/home', '/dashboard/leads'], 'Edit lead #1490');
  });

  it('accepts a trailing slash on lead details', () => {
    renderBreadcrumbs('/dashboard/leads/view/1490/');
    expectTrail(['Home dashboard', 'Leads'], ['/dashboard/home', '/dashboard/leads'], 'Lead #1490');
  });

  it('preserves another detail route using the shared component', () => {
    renderBreadcrumbs('/dashboard/proposals/42');
    expectTrail(['Home dashboard', 'Proposals'], ['/dashboard/home', '/dashboard/proposals'], '42');
  });

  it('preserves semantic support trails without a nonexistent members link', () => {
    renderBreadcrumbs('/dashboard/support/teams/7/members/8');
    expectTrail(
      ['Home dashboard', 'Support', 'Teams', 'Team settings'],
      ['/dashboard/home', '/dashboard/support', '/dashboard/support/teams', '/dashboard/support/teams/7'],
      'Member tickets',
    );
  });

  it('preserves the Leads list current page', () => {
    renderBreadcrumbs('/dashboard/leads');
    expectTrail(['Home dashboard'], ['/dashboard/home'], 'Leads');
  });

  it.each(['/dashboard', '/dashboard/home', '/'])('hides the trail on %s', pathname => {
    renderBreadcrumbs(pathname);
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
  });
});
