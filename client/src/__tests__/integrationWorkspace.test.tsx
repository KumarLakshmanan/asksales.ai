import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationWorkspace } from '@/components/integrations/IntegrationWorkspace';
import { integrationDefinitions, googleAdsState, metaAdsState, messagingState, whatsappState } from '@/lib/integrations';
import { navSections } from '@/lib/sidebarConfig';

afterEach(cleanup);

describe('integration workspace', () => {
  it('exposes every integration as a direct sidebar link and keeps the overview out of the sidebar', () => {
    const section = navSections.find(item => item.section === 'integrations');
    expect(section?.presentation).toBe('group');
    expect(section?.children.map(item => item.label)).toEqual(integrationDefinitions.map(item => item.name));
    expect(section?.children.map(item => item.path)).toEqual(integrationDefinitions.map(item => `/dashboard/integrations/${item.id}`));
    expect(section?.children).not.toContainEqual(expect.objectContaining({ path: '/dashboard/integrations' }));
  });
  it.each(integrationDefinitions)('renders $name disconnected with an actionable connection button', async provider => {
    const connect = vi.fn();
    render(<IntegrationWorkspace provider={provider.id} state="disconnected" onConnect={connect} />);
    expect(screen.getByRole('heading', { name: `Connect ${provider.name}` })).toBeInTheDocument();
    expect(screen.getByText(provider.prerequisite)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: provider.connectLabel }));
    expect(connect).toHaveBeenCalledOnce();
  });
  it('offers direct Instagram consent and explains professional-account eligibility', () => {
    render(<IntegrationWorkspace provider="instagram" state="disconnected" onConnect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Continue with Instagram' })).toBeInTheDocument();
    expect(screen.getByText(/No Facebook Page is required/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect with Facebook' })).not.toBeInTheDocument();
  });
  it('links email outreach directly to the filtered Inbox while keeping connection gating', () => {
    const { rerender } = render(<IntegrationWorkspace provider="email" state="connected" onConnect={vi.fn()} />);
    expect(screen.getByRole('link', { name: /Email outreach/ })).toHaveAttribute('href', '/dashboard/outreach/inbox?channel=email');
    rerender(<IntegrationWorkspace provider="email" state="disconnected" onConnect={vi.fn()} />);
    expect(screen.getByText('Email outreach')).toBeVisible();
    expect(screen.queryByRole('link', { name: /Email outreach/ })).not.toBeInTheDocument();
  });
  it('authorizes the direct Instagram publishing scope when a direct account is connected', async () => {
    const authorize = vi.fn();
    render(<IntegrationWorkspace provider="instagram" state="connected" onConnect={vi.fn()} onAuthorizeFeature={authorize} capabilities={[
      { scope: 'instagram_business_content_publish', tokenGranted: false, status: 'limited', appReviewStatus: 'approved' },
    ]} />);
    await userEvent.click(screen.getByRole('button', { name: /Content publishing/ }));
    expect(authorize).toHaveBeenCalledWith('instagram_business_content_publish');
  });
  it('opens account setup when authorization alone is not enough for Google Ads', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<IntegrationWorkspace provider="google-ads" state="action_required" accountName="Customer 123" onConnect={vi.fn()} completeSetup settings={<div>Customer configuration</div>} />);
    expect(screen.getByText('Customer configuration')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Complete setup' }));
    expect(screen.getByText('Customer configuration')).toBeVisible();
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
  it('shows a retry for unavailable status instead of a successful connection', async () => {
    const retry = vi.fn();
    render(<IntegrationWorkspace provider="instagram" state="unavailable" message="Could not check Instagram" onConnect={vi.fn()} onRetry={retry} />);
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it('offers incremental authorization only for approved available features', async () => {
    const authorize = vi.fn();
    render(<IntegrationWorkspace provider="instagram" state="connected" accountName="orchid" onConnect={vi.fn()} onAuthorizeFeature={authorize} capabilities={[
      { scope: 'instagram_content_publish', tokenGranted: false, status: 'limited', appReviewStatus: 'approved' },
      { scope: 'instagram_manage_insights', tokenGranted: false, status: 'blocked', appReviewStatus: 'pending' },
    ]} />);
    await userEvent.click(screen.getByRole('button', { name: /Content publishing/ }));
    expect(authorize).toHaveBeenCalledWith('instagram_content_publish');
    expect(screen.queryByRole('link', { name: /Account analytics/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Account analytics/ })).not.toBeInTheDocument();
  });
  it.each(['meta', 'google-ads'] as const)('uses explicit tab and platform state for %s safe entries without invoking provider actions', provider => {
    const connect = vi.fn(); const disconnect = vi.fn(); const authorize = vi.fn();
    render(<IntegrationWorkspace provider={provider} state="connected" onConnect={connect} onDisconnect={disconnect} onAuthorizeFeature={authorize} />);
    const platform = provider === 'meta' ? 'meta' : 'google';
    expect(screen.getByRole('link', { name: /Paid campaigns/ })).toHaveAttribute('href', `/dashboard/ads?tab=campaigns&platform=${platform}`);
    expect(screen.getByRole('link', { name: /Ad performance/ })).toHaveAttribute('href', `/dashboard/ads?tab=overview&platform=${platform}`);
    expect(connect).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
  });
  it.each(['instagram', 'facebook'] as const)('selects the matching social analytics platform for %s', provider => {
    const definition = integrationDefinitions.find(item => item.id === provider)!;
    const feature = definition.features.find(item => item.name.endsWith('analytics'))!;
    render(<IntegrationWorkspace provider={provider} state="connected" onConnect={vi.fn()} capabilities={[
      { scope: feature.scope!, tokenGranted: true, status: 'available', appReviewStatus: 'approved' },
    ]} />);
    expect(screen.getByRole('link', { name: new RegExp(feature.name) })).toHaveAttribute('href', `/dashboard/marketing/analytics?tab=overview&platform=${provider}`);
  });
  it.each(['instagram', 'facebook', 'youtube'] as const)('opens the saved-post chooser required before publishing for %s', provider => {
    const definition = integrationDefinitions.find(item => item.id === provider)!;
    const feature = definition.features.find(item => item.name.endsWith('publishing'))!;
    render(<IntegrationWorkspace provider={provider} state="connected" onConnect={vi.fn()} capabilities={feature.scope ? [
      { scope: feature.scope, tokenGranted: true, status: 'available', appReviewStatus: 'approved' },
    ] : []} />);
    expect(screen.getByRole('link', { name: new RegExp(feature.name) })).toHaveAttribute('href', '/dashboard/saved-templates/social');
  });
  it('describes YouTube settings as channel tools and opens them without connecting', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const connect = vi.fn();
    render(<IntegrationWorkspace provider="youtube" state="connected" onConnect={connect} settings={<h3>YouTube Studio tools</h3>} />);
    await userEvent.click(screen.getByRole('button', { name: /Channel tools/ }));
    expect(screen.getByRole('heading', { name: 'YouTube Studio tools' })).toBeVisible();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('truthful connection states', () => {
  it('keeps authorization, account selection and readiness separate', () => {
    const account = { connected: false, authorized: true, tokenExpired: false, username: 'orchid', expiresAt: null };
    expect(messagingState({ ...account, selectionRequired: true })).toBe('selection');
    expect(messagingState(account)).toBe('action_required');
    expect(messagingState({ ...account, requiresReconnect: true })).toBe('reconnect');
    expect(messagingState({ ...account, connected: true }, 'network failed')).toBe('unavailable');
    expect(googleAdsState({ hasRefreshToken: true, ready: false })).toBe('action_required');
    expect(metaAdsState({ isActive: true, selectionRequired: true })).toBe('selection');
    expect(metaAdsState({ isActive: true, adAccountId: '100', pageId: 'page-1', capabilities: [{ scope: 'ads_management', tokenGranted: false, status: 'limited', appReviewStatus: 'approved' }] })).toBe('action_required');
    expect(whatsappState({ configured: true, config: { connectionStatus: 'action_required' } })).toBe('action_required');
    expect(whatsappState({ configured: true, enabled: false, config: { connectionStatus: 'ready' } })).toBe('paused');
  });
});
