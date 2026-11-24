import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationHub } from '@/components/instagram-automations/AutomationHub';
import { AutomationCatalog } from '@/components/instagram-automations/AutomationCatalog';
import { AutomationDiagnostics } from '@/components/instagram-automations/AutomationDiagnostics';
import { ProfileEditor } from '@/components/instagram-automations/ProfileEditor';
import { RuleEditor } from '@/components/instagram-automations/RuleEditor';
import { InstagramConnectionHealth } from '@/components/instagram-automations/InstagramConnectionHealth';
import { clearInstagramMediaCache, loadInstagramMediaPage } from '@/components/instagram-automations/mediaCache';
import { instagramRuleOverlaps, instagramRuleFromTemplate, newInstagramRule, type InstagramAutomationRule, type InstagramAutomationOverview } from '@/lib/instagram-automations';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
const ready = { enabled: true, profile: true, messages: true, comments: true, richMessages: true, reasons: [] };
function rule(id = 1, follow = false): InstagramAutomationRule { const definition = newInstagramRule('comment_dm'); definition.name = `Guide ${id}`; definition.trigger.keywords = ['guide']; definition.message.text = 'Here is your guide'; definition.followGate.enabled = follow; return { id, accountId: '1001', definition, priority: id, revision: 2, status: 'paused', createdAt: '', updatedAt: '' }; }
const overview = (rules: InstagramAutomationRule[] = []): InstagramAutomationOverview => ({ account: { id: '1001', username: 'shop' }, readiness: ready, profiles: [], rules, stats: { triggers: 0, sent: 0, failed: 0, skipped: 0, pending: 0, uncertain: 0 } });
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); clearInstagramMediaCache('1001'); clearInstagramMediaCache('1002'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('Instagram automation improvements', () => {
  it('customizes a template and saves it paused without publishing or activation', async () => {
    const user = userEvent.setup(), saved = vi.fn(); mocks.post.mockResolvedValue(rule(10));
    render(<RuleEditor accountId="1001" username="shop" kind="comment_dm" initial={null} readiness={ready} onBack={vi.fn()} onSaved={saved} />);
    await user.type(screen.getByLabelText('Your content link'), 'https://shop.test/guide');
    await user.click(screen.getByRole('button', { name: 'Use template' }));
    expect(screen.getByLabelText('DM message')).toHaveValue('Here is the guide you asked for: https://shop.test/guide');
    await user.click(screen.getByRole('button', { name: 'Create paused automation' }));
    expect(mocks.post).toHaveBeenCalledWith('/api/instagram/automations/1001/rules', expect.objectContaining({ definition: expect.objectContaining({ name: 'Send a guide' }) }));
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('restores an unfinished draft after remount and keeps other accounts isolated', async () => {
    const first = render(<RuleEditor accountId="1001" username="shop" kind="comment_dm" initial={null} readiness={ready} onBack={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('DM message'), { target: { value: 'Unfinished copy' } });
    first.unmount();
    const second = render(<RuleEditor accountId="1002" username="other" kind="comment_dm" initial={null} readiness={ready} onBack={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Restore unfinished draft' })).not.toBeInTheDocument(); second.unmount();
    render(<RuleEditor accountId="1001" username="shop" kind="comment_dm" initial={null} readiness={ready} onBack={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Restore unfinished draft' }));
    expect(screen.getByLabelText('DM message')).toHaveValue('Unfinished copy');
  });
  it('discards recovery copies from an older saved revision', async () => {
    const source = rule(); const first = render(<RuleEditor accountId="1001" username="shop" kind="comment_dm" initial={source} readiness={ready} onBack={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('DM message'), { target: { value: 'Old recovery' } }); first.unmount();
    render(<RuleEditor accountId="1001" username="shop" kind="comment_dm" initial={{ ...source, revision: 3 }} readiness={ready} onBack={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText(/older recovery copy was discarded/)).toBeVisible();
    expect(screen.getByLabelText('DM message')).toHaveValue('Here is your guide');
  });
  it('duplicates a saved automation with its account and current revision', async () => {
    const navigate = vi.fn(); mocks.get.mockResolvedValue(overview([rule()])); mocks.post.mockResolvedValue(rule(2));
    render(<AutomationHub accountId="1001" navigation={{ view: 'rules' }} onNavigate={navigate} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Duplicate Guide 1' }));
    expect(mocks.post).toHaveBeenCalledWith('/api/instagram/automations/1001/rules/1/duplicate', { revision: 2 });
    expect(navigate).toHaveBeenLastCalledWith({ view: 'edit', ruleId: 2 });
  });
  it('counts standard DM and follow automations in separate cards', () => {
    render(<AutomationCatalog data={overview([rule(1), rule(2, true)])} onNavigate={vi.fn()} />);
    const cards = screen.getByRole('region', { name: 'Available automations' }).querySelectorAll('article');
    expect(within(cards[2] as HTMLElement).getByText('1 saved')).toBeVisible();
    expect(within(cards[4] as HTMLElement).getByText('1 saved')).toBeVisible();
  });
  it('supports keyboard menu reordering without changing action identities or responses', async () => {
    const config = { locales: [{ locale: 'default', questions: [], items: ['First', 'Second'].map((title, index) => ({ id: `item${index}`, title, type: 'action' as const, url: '', payload: `PAYLOAD_${index}`, response: { ...newInstagramRule('comment_dm').message, text: title + ' response' } })) }] };
    render(<ProfileEditor accountId="1001" username="shop" kind="menu" initial={{ kind: 'menu', config, publishedConfig: null, revision: 1, syncStatus: 'draft', syncError: null, syncedAt: null }} readiness={ready} onBack={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Move menu item 2 up in default' }));
    expect(screen.getByLabelText('Menu item 1 label')).toHaveValue('Second');
    expect(screen.getByLabelText('Menu item 1 action identifier')).toHaveValue('PAYLOAD_1');
    expect(screen.getByLabelText('Menu item 1 response')).toHaveValue('Second response');
  });
  it('loads industry question presets into the chosen language', async () => {
    render(<ProfileEditor accountId="1001" username="shop" kind="icebreakers" initial={null} readiness={ready} onBack={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Question preset for default'), 'Services');
    await userEvent.click(screen.getByRole('button', { name: 'Use question preset' }));
    expect(screen.getByLabelText('Question 1')).toHaveValue('What services do you offer?');
    expect(screen.getByLabelText('Question 3')).toHaveValue('Where can I find your pricing?');
  });
  it('shows scoped delivery errors and an explicitly simulated test result', async () => {
    mocks.post.mockResolvedValue({ matched: true, targetWins: false, winner: { id: 2, name: 'Higher priority' }, firstResponse: 'Example', summary: 'Sample summary', warnings: ['This simulation sends nothing.'] });
    mocks.get.mockResolvedValue({ runs: [{ id: 3, ruleId: 1, ruleName: 'Guide 1', status: 'uncertain', reason: 'Connection interrupted', createdAt: '2026-10-03T00:00:00Z', effects: [] }] });
    render(<AutomationDiagnostics accountId="1001" rule={rule()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check sample comment' }));
    expect(await screen.findByText('“Higher priority” takes priority over this automation.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh delivery details' }));
    expect(await screen.findByText('Connection interrupted')).toBeVisible();
    expect(mocks.get).toHaveBeenCalledWith('/api/instagram/automations/1001/runs?ruleId=1');
    expect(screen.getByText(/Replaying this send could deliver twice/)).toBeVisible();
  });
  it('shows reconnect action when account authorization is expired', async () => {
    const reconnect = vi.fn(); mocks.get.mockResolvedValue({ ...ready, checks: [{ id: 'connection', title: 'Account authorization', ready: false, action: 'reconnect' }] });
    render(<InstagramConnectionHealth account={{ connected: true, username: 'shop', instagramAccountId: '1001', tokenExpired: true, expiresAt: '2020-01-01' }} onReconnect={reconnect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect Instagram' })); expect(reconnect).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/instagram/automations/1001/readiness'));
  });
  it('keeps health checks while the account header owns reconnection', async () => {
    mocks.get.mockResolvedValue({ ...ready, checks: [{ id: 'connection', title: 'Account authorization', ready: false, action: 'reconnect' }] });
    render(<InstagramConnectionHealth account={{ connected: true, username: 'shop', instagramAccountId: '1001', tokenExpired: true, expiresAt: null }} />);
    expect(await screen.findByText(/Use the reconnect button in the account section above/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reconnect Instagram' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check connection health' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Check connection health' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/instagram/automations/1001/readiness?verify=1'));
  });
  it('deduplicates media reads, isolates accounts, and invalidates only the selected account', async () => {
    mocks.get.mockResolvedValue({ media: [], nextCursor: 'page2' });
    await Promise.all([loadInstagramMediaPage('1001'), loadInstagramMediaPage('1001')]);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await loadInstagramMediaPage('1002'); expect(mocks.get).toHaveBeenCalledTimes(2);
    clearInstagramMediaCache('1001'); await loadInstagramMediaPage('1001'); expect(mocks.get).toHaveBeenCalledTimes(3);
    await loadInstagramMediaPage('1002'); expect(mocks.get).toHaveBeenCalledTimes(3);
  });
  it('finds cross-keyword contains overlaps and honors exact matching and exclusions', () => {
    const a = rule(1), b = rule(2); b.status = 'active'; b.definition.trigger.keywords = ['offer'];
    expect(instagramRuleOverlaps(a, [b])[0]).toMatchObject({ id: 2, winnerId: 1, example: 'guide offer' });
    a.definition.trigger.matchMode = 'exact'; expect(instagramRuleOverlaps(a, [b])).toEqual([]);
    a.definition.trigger.matchMode = 'contains'; a.definition.trigger.negativeKeywords = ['offer']; expect(instagramRuleOverlaps(a, [b])).toEqual([]);
    expect(() => instagramRuleFromTemplate('guide', 'comment_dm', 'http://unsafe.test', '', false)).toThrow('HTTPS');
  });
});
