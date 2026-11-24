import { beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import nextConfig from '../../next.config';
import { activeNavigationSection, availableNavigationSections, navigationItemActive, navigationItemHref, navSections } from '@/lib/sidebarConfig';
import { buildDashboardDestinationIndex } from '@/lib/dashboard-destinations';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Element.prototype.scrollIntoView = vi.fn();
});

const clientFile = (path: string) => resolve(process.cwd(), path);
const readClientFile = (path: string) => readFileSync(clientFile(path), 'utf8');

describe('client sidebar navigation', () => {
  it('keeps Outreach entry canonical and exposes the outreach workspaces in order', () => {
    const outreach = navSections.find(section => section.section === 'outreach-agent')!;
    expect(outreach.collapsedPath).toBe('/dashboard/outreach/inbox');
    expect(outreach.children.map(item => [item.label, item.path])).toEqual([
      ['Inbox', '/dashboard/outreach/inbox'], ['New outreach', '/dashboard/outreach/create'],
      ['Message tracking', '/dashboard/outreach/tracking'],
      ['Follow-ups', '/dashboard/outreach/follow-ups'],
      ['Reports', '/dashboard/outreach/reports'],
    ]);
  });
  it.each([
    ['/dashboard/knowledge-base/documents', '/dashboard/knowledge-base/documents'],
    ['/dashboard/knowledge-base/media/12', '/dashboard/knowledge-base/media'],
    ['/dashboard/proposals/analytics', '/dashboard/proposals/analytics'],
    ['/dashboard/proposals/42', '/dashboard/proposals'],
    ['/dashboard/settings/outreach/assistants/51b5927b-1d5e-434e-81be-51eb92aebb04', '/dashboard/settings/outreach'],
    ['/dashboard/support/teams/7', '/dashboard/support/teams'],
  ])('marks only the most specific leaf on %s', (location, expected) => {
    const paths = [...new Set(navSections.flatMap(section => section.children.flatMap(item => [item.path, ...(item.children ?? []).map(child => child.path)])))];
    expect(paths.filter(path => navigationItemActive(location, path))).toEqual([expected]);
  });
  it('keeps Content Creator focused on reusable content management surfaces', () => {
    const section = navSections.find((item) => item.section === 'content-agent');

    expect(section).toBeDefined();
    expect(section?.children.map((item) => item.label)).toEqual([
      'Content library',
      'Brand Toolkit',
      'Calendar',
    ]);
    expect(section?.children.map((item) => item.path)).not.toContain('/dashboard/content');
    expect(section?.children.map((item) => item.path)).not.toContain('/dashboard/content/approvals');
    expect(section?.activePath).toBe('/dashboard/saved-templates');
    expect(section?.activeExtraPaths).toContain('/dashboard/content-calendar');
  });

  it('names destinations accurately while retaining previous names and stable section IDs', () => {
    const content = navSections.find(item => item.section === 'content-agent')!;
    expect(content.children[0]).toMatchObject({ label: 'Content library', path: '/dashboard/saved-templates', aliases: ['Templates', 'Saved templates'] });
    const assistants = navSections.find(item => item.section === 'settings')!.children.find(item => item.path === '/dashboard/settings/outreach');
    expect(assistants).toMatchObject({ label: 'Assistants', aliases: ['Outreach Settings', 'Outreach assistants'] });
    const history = navSections.find(item => item.section === 'campaigns')!;
    expect(history).toMatchObject({ label: 'Campaign History', aliases: ['Campaigns', 'Conversational campaigns'], collapsedPath: '/dashboard/chats' });
    expect(history.children[1]).toMatchObject({ label: 'All Campaigns', path: '/dashboard/chats', aliases: expect.arrayContaining(['View All']) });
    expect(navSections.find(item => item.section === 'performance-marketing')).toMatchObject({ label: 'Marketing', aliases: ['Performance Marketing'] });
  });

  it('matches the separately owned settings destinations without replacing their pages', () => {
    const settings = navSections.find(item => item.section === 'settings')!;
    expect(settings.children.find(item => item.path === '/dashboard/settings')).toMatchObject({ label: 'Account settings', aliases: ['Profile & Security'] });
    expect(settings.children.find(item => item.path === '/dashboard/settings/workspace')).toMatchObject({ label: 'Workspace config', aliases: ['Workspace configuration', 'Workspace settings'], roles: ['owner', 'billing_admin', 'member'] });
    expect(settings.children.find(item => item.path === '/dashboard/settings/outreach')).toMatchObject({ module: 'support_ai', roles: ['owner', 'billing_admin', 'member'] });
    const widget = navSections.find(item => item.section === 'support-ai')!.children.find(item => item.path === '/dashboard/support-ai/widget-settings')!;
    expect(widget).toMatchObject({ label: 'Widget settings', module: 'support_ai', roles: ['owner', 'billing_admin', 'member'], preserveQueryParams: ['team'] });
    expect(navigationItemHref(widget, new URLSearchParams('team=12&unrelated=discard'))).toBe('/dashboard/support-ai/widget-settings?team=12');
    expect(navigationItemHref(widget, new URLSearchParams())).toBe(widget.path);
  });

  it('offers a shared module/role filter for the finder without changing its index', () => {
    const supportOnly = availableNavigationSections(['outreach'], 'owner');
    const paths = supportOnly.flatMap(section => section.children.map(item => item.path));
    expect(paths).not.toContain('/dashboard/settings/outreach');
    expect(paths).not.toContain('/dashboard/settings/ads');
    expect(availableNavigationSections(['support_ai'], 'member').find(section => section.section === 'settings')!.children.map(item => item.path)).toContain('/dashboard/settings/outreach');
    expect(availableNavigationSections(['support_ai']).find(section => section.section === 'settings')!.children.map(item => item.path)).not.toContain('/dashboard/settings/outreach');
  });

  it.each([
    ['/dashboard/chat/42', 'campaigns'],
    ['/dashboard/chats', 'campaigns'],
    ['/dashboard/conversations/42', 'campaigns'],
    ['/dashboard/ads/campaigns/managed/42', 'performance-marketing'],
    ['/dashboard/ads-campaigns', 'performance-marketing'],
    ['/dashboard/crm/reminders', 'crm'],
    ['/dashboard/support-ai/chat', 'support-ai'],
    ['/dashboard/support/notifications', 'support'],
    ['/dashboard/settings/knowledge-base', 'knowledge-base'],
    ['/dashboard/settings/outreach/assistant-42', 'settings'],
  ])('identifies the most specific workspace for %s', (path, section) => {
    expect(activeNavigationSection(path)?.section).toBe(section);
  });

  it('respects path boundaries and the supplied visible sections', () => {
    expect(activeNavigationSection('/dashboard/crm-other')).toBeUndefined();
    expect(activeNavigationSection('/dashboard/crm/reminders', navSections.filter(item => item.section !== 'crm'))).toBeUndefined();
  });

  it('does not expose retired items through the shared command-palette navigation', () => {
    const palette = readClientFile('src/components/CommandPalette.tsx');
    expect(palette).not.toContain('AI Studio');
    expect(palette).not.toContain('Approvals');
    const destinations = buildDashboardDestinationIndex({ workspaceRole: 'owner' });
    expect(destinations.some(destination => destination.href === '/dashboard/content')).toBe(false);
    expect(destinations.some(destination => destination.href === '/dashboard/content/approvals')).toBe(false);
    for (const section of navSections) {
      for (const child of section.children) {
        expect(destinations.some(destination => destination.href === child.path && destination.aliases.includes(child.label))).toBe(true);
      }
    }
  });

  it('keeps WhatsApp templates behind the WhatsApp integration card', () => {
    const section = navSections.find((item) => item.section === 'integrations');
    const savedTemplates = readClientFile('src/app/dashboard/(main)/saved-templates/page.tsx');
    const whatsappIntegration = readClientFile('src/app/dashboard/(main)/integrations/whatsapp/page.tsx');

    expect(section?.children.map((item) => item.label)).not.toContain('WhatsApp Templates');
    expect(section?.children.map((item) => item.label)).not.toContain('Create WA Template');
    expect(savedTemplates).not.toContain('/dashboard/saved-templates/whatsapp');
    expect(whatsappIntegration).toContain('href="/dashboard/integrations/whatsapp/templates"');
    expect(whatsappIntegration).not.toContain('Connect WhatsApp first');
    expect(existsSync(clientFile('src/app/dashboard/(main)/integrations/whatsapp/components/WhatsAppTemplates.tsx'))).toBe(false);
  });

  it('retires direct AI Studio and approval routes without leaving hidden launch points', async () => {
    expect(existsSync(clientFile('src/app/dashboard/(main)/content/page.tsx'))).toBe(false);
    expect(existsSync(clientFile('src/app/dashboard/(main)/content/approvals/page.tsx'))).toBe(false);
    expect(existsSync(clientFile('src/components/ContentDisplay.tsx'))).toBe(false);

    const redirects = await nextConfig.redirects?.();
    expect(redirects).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: '/dashboard/content', destination: '/dashboard/content/templates' }),
      expect.objectContaining({ source: '/dashboard/content/approvals', destination: '/dashboard/content/templates' }),
    ]));

    for (const path of [
      'src/components/ChatInterface.tsx',
      'src/components/ai-visibility/AiVisibilityWorkspace.tsx',
    ]) {
      expect(readClientFile(path)).not.toMatch(/["']\/dashboard\/content["']/);
    }

    const platformAccess = readClientFile('src/lib/platform-access.ts');
    expect(platformAccess).not.toContain('["/dashboard/content", "content"]');
  });
});
