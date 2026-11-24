import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SidebarMenuGroup } from '@/components/SidebarMenuGroup';
import { navSections, type NavSection } from '@/lib/sidebarConfig';

describe('sidebar menu groups', () => {
  beforeEach(() => localStorage.clear());

  it('shows every integration directly under a small heading without the overview link or right-side markers', () => {
    const section = navSections.find(item => item.section === 'integrations')!;
    const { container } = render(<SidebarMenuGroup section={section} isItemActive={() => false} />);
    const group = screen.getByRole('region', { name: 'Integrations' });

    expect(within(group).getAllByRole('link').map(link => link.textContent)).toEqual([
      'Instagram', 'WhatsApp', 'Facebook', 'Email', 'Meta Ads', 'Google Ads', 'SMS', 'YouTube',
    ]);
    expect(within(group).queryByRole('link', { name: 'All Integrations' })).not.toBeInTheDocument();
    expect(group.className).not.toContain('border-t');
    expect(container.querySelector('[style*="background-color"]')).toBeNull();
  });

  it('collapses and expands a section with the keyboard and remembers the preference', async () => {
    const user = userEvent.setup();
    const section = navSections.find(item => item.section === 'integrations')!;
    const { unmount } = render(<SidebarMenuGroup section={section} isItemActive={() => false} />);
    const toggle = screen.getByRole('button', { name: 'Integrations' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Instagram' })).not.toBeInTheDocument();
    expect(localStorage.getItem('sidebar-section:integrations:expanded')).toBe('false');

    unmount();
    render(<SidebarMenuGroup section={section} isItemActive={() => false} />);
    const restoredToggle = screen.getByRole('button', { name: 'Integrations' });
    expect(restoredToggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(restoredToggle);
    expect(restoredToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Instagram' })).toBeVisible();
  });

  it('supports direct links and dropdown menus together within one section', async () => {
    const section: NavSection = {
      section: 'example', label: 'Example', presentation: 'group',
      activePath: '/dashboard/example', collapsedPath: '/dashboard/example', collapsedIcon: null,
      children: [
        { label: 'Direct', path: '/dashboard/example/direct' },
        { label: 'Menu', path: '/dashboard/example/menu', children: [
          { label: 'Nested', path: '/dashboard/example/menu/nested' },
        ] },
      ],
    };
    render(<SidebarMenuGroup section={section} isItemActive={() => false} />);

    expect(screen.getByRole('link', { name: 'Direct' })).toHaveAttribute('href', '/dashboard/example/direct');
    const dropdown = screen.getByText('Menu').closest('details')!;
    expect(dropdown).not.toHaveAttribute('open');
    await userEvent.click(within(dropdown).getByText('Menu'));
    expect(dropdown).toHaveAttribute('open');
    expect(within(dropdown).getByRole('link', { name: 'Nested' })).toHaveAttribute('href', '/dashboard/example/menu/nested');
  });
});
