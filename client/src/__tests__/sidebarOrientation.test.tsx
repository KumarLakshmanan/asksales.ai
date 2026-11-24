import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardLayout } from '@/components/DashboardLayout';
import api from '@/lib/api';
import type { PlatformModuleKey } from '@/lib/platform-access';

const mocks = vi.hoisted(() => ({ location: '/dashboard/home', search: '', role: 'owner' as 'owner' | 'billing_admin' | 'member' | undefined, profileAvailable: true, profilesLoading: false, profilesError: false, threads: [{ id: 42, title: 'Saved campaign' }], threadsLoading: false, userId: 4101, query: vi.fn(), scroll: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => mocks.location, useSearchParams: () => new URLSearchParams(mocks.search) }));
vi.mock('next/image', () => ({ default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} /> }));
vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: mocks.userId } }) }));
vi.mock('@/hooks/use-business-profiles', () => ({ useBusinessProfiles: () => ({ activeProfile: mocks.profileAvailable ? { id: 4102, name: 'Current business', role: mocks.role } : null, isLoading: mocks.profilesLoading, isError: mocks.profilesError }) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => { mocks.query(options); return { data: { threads: mocks.threads }, isLoading: mocks.threadsLoading }; } }));
vi.mock('@/components/Header', () => ({ default: ({ onSidebarOpen }: { onSidebarOpen: () => void }) => <button onClick={onSidebarOpen}>Show sidebar</button> }));
vi.mock('@/components/BusinessProfileSwitcher', () => ({ BusinessProfileSwitcher: () => <button>Switch workspace</button> }));
vi.mock('@/components/Breadcrumbs', () => ({ Breadcrumbs: () => null }));

