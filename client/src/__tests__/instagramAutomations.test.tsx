import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileEditor } from '@/components/instagram-automations/ProfileEditor';
import { RuleEditor } from '@/components/instagram-automations/RuleEditor';
import { AutomationHistory, AutomationHub } from '@/components/instagram-automations/AutomationHub';
import { clearInstagramMediaCache } from '@/components/instagram-automations/mediaCache';
import { MediaPicker } from '@/components/instagram-automations/MediaPicker';
import { PhonePreview } from '@/components/instagram-automations/PhonePreview';
import InstagramAutomationsPage from '@/app/dashboard/(main)/integrations/instagram/automations/page';
import {
  emptyInstagramProfile,
  newInstagramRule,
  type InstagramAutomationOverview,
  type InstagramAutomationProfile,
  type InstagramAutomationReadiness,
  type InstagramAutomationRule,
} from '@/lib/instagram-automations';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  navigate: vi.fn(),
  saved: vi.fn(),
  query: '',
  router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('@/lib/api', () => ({ default: mocks, api: mocks }));
vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => new URLSearchParams(mocks.query),
}));
vi.mock('@/components/integrations/ChannelAccountSelector', () => ({
  ChannelAccountSelector: () => null,
}));
const readiness: InstagramAutomationReadiness = {
  enabled: true,
  messages: true,
  comments: true,
  profile: true,
  reasons: [],
  richMessages: true,
};
const makeRule = (
  id: number,
  scope: 'all' | 'specific' | 'reels' = 'all'
): InstagramAutomationRule => ({
  id,
  accountId: 'account-1',
  status: 'paused',
  priority: id,
  revision: 3,
  createdAt: '2026-09-29T10:00:00Z',
  updatedAt: '2026-09-29T10:00:00Z',
  definition: {
    ...newInstagramRule('comment_dm'),
    name: `Rule ${id}`,
    trigger: {
      keywords: ['guide'],
      negativeKeywords: [],
      matchMode: 'contains',
      scope,
      mediaIds: scope === 'specific' ? ['post-1'] : [],
    },
    message: { format: 'text', text: 'Your guide', cards: [], buttons: [], quickReplies: [] },
  },
});
const overview = (rules: InstagramAutomationRule[] = []): InstagramAutomationOverview => ({
  account: { id: 'account-1', username: 'shop' },
  readiness,
  profiles: [],
  rules,
  stats: { triggers: 0, sent: 0, skipped: 0, failed: 0, pending: 0, uncertain: 0 },
});
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  clearInstagramMediaCache('account-1');
  clearInstagramMediaCache('account-2');
  mocks.query = '';
  mocks.get.mockResolvedValue(overview());
  mocks.put.mockImplementation(async (_url, body) => body);
});
afterEach(cleanup);

