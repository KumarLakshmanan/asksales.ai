import path from 'node:path';
import { test, expect, installAppShellMocks, expectNoHorizontalOverflow } from './fixtures/app';

const sections = [
  ['Conversations', 'Conversations'], ['Sent', 'Sent outreach'],
  ['Timeline', 'Relationship timeline'], ['Activity', 'Activity timeline'], ['Tickets', 'Support tickets'],
] as const;

for (const width of [390, 615, 914, 1280, 1440]) {
  test(`CRM history labels and counts remain inside their tabs at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/**', route => route.fulfill({ json: [] }));
    await installAppShellMocks(page);
    for (const count of [0, 123456]) {
      await page.route('**/api/crm/contacts/-1546**', route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/workspace-summary')) return route.fulfill({ json: { success: true, data: { counts: { conversations: count, sentMessages: count, activities: count, tickets: count, openTickets: 0, unreadConversations: 0 } } } });
        if (/\/(conversations|activities|timeline|tickets)$/.test(url.pathname)) return route.fulfill({ json: { success: true, data: [], conversations: [], sentMessages: [], tickets: [] } });
        return route.fulfill({ json: { success: true, data: { id: -1546, name: 'QA Browser Test 20261026', email: 'qa-browser-20261026@example.com', pipelineStatus: 'new', source: 'manual' } } });
      });
      await page.goto(`/dashboard/crm/contacts/-1546${count ? '?stressCounts=1' : ''}`);
      const tabs = page.getByRole('tablist', { name: 'Contact history sections', exact: true });
      await expect(tabs).toBeVisible();
      for (const [label, heading] of sections) {
        const name = label === 'Timeline' ? label : `${label} ${count}`;
        const tab = tabs.getByRole('tab', { name, exact: true });
        await expect(tab).toBeVisible();
        expect(await tab.evaluate(node => {
          const rect = node.getBoundingClientRect();
          return rect.height >= 44 && node.scrollWidth <= node.clientWidth + 1
            && [...node.children].every(child => {
              const childRect = child.getBoundingClientRect();
              return childRect.left >= rect.left && childRect.right <= rect.right;
            });
        }), `${name} must contain its icon, full label and count`).toBe(true);
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      }
      const last = tabs.getByRole('tab', { name: `Tickets ${count}`, exact: true });
      await last.focus();
      await page.keyboard.press('Home');
      const first = tabs.getByRole('tab', { name: `Conversations ${count}`, exact: true });
      await expect(first).toBeFocused();
      await expect(first).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('ArrowRight');
      await expect(tabs.getByRole('tab', { name: `Sent ${count}`, exact: true })).toBeFocused();
      await page.keyboard.press('Home');
      await expect(first).toHaveAttribute('aria-selected', 'true');
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: path.resolve(`../qa-results/2026-10-26/responsive-ui/crm-history-${width}-${count}.png`) });
    }
  });
}