const modules: PlatformModuleKey[] = ['campaigns', 'lead_generation', 'content', 'performance_marketing', 'crm', 'support', 'support_ai', 'integrations', 'knowledge_base', 'outreach'];
const saved = { open: true, sections: { crm: false, support: false, campaigns: false, 'content-agent': true, integrations: false, settings: false } };
const storageKey = 'navigation:4101:sidebar';
const shell = (enabledModules = modules) => <DashboardLayout enabledModules={enabledModules}><h1>Current page</h1></DashboardLayout>;
const nav = () => within(screen.getByRole('navigation', { name: 'Primary navigation' }));
const disclosure = (name: string) => screen.getByLabelText(`${name} pages`);
const section = (name: string) => within(screen.getByRole('region', { name }));
const delayedThreads = () => Array.from({ length: 10 }, (_, index) => ({ id: 500 + index, title: `Saved campaign ${500 + index}` }));
const settleFrames = () => act(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(storageKey, JSON.stringify(saved));
  mocks.location = '/dashboard/home'; mocks.userId = 4101;
  mocks.search = ''; mocks.role = 'owner'; mocks.profileAvailable = true; mocks.profilesLoading = false; mocks.profilesError = false;
  mocks.threads = [{ id: 42, title: 'Saved campaign' }]; mocks.threadsLoading = false;
  mocks.query.mockClear(); mocks.scroll.mockClear();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Element.prototype.scrollIntoView = mocks.scroll;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('sidebar destination orientation', () => {
  it('requests the compact campaign list for the active business', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ threads: mocks.threads });
    try {
      render(shell());
      const { queryFn } = mocks.query.mock.lastCall![0] as { queryFn: () => Promise<unknown> };
      await queryFn();
      expect(get).toHaveBeenCalledWith('/api/chat/threads?limit=10&view=compact&businessProfileId=4102');
    } finally {
      get.mockRestore();
    }
  });

  it('reveals a delayed deep-linked campaign once, without moving focus or resaving preferences', async () => {
    mocks.location = '/dashboard/conversations/509'; mocks.threads = []; mocks.threadsLoading = true;
    const { rerender } = render(shell());
    await waitFor(() => expect(mocks.scroll.mock.contexts).toContain(section('Campaign History').getByRole('link', { name: 'Campaign History', current: 'location' })));
    const focused = screen.getByRole('button', { name: 'Show sidebar' }); focused.focus();
    mocks.threads = delayedThreads(); mocks.threadsLoading = false; rerender(shell());
    const current = section('Campaign History').getByRole('link', { name: 'Saved campaign 509', current: 'page' });
    await waitFor(() => expect(mocks.scroll.mock.contexts).toContain(current));
    expect(mocks.scroll).toHaveBeenCalledTimes(2);
    expect(focused).toHaveFocus();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
    // A background response or reordered list must not pull the user back.
    mocks.threads = delayedThreads().reverse(); rerender(shell()); await settleFrames();
    expect(mocks.scroll).toHaveBeenCalledTimes(2);
    expect(focused).toHaveFocus();
  });

  it('reveals Assistants after the selected profile and verified role become available', async () => {
    mocks.location = '/dashboard/settings/outreach'; mocks.profileAvailable = false; mocks.profilesLoading = true;
    const { rerender } = render(shell());
    await waitFor(() => expect(mocks.scroll.mock.contexts).toContain(section('Settings').getByRole('link', { name: 'Settings', current: 'location' })));
    expect(section('Settings').queryByRole('link', { name: 'Assistants' })).not.toBeInTheDocument();
    const focused = screen.getByRole('button', { name: 'Show sidebar' }); focused.focus();
    mocks.profileAvailable = true; mocks.profilesLoading = false; mocks.role = 'member'; rerender(shell());
    const current = section('Settings').getByRole('link', { name: 'Assistants', current: 'page' });
    await waitFor(() => expect(mocks.scroll.mock.contexts).toContain(current));
    expect(mocks.scroll).toHaveBeenCalledTimes(2);
    expect(focused).toHaveFocus();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
  });

  it.each(['wheel', 'touch', 'pointer', 'keyboard'] as const)('respects %s navigation while the current campaign is still loading', async interaction => {
    mocks.location = '/dashboard/conversations/509'; mocks.threads = []; mocks.threadsLoading = true;
    const { rerender } = render(shell());
    await waitFor(() => expect(mocks.scroll).toHaveBeenCalledTimes(1));
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' });
    if (interaction === 'wheel') fireEvent.wheel(navigation, { deltaY: -100 });
    if (interaction === 'touch') fireEvent.touchMove(navigation, { touches: [{ clientX: 100, clientY: 200 }] });
    if (interaction === 'pointer') fireEvent.pointerDown(disclosure('Campaign History'));
    if (interaction === 'keyboard') fireEvent.keyDown(disclosure('Campaign History'), { key: 'ArrowUp' });
    mocks.threads = delayedThreads(); mocks.threadsLoading = false; rerender(shell()); await settleFrames();
    expect(section('Campaign History').getByRole('link', { name: 'Saved campaign 509', current: 'page' })).toBeVisible();
    expect(mocks.scroll).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
  });

  it('ignores delayed campaign arrivals after navigating away', async () => {
    mocks.location = '/dashboard/conversations/509'; mocks.threads = []; mocks.threadsLoading = true;
    const { rerender } = render(shell());
    await waitFor(() => expect(mocks.scroll).toHaveBeenCalledTimes(1));
    mocks.location = '/dashboard/home'; rerender(shell());
    const home = nav().getByRole('link', { name: 'Home', current: 'page' });
    await waitFor(() => expect(mocks.scroll.mock.contexts).toContain(home));
    mocks.threads = delayedThreads(); mocks.threadsLoading = false; rerender(shell()); await settleFrames();
    expect(mocks.scroll).toHaveBeenCalledTimes(2);
    expect(disclosure('Campaign History')).toHaveAttribute('aria-expanded', 'false');
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
  });

  it('keeps a deliberately collapsed campaign closed when its delayed row arrives', async () => {
    mocks.location = '/dashboard/conversations/509'; mocks.threads = []; mocks.threadsLoading = true;
    const { rerender } = render(shell());
    await waitFor(() => expect(mocks.scroll).toHaveBeenCalledTimes(1));
    fireEvent.click(disclosure('Campaign History'));
    await waitFor(() => expect(disclosure('Campaign History')).toHaveAttribute('aria-expanded', 'false'));
    mocks.threads = delayedThreads(); mocks.threadsLoading = false; rerender(shell()); await settleFrames();
    expect(disclosure('Campaign History')).toHaveAttribute('aria-expanded', 'false');
    expect(section('Campaign History').getByRole('link', { name: 'Campaign History', current: 'location' })).toBeVisible();
    expect(mocks.scroll).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
  });

  it('waits until a hidden sidebar is reopened before revealing its delayed campaign', async () => {
    mocks.location = '/dashboard/conversations/509'; mocks.threads = []; mocks.threadsLoading = true;
    const { rerender } = render(shell());
    await waitFor(() => expect(mocks.scroll).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    mocks.threads = delayedThreads(); mocks.threadsLoading = false; rerender(shell()); await settleFrames();
    expect(mocks.scroll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
    const current = section('Campaign History').getByRole('link', { name: 'Saved campaign 509', current: 'page' });
    await waitFor(() => expect(mocks.scroll.mock.contexts).toContain(current));
    expect(mocks.scroll).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
  });

  it('reveals finder destinations and leaves every saved preference intact', async () => {
    const { rerender } = render(shell());
    expect(nav().getByRole('link', { name: 'Home', current: 'page' })).toBeVisible();
    expect(disclosure('CRM')).toHaveAttribute('aria-expanded', 'false');
    mocks.location = '/dashboard/crm/reminders'; rerender(shell());
    expect(section('CRM').getByRole('link', { name: 'Reminders', current: 'page' })).toBeVisible();
    expect(disclosure('CRM')).toHaveAttribute('aria-expanded', 'true');
    expect(disclosure('Support')).toHaveAttribute('aria-expanded', 'false');
    expect(disclosure('Content Creator')).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(mocks.scroll).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
  });

  it('restores an active item on deep link and remount without saving automatic toggles', async () => {
    mocks.location = '/dashboard/crm/reminders';
    const view = render(shell());
    expect(section('CRM').getByRole('link', { name: 'Reminders', current: 'page' })).toBeVisible();
    fireEvent(disclosure('CRM').closest('details')!, new Event('toggle'));
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
    view.unmount(); render(shell());
    expect(section('CRM').getByRole('link', { name: 'Reminders', current: 'page' })).toBeVisible();
    await waitFor(() => expect(disclosure('Support')).toHaveAttribute('aria-expanded', 'false'));
  });

  it('allows deliberate collapsing, saves it, and reveals on the next route visit', async () => {
    mocks.location = '/dashboard/crm/reminders';
    const { rerender } = render(shell());
    fireEvent.click(disclosure('CRM'));
    await waitFor(() => expect(disclosure('CRM')).toHaveAttribute('aria-expanded', 'false'));
    expect(section('CRM').getByRole('link', { name: 'CRM', current: 'location' })).toBeVisible();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
    mocks.location = '/dashboard/support/notifications'; rerender(shell());
    expect(section('Support').getByRole('link', { name: 'Notifications', current: 'page' })).toBeVisible();
    expect(disclosure('CRM')).toHaveAttribute('aria-expanded', 'false');
    mocks.location = '/dashboard/crm/reminders'; rerender(shell());
    expect(section('CRM').getByRole('link', { name: 'Reminders', current: 'page' })).toBeVisible();
  });

  it('separates default workspace entry from native disclosure and highlights only the destination', () => {
    mocks.location = '/dashboard/support/notifications'; render(shell());
    const support = section('Support');
    expect(support.getByRole('link', { name: 'Support' })).toHaveAttribute('href', '/dashboard/support');
    expect(disclosure('Support').tagName).toBe('SUMMARY');
    expect(disclosure('Support').querySelector('a')).toBeNull();
    expect(support.getByRole('link', { name: 'Notifications', current: 'page' })).toBeVisible();
    expect(support.getByRole('link', { name: 'Tickets' })).not.toHaveAttribute('aria-current');
    expect(document.getElementById(disclosure('Support').getAttribute('aria-controls')!)).toContainElement(support.getByRole('link', { name: 'Notifications' }));
  });

  it.each([
    ['/dashboard/settings/outreach/assistant-42', 'Settings', 'Assistants'],
    ['/dashboard/saved-templates/image/generate', 'Content Creator', 'Content library'],
    ['/dashboard/integrations/whatsapp/templates', 'Integrations', 'WhatsApp'],
    ['/dashboard/ads/campaigns/managed/42', 'Marketing', 'Paid Ads'],
    ['/dashboard/chat/42', 'Campaign History', 'Saved campaign'],
  ])('reveals the correct current item for %s', (path, workspace, label) => {
    mocks.location = path; render(shell());
    expect(section(workspace).getByRole('link', { name: label, current: 'page' })).toBeVisible();
  });

  it('keeps more specific workspace ownership and permission filters', () => {
    mocks.location = '/dashboard/settings/knowledge-base';
    const { rerender } = render(shell());
    expect(section('Knowledge Base').getByRole('link', { name: 'Knowledge Base', current: 'location' })).toBeVisible();
    expect(section('Settings').getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current');
    mocks.location = '/dashboard/crm/reminders'; rerender(shell(['content']));
    expect(screen.queryByRole('region', { name: 'CRM' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Campaign History' })).not.toBeInTheDocument();
    expect(nav().queryByRole('link', { current: 'page' })).not.toBeInTheDocument();
    expect(mocks.query).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ['chat-threads', 4102], enabled: false }));
  });

  it('gates Assistants with support_ai independently of Outreach and keeps workspace entry canonical', () => {
    mocks.location = '/dashboard/settings/outreach';
    const { rerender } = render(shell(['outreach']));
    expect(section('Settings').queryByRole('link', { name: 'Assistants' })).not.toBeInTheDocument();
    expect(section('Settings').getByRole('link', { name: 'Workspace config' })).toHaveAttribute('href', '/dashboard/settings/workspace');
    rerender(shell(['support_ai']));
    expect(section('Settings').getByRole('link', { name: 'Assistants', current: 'page' })).toBeVisible();
  });

  it.each(['owner', 'billing_admin', 'member'] as const)('uses the selected %s workspace role for support administration', role => {
    mocks.role = role; mocks.location = '/dashboard/support'; render(shell());
    const support = section('Support');
    expect(Boolean(support.queryByRole('link', { name: 'Teams' }))).toBe(role === 'owner');
    expect(Boolean(support.queryByRole('link', { name: 'Notifications' }))).toBe(role === 'owner');
  });

  it.each(['loading', 'error', 'missing role'] as const)('withholds workspace configuration links during %s', state => {
    mocks.location = '/dashboard/settings';
    mocks.profilesLoading = state === 'loading'; mocks.profilesError = state === 'error';
    if (state === 'missing role') mocks.role = undefined;
    render(shell());
    const settings = section('Settings');
    expect(settings.getByRole('link', { name: 'Account settings', current: 'page' })).toBeVisible();
    for (const name of ['Workspace config', 'Staff', 'Assistants']) expect(settings.queryByRole('link', { name })).not.toBeInTheDocument();
  });

  it('keeps the widget team query when following its current navigation entry', () => {
    mocks.location = '/dashboard/support-ai/widget-settings'; mocks.search = 'team=70&tab=appearance'; render(shell());
    expect(section('Support AI').getByRole('link', { name: 'Widget settings', current: 'page' })).toHaveAttribute('href', '/dashboard/support-ai/widget-settings?team=70');
  });
});