describe('Instagram automation usability and recovery', () => {
  it('shows every automation as a card and routes each setup without rules or history tabs', async () => {
    const user = userEvent.setup();
    render(<AutomationHub accountId="account-1" navigation={{ view: 'hub' }} onNavigate={mocks.navigate} />);
    const catalog = await screen.findByRole('region', { name: 'Available automations' });
    expect(catalog.querySelectorAll('article')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Comment rules' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument();
    expect(screen.queryByText('Recorded activity')).not.toBeInTheDocument();
    for (const [label, navigation] of [
      ['Set up questions', { view: 'icebreakers' }],
      ['Set up menu', { view: 'menu' }],
      ['Create comment to DM', { view: 'new', kind: 'comment_dm', guided: true }],
      ['Create public reply', { view: 'new', kind: 'comment_reply' }],
      ['Set up follow verification', { view: 'new', kind: 'comment_dm', guided: true, preset: 'follow' }],
    ] as const) {
      await user.click(within(catalog).getByRole('button', { name: label }));
      expect(mocks.navigate).toHaveBeenLastCalledWith(navigation);
    }
  });
  it('opens follow verification with the follow gate enabled and retains it after switching editor', async () => {
    const user = userEvent.setup();
    render(<RuleEditor accountId="account-1" username="shop" kind="comment_dm" initial={null} guided followGatePreset readiness={readiness} onBack={vi.fn()} onSaved={mocks.saved} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Require a verified follow', { exact: false })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Switch to advanced editor' }));
    expect(screen.getByLabelText('Require a verified follow', { exact: false })).toBeChecked();
  });
  it('commits a typed keyword when Next is clicked and focuses the missing DM response', async () => {
    const user = userEvent.setup();
    render(<RuleEditor accountId="account-1" username="shop" kind="comment_dm" initial={null} guided readiness={readiness} onBack={vi.fn()} onSaved={mocks.saved} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Trigger keywords'), 'guide');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('DM message')).toBeVisible();
    expect(screen.getByRole('button', { name: 'DM' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByLabelText('DM message')).toHaveFocus());
    expect(screen.getByLabelText('DM message')).toHaveAttribute('aria-invalid', 'true');
    await user.type(screen.getByLabelText('DM message'), 'Here is the guide.');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Automation name'), 'Guide requests');
    await user.type(screen.getByLabelText('Contact tags'), 'interested');
    mocks.post.mockResolvedValue(makeRule(10));
    await user.click(screen.getByRole('button', { name: 'Create paused automation' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    expect(mocks.post.mock.calls[0][1].definition.trigger.keywords).toEqual(['guide']);
    expect(mocks.post.mock.calls[0][1].definition.tags).toEqual(['interested']);
  });
  it('starts public automation with a response field and protects edits when leaving', async () => {
    const user = userEvent.setup(), back = vi.fn(), confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<RuleEditor accountId="account-1" username="shop" kind="comment_reply" initial={null} readiness={readiness} onBack={back} onSaved={mocks.saved} />);
    expect(screen.getByLabelText('Public reply 1')).toBeVisible();
    await user.type(screen.getByLabelText('Public reply 1'), 'We open at 9 am.');
    await user.click(screen.getByRole('button', { name: 'Back to automations' }));
    expect(confirm).toHaveBeenCalledWith('Discard your unsaved changes and leave this setup?');
    expect(back).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Public reply 1')).toHaveValue('We open at 9 am.');
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(back).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });
  it('rejects a Unicode message that exceeds the provider byte limit and shows the byte count', async () => {
    const rule = makeRule(1);
    render(<RuleEditor accountId="account-1" username="shop" kind="comment_dm" initial={rule} readiness={readiness} onBack={vi.fn()} onSaved={mocks.saved} />);
    fireEvent.change(screen.getByLabelText('DM message'), { target: { value: 'அ'.repeat(334) } });
    expect(screen.getByText('1,002 / 1,000 bytes')).toBeVisible();
    expect(screen.getByLabelText('DM message')).toHaveAttribute('aria-invalid', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.put).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('UTF-8 bytes');
  });
  it('generates menu action identifiers and shows a saved response in the simulated preview', async () => {
    const user = userEvent.setup();
    render(<ProfileEditor accountId="account-1" username="shop" kind="menu" initial={null} readiness={readiness} onBack={vi.fn()} onSaved={mocks.saved} />);
    expect((screen.getByLabelText('Menu item 1 action identifier') as HTMLInputElement).value).toMatch(/^MENU_/);
    await user.type(screen.getByLabelText('Menu item 1 label'), 'Prices');
    await user.type(screen.getByLabelText('Menu item 1 response'), 'Plans start at $20.');
    await user.click(screen.getByRole('button', { name: 'Preview menu item Prices' }));
    expect(screen.getByText('Response after tapping')).toBeVisible();
    expect(screen.getByText('Plans start at $20.', { selector: 'div' })).toBeVisible();
  });
  it('previews the actual trigger keyword and restores the proper preview when returning to the wizard', async () => {
    const rule = makeRule(1); rule.definition.message.text = 'You requested {{keyword}}.';
    const { unmount } = render(<PhonePreview username="shop" rule={rule.definition} />);
    expect(screen.getByText('You requested guide.')).toBeVisible();
    unmount();
    const user = userEvent.setup();
    render(<RuleEditor accountId="account-1" username="shop" kind="comment_dm" initial={rule} guided readiness={readiness} onBack={vi.fn()} onSaved={mocks.saved} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Switch to advanced editor' }));
    await user.click(screen.getByRole('button', { name: 'Use guided setup' }));
    expect(screen.getByRole('button', { name: 'Comments' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('keeps loaded rules visible when a refresh fails', async () => {
    mocks.get.mockResolvedValueOnce(overview([makeRule(1)])).mockRejectedValueOnce(new Error('Network interrupted.'));
    render(<AutomationHub accountId="account-1" navigation={{ view: 'rules' }} onNavigate={mocks.navigate} />);
    await screen.findByText('Rule 1');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh automations' }));
    await screen.findByText(/Refresh failed. Your previously loaded setup is still shown./);
    expect(screen.getByText('Rule 1')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry refresh' })).toBeEnabled();
  });
  it('ignores an older account media response after the account changes', async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    mocks.get.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; })).mockResolvedValueOnce({ media: [{ id: 'second', caption: 'Second account post' }], nextCursor: null });
    const { rerender } = render(<MediaPicker accountId="account-1" selected={[]} onChange={vi.fn()} />);
    rerender(<MediaPicker accountId="account-2" selected={[]} onChange={vi.fn()} />);
    await screen.findByRole('button', { name: 'Select post Second account post' });
    await act(async () => { resolveFirst({ media: [{ id: 'first', caption: 'First account post' }], nextCursor: 'stale-cursor' }); });
    expect(screen.queryByRole('button', { name: 'Select post First account post' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more posts' })).not.toBeInTheDocument();
  });
  it('checks a pending profile publication without reloading or falsely claiming success', async () => {
    const config = emptyInstagramProfile(); config.locales[0].questions = [{ id: 'first', question: 'Opening hours?' }];
    const initial: InstagramAutomationProfile = { kind: 'icebreakers', config, publishedConfig: null, revision: 2, syncStatus: 'syncing', syncError: null, syncedAt: null };
    mocks.get.mockResolvedValue({ ...initial, syncStatus: 'published', publishedConfig: config, revision: 3 });
    render(<ProfileEditor accountId="account-1" username="shop" kind="icebreakers" initial={initial} readiness={readiness} onBack={vi.fn()} onSaved={mocks.saved} />);
    expect(screen.getByRole('button', { name: 'Publish to Instagram' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Check publication status' }));
    await screen.findByText('Published and confirmed by Instagram.');
    expect(screen.getByLabelText('Question 1')).toBeEnabled();
    expect(mocks.get).toHaveBeenCalledWith('/api/instagram/automations/account-1/profiles/icebreakers');
  });
});

describe('Instagram profile setup', () => {
  it('limits questions, keeps language groups separate, and separates draft saves from confirmed publication', async () => {
    const user = userEvent.setup();
    mocks.put.mockImplementation(async (_url, body) => ({
      kind: 'icebreakers',
      config: body.config,
      publishedConfig: body.publish ? body.config : null,
      revision: body.revision + 1,
      syncStatus: body.publish ? 'error' : 'draft',
      syncError: body.publish ? 'Instagram did not confirm the setting.' : null,
      syncedAt: null,
    }));
    render(
      <ProfileEditor
        accountId="account-1"
        username="shop"
        kind="icebreakers"
        initial={null}
        readiness={readiness}
        onBack={vi.fn()}
        onSaved={mocks.saved}
      />
    );
    for (let i = 1; i <= 4; i++) {
      if (i > 1) await user.click(screen.getByRole('button', { name: 'Add question' }));
      await user.type(screen.getByLabelText(`Question ${i}`), `Question number ${i}?`);
    }
    expect(screen.getByRole('button', { name: 'Add question' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Add language' }));
    await user.selectOptions(screen.getByLabelText('Language 2'), 'ta_IN');
    await user.type(screen.getByLabelText('Question 1 (ta_IN)'), 'Tamil question');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved. Publish when you are ready.');
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/instagram/automations/account-1/profiles/icebreakers',
      expect.objectContaining({
        publish: false,
        revision: 0,
        config: expect.objectContaining({
          locales: expect.arrayContaining([expect.objectContaining({ locale: 'ta_IN' })]),
        }),
      })
    );
    await user.click(screen.getByRole('button', { name: 'Publish to Instagram' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Instagram did not confirm');
    expect(screen.queryByText('Published and confirmed by Instagram.')).not.toBeInTheDocument();
    expect(mocks.put.mock.calls[1][1].revision).toBe(1);
  });
  it('requires an explicit menu action response and rejects insecure menu links', async () => {
    const user = userEvent.setup();
    render(
      <ProfileEditor
        accountId="account-1"
        username="shop"
        kind="menu"
        initial={null}
        readiness={readiness}
        onBack={vi.fn()}
        onSaved={mocks.saved}
      />
    );
    await user.type(screen.getByLabelText('Menu item 1 label'), 'Pricing');
    await user.click(screen.getByText('Advanced action identifier'));
    await user.clear(screen.getByLabelText('Menu item 1 action identifier'));
    await user.type(screen.getByLabelText('Menu item 1 action identifier'), 'VIEW_PRICING');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('DM text must contain');
    expect(mocks.put).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('Menu item 1 type'), 'link');
    await user.type(screen.getByLabelText('Menu item 1 link'), 'http://example.test');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Menu links must use HTTPS');
    await user.selectOptions(screen.getByLabelText('Menu item 1 type'), 'action');
    await user.type(screen.getByLabelText('Menu item 1 response'), 'Plans start at $20.');
    mocks.put.mockImplementation(async (_url, body) => ({
      kind: 'menu',
      config: body.config,
      revision: 1,
      syncStatus: 'draft',
      publishedConfig: null,
      syncError: null,
      syncedAt: null,
    }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    expect(mocks.put.mock.calls[0][1].config.locales[0].items[0]).toEqual(
      expect.objectContaining({
        type: 'action',
        payload: 'VIEW_PRICING',
        response: expect.objectContaining({ text: 'Plans start at $20.' }),
      })
    );
  });
  it('allows draft editing when provider publication is unavailable and sends the saved revision on removal', async () => {
    const config = emptyInstagramProfile();
    config.locales[0].questions = [{ id: 'first', question: 'Opening hours?' }];
    const initial: InstagramAutomationProfile = {
      kind: 'icebreakers',
      config,
      publishedConfig: config,
      revision: 7,
      syncStatus: 'published',
      syncError: null,
      syncedAt: null,
    };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.delete.mockResolvedValue({
      ...initial,
      config: emptyInstagramProfile(),
      publishedConfig: null,
      revision: 8,
      syncStatus: 'draft',
    });
    render(
      <ProfileEditor
        accountId="account-2"
        username="second"
        kind="icebreakers"
        initial={initial}
        readiness={{ ...readiness, profile: false }}
        onBack={vi.fn()}
        onSaved={mocks.saved}
      />
    );
    expect(screen.getByRole('button', { name: 'Publish to Instagram' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove from Instagram' }));
    await waitFor(() =>
      expect(mocks.delete).toHaveBeenCalledWith(
        '/api/instagram/automations/account-2/profiles/icebreakers',
        { body: JSON.stringify({ revision: 7 }) }
      )
    );
    vi.restoreAllMocks();
  });
});

describe('Instagram comment rule editing', () => {
  it('retains one definition across wizard and advanced editor and creates without activation', async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValue(makeRule(9));
    render(
      <RuleEditor
        accountId="account-1"
        username="shop"
        kind="comment_dm"
        initial={null}
        guided
        readiness={readiness}
        onBack={vi.fn()}
        onSaved={mocks.saved}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Trigger keywords'), 'guide{Enter}');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: 'Carousel' })).toBeDisabled();
    await user.type(screen.getByLabelText('DM message'), 'Here is your guide.');
    await user.click(screen.getByRole('button', { name: 'Switch to advanced editor' }));
    expect(screen.getByLabelText('DM message')).toHaveValue('Here is your guide.');
    expect(screen.getByText('guide', { selector: 'span' })).toBeVisible();
    await user.type(screen.getByLabelText('Automation name'), 'Guide requests');
    await user.type(screen.getByLabelText('Negative keywords'), 'spam{Enter}');
    await user.type(screen.getByLabelText('Contact tags'), 'guide-lead{Enter}');
    await user.click(screen.getByRole('button', { name: 'Create paused automation' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    const [url, body] = mocks.post.mock.calls[0];
    expect(url).toBe('/api/instagram/automations/account-1/rules');
    expect(body.status).toBeUndefined();
    expect(body.definition.trigger).toEqual(
      expect.objectContaining({ keywords: ['guide'], negativeKeywords: ['spam'] })
    );
    expect(body.definition.tags).toEqual(['guide-lead']);
    expect(mocks.saved).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }));
  });
  it('keeps follow verification strict and converts rich content to text when the gate is removed', async () => {
    const user = userEvent.setup();
    const initial = makeRule(2);
    initial.definition.followGate.enabled = true;
    initial.definition.message = {
      format: 'buttons',
      text: 'Download',
      buttons: [{ title: 'Guide', url: 'https://example.test/guide' }],
      cards: [],
      quickReplies: [],
    };
    mocks.put.mockResolvedValue(initial);
    render(
      <RuleEditor
        accountId="account-1"
        username="shop"
        kind="comment_dm"
        initial={initial}
        readiness={readiness}
        onBack={vi.fn()}
        onSaved={mocks.saved}
      />
    );
    expect(
      (screen.getByLabelText('Follow verification retry message') as HTMLTextAreaElement).value
    ).toContain('could not confirm');
    expect(screen.getByRole('option', { name: 'Verified non-followers only' })).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: /Require a verified follow/ }));
    expect(screen.getByRole('button', { name: 'Button card' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    expect(mocks.put.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        revision: 3,
        status: 'paused',
        definition: expect.objectContaining({
          followGate: expect.objectContaining({ enabled: false }),
          message: expect.objectContaining({ format: 'text', text: 'Download' }),
        }),
      })
    );
  });
});

describe('Instagram lists and provider data', () => {
  it('binds drafts to the URL account and clears the editor when that account changes', async () => {
    mocks.query = 'accountId=account-1&view=new&kind=comment_dm';
    mocks.get.mockImplementation(async (url: string) =>
      url.endsWith('/oauth/status')
        ? {
            officialApi: {
              connected: true,
              authorized: true,
              instagramAccountId: 'account-1',
              username: 'shop',
            },
          }
        : {
            ...overview(),
            account: {
              id: url.endsWith('account-2') ? 'account-2' : 'account-1',
              username: url.endsWith('account-2') ? 'second-shop' : 'shop',
            },
          }
    );
    const { rerender } = render(<InstagramAutomationsPage />);
    await screen.findByLabelText('Automation name');
    await userEvent.type(screen.getByLabelText('Automation name'), 'Draft for first account');
    mocks.query = 'accountId=account-2&view=new&kind=comment_dm';
    rerender(<InstagramAutomationsPage />);
    await waitFor(() =>
      expect(mocks.get).toHaveBeenCalledWith('/api/instagram/automations/account-2')
    );
    expect(await screen.findByLabelText('Automation name')).toHaveValue('');
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('orders specific rules before general ones and blocks activation until account readiness', async () => {
    mocks.get.mockResolvedValue({
      ...overview([makeRule(1), makeRule(2, 'specific')]),
      readiness: { ...readiness, comments: false, reasons: ['Authorize comment access.'] },
    });
    render(
      <AutomationHub
        accountId="account-1"
        navigation={{ view: 'rules' }}
        onNavigate={mocks.navigate}
      />
    );
    await screen.findByText('Rule 2');
    const names = screen
      .getAllByRole('button', { name: /^Rule [12]$/ })
      .map((element) => element.textContent);
    expect(names).toEqual(['Rule 2', 'Rule 1']);
    screen
      .getAllByRole('button', { name: /^Activate / })
      .forEach((button) => expect(button).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Move Rule 2 down' })).toBeDisabled();
    expect(screen.getByText('Authorize comment access.')).toBeVisible();
  });
  it('selects real account media and paginates without losing the existing selection', async () => {
    const changed = vi.fn();
    mocks.get
      .mockResolvedValueOnce({
        media: [{ id: 'post-1', caption: 'First post' }],
        nextCursor: 'next-page',
      })
      .mockResolvedValueOnce({
        media: [{ id: 'post-2', caption: 'Second post' }],
        nextCursor: null,
      });
    render(<MediaPicker accountId="account-1" selected={['post-1']} onChange={changed} />);
    expect(await screen.findByRole('button', { name: 'Select post First post' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Load more posts' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Select post Second post' }));
    expect(changed).toHaveBeenCalledWith(['post-1', 'post-2']);
    expect(mocks.get).toHaveBeenLastCalledWith(
      '/api/instagram/automations/account-1/media?after=next-page'
    );
  });
  it('reports uncertain delivery and loads older execution records', async () => {
    const run = {
      id: 10,
      ruleId: 1,
      ruleName: 'Guide rule',
      sourceKey: 'comment:one',
      status: 'uncertain',
      reason: 'Provider response interrupted.',
      privateMessageId: null,
      publicMessageId: null,
      createdAt: '2026-09-29T10:00:00Z',
      updatedAt: '2026-09-29T10:00:00Z',
    };
    mocks.get
      .mockResolvedValueOnce({ runs: [run], nextCursor: 10 })
      .mockResolvedValueOnce({
        runs: [{ ...run, id: 9, status: 'skipped', reason: 'Cooldown.' }],
        nextCursor: null,
      });
    render(<AutomationHistory accountId="account-1" />);
    expect(await screen.findByText('Guide rule')).toBeVisible();
    expect(screen.getByText(/An automatic retry could send twice/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Load older executions' }));
    await screen.findByText('Run #9');
    expect(mocks.get).toHaveBeenLastCalledWith(
      '/api/instagram/automations/account-1/runs?cursor=10'
    );
  });
});
