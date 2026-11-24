import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublishPostWidget } from '@/components/widgets/PublishPostWidget';
import type { WidgetState } from '@/components/widgets/types';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/lib/api', () => ({ default: { get: mocks.get } }));

const widget: WidgetState = {
  id: 8,
  threadId: 3,
  messageId: null,
  toolName: 'publish_social_post',
  widgetType: 'publish_post',
  formValues: { content_asset_id: 41, platform: 'instagram', caption: 'Shared launch copy' },
  status: 'active',
  agentType: 'content_studio',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

describe('PublishPostWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockImplementation((path: string) => {
      if (path.includes('/assets/')) return Promise.resolve({ id: 41, version: 1, publishingReviewToken: 'fixture-review', title: 'Launch', content: JSON.stringify({ caption: 'Shared launch copy' }), imageUrl: '/uploads/launch.jpg' });
      if (path.includes('/publishing/accounts')) return Promise.resolve({ accounts: [
        { credentialId: 10, platform: 'instagram', accountName: 'Old profile', providerAccountId: 'ig-1', expired: false },
        { credentialId: 11, platform: 'instagram', accountName: 'Launch profile', providerAccountId: 'ig-2', expired: false, isSelected: true },
        { credentialId: 20, platform: 'facebook', accountName: 'Launch Page', providerAccountId: 'fb-1', expired: false, isSelected: true },
      ] });
      return Promise.resolve({ capabilities: [] });
    });
  });

  it('reviews multiple connected targets and keeps each integration-selected credential', async () => {
    const onFormChange = vi.fn();
    render(<PublishPostWidget widget={widget} onClose={vi.fn()} onSubmit={vi.fn()} onFormChange={onFormChange} />);

    expect(await screen.findByText('Launch profile · Default')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Facebook/ }));
    expect(screen.getByRole('region', { name: 'Instagram destination settings' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Facebook destination settings' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Instagram destination settings' })).toHaveTextContent('Launch profile');
    expect(screen.getByRole('combobox', { name: 'Instagram connected account' })).toHaveTextContent('Launch profile');
    expect(screen.getByRole('region', { name: 'Facebook destination settings' })).toHaveTextContent('Launch Page');
    expect(screen.queryByRole('combobox', { name: 'Facebook connected account' })).not.toBeInTheDocument();

    await waitFor(() => {
      const latest = onFormChange.mock.calls.at(-1)?.[0] as { targets?: Array<{ platform: string; credentialId: number; postType: string }> };
      expect(latest).toMatchObject({ expected_version: 1, expected_review_token: 'fixture-review' });
      expect(latest.targets).toEqual(expect.arrayContaining([
        expect.objectContaining({ platform: 'instagram', credentialId: 11, postType: 'post' }),
        expect.objectContaining({ platform: 'facebook', credentialId: 20, postType: 'photo' }),
      ]));
    });
  });

  it('moves legacy LinkedIn widgets into exact-version account-bound durable review', async () => {
    const onFormChange = vi.fn();
    mocks.get.mockImplementation((path: string) => path.includes('/assets/')
      ? Promise.resolve({ id: 41, version: 2, publishingReviewToken: 'linkedin-source-review', title: 'LinkedIn draft', content: 'Reviewed text' })
      : Promise.resolve({ accounts: [{ credentialId: 13, platform: 'linkedin', providerAccountId: 'urn:li:person:fixture', accountName: 'Reviewed author', expired: false }] }));
    render(<PublishPostWidget widget={{ ...widget, id: 118, formValues: { content_asset_id: 41, platform: 'linkedin', caption: 'Reviewed text' } }} onClose={vi.fn()} onSubmit={vi.fn()} onFormChange={onFormChange} />);
    await screen.findByRole('region', { name: 'LinkedIn destination settings' });
    await waitFor(() => expect(onFormChange.mock.calls.at(-1)?.[0]).toMatchObject({
      expected_version: 2, expected_review_token: 'linkedin-source-review',
      targets: [{ platform: 'linkedin', credentialId: 13, caption: 'Reviewed text', postType: 'text' }],
      _review_validation_error: undefined,
    }));
    const key = onFormChange.mock.calls.at(-1)?.[0].idempotency_key;
    fireEvent.change(screen.getByRole('textbox', { name: 'Caption' }), { target: { value: 'Changed LinkedIn copy' } });
    await waitFor(() => expect(onFormChange.mock.calls.at(-1)?.[0].idempotency_key).not.toBe(key));
  });

  it('replaces destination controls with the integrations CTA when no account is connected', async () => {
    mocks.get.mockImplementation((path: string) => path.includes('/assets/')
      ? Promise.resolve({ id: 41, version: 1, publishingReviewToken: 'fixture-review', title: 'Launch', content: 'Launch copy' })
      : Promise.resolve({ accounts: [] }));
    render(<PublishPostWidget widget={widget} onClose={vi.fn()} onSubmit={vi.fn()} onFormChange={vi.fn()} />);

    expect(await screen.findByText('Connect a publishing account')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Connect social accounts' })).toHaveAttribute('href', '/dashboard/integrations');
  });

  it('keeps the reviewed key stable across rerenders but changes it when copy changes', async () => {
    const onFormChange = vi.fn();
    const props = { widget: { ...widget, id: 108 }, onClose: vi.fn(), onSubmit: vi.fn(), onFormChange };
    const view = render(<PublishPostWidget {...props} />);
    await screen.findByText('Launch profile · Default');
    await waitFor(() => expect(onFormChange.mock.calls.at(-1)?.[0]._review_validation_error).toBeUndefined());
    const before = onFormChange.mock.calls.at(-1)?.[0].idempotency_key;
    view.rerender(<PublishPostWidget {...props} />);
    expect(onFormChange.mock.calls.at(-1)?.[0].idempotency_key).toBe(before);
    fireEvent.change(screen.getByRole('textbox', { name: 'Caption' }), { target: { value: 'Changed reviewed copy' } });
    await waitFor(() => expect(onFormChange.mock.calls.at(-1)?.[0].idempotency_key).not.toBe(before));
  });

  it('round-trips a scheduled time in the saved timezone, not the browser timezone', async () => {
    const onFormChange = vi.fn();
    render(<PublishPostWidget widget={{ ...widget, id: 109, formValues: { ...widget.formValues, timezone: 'Asia/Kolkata', scheduled_for: '2099-09-09T18:30:00.000Z' } }} onClose={vi.fn()} onSubmit={vi.fn()} onFormChange={onFormChange} />);
    await screen.findByText('Launch profile · Default');
    expect(document.querySelector('input[type="datetime-local"]')).toHaveValue('2099-09-10T00:00');
    expect(onFormChange.mock.calls.at(-1)?.[0].scheduled_for).toBe('2099-09-09T18:30:00.000Z');
    expect(screen.getByText(/Sep 10, 2099, 12:00 AM GMT\+5:30/)).toBeVisible();
    expect(screen.getByText('Change account timezone')).toHaveAttribute('href', '/dashboard/settings/preferences');
  });

  it('blocks unresolved variables and restores clean state for a different widget', async () => {
    const onFormChange = vi.fn();
    const props = { onClose: vi.fn(), onSubmit: vi.fn(), onFormChange };
    const view = render(<PublishPostWidget widget={{ ...widget, id: 110 }} {...props} />);
    await screen.findByText('Launch profile · Default');
    fireEvent.change(screen.getByRole('textbox', { name: 'Caption' }), { target: { value: 'Hello {{company}}' } });
    await waitFor(() => expect(onFormChange.mock.calls.at(-1)?.[0]._review_validation_error).toMatch(/Resolve every template variable/));
    view.rerender(<PublishPostWidget widget={{ ...widget, id: 111, formValues: { ...widget.formValues, caption: 'Fresh review' } }} {...props} />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Caption' })).toHaveValue('Fresh review'));
    await waitFor(() => expect(onFormChange.mock.calls.at(-1)?.[0]._review_validation_error).toBeUndefined());
  });

  it('does not offer a YouTube credential that needs reconnection', async () => {
    mocks.get.mockImplementation((path: string) => {
      if (path.includes('/assets/')) return Promise.resolve({ id: 41, version: 1, publishingReviewToken: 'fixture-review', title: 'Launch', content: 'Launch copy', imageUrl: '/uploads/launch.jpg' });
      return Promise.resolve({ accounts: [
        { credentialId: 20, platform: 'facebook', accountName: 'Launch Page', providerAccountId: 'fb-1', expired: false, isSelected: true },
        { credentialId: 70, platform: 'youtube', accountName: 'Reconnect channel', providerAccountId: 'yt-1', expired: false, readiness: 'needs_reconnect', isSelected: true },
      ] });
    });
    render(<PublishPostWidget widget={widget} onClose={vi.fn()} onSubmit={vi.fn()} onFormChange={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /Facebook Launch Page/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /YouTube Reconnect channel/ })).not.toBeInTheDocument();
  });
});
