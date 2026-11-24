import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFollowUpSaveRecovery, reconcileFollowUpSave, resetFollowUpSaveRecoveryForTests, startFollowUpSave, followUpRecoveryHistoryState } from '@/lib/follow-up-save-recovery';
import { followUpRequest, FOLLOW_UP_REQUEST_TIMEOUT_MS } from '@/lib/follow-up-request';
import type { ChannelFollowUpSettings } from '@/hooks/use-channel-follow-up-settings';

const scope = '4101:4102';
const settings = (delayValue: number, revision = 'initial'): ChannelFollowUpSettings => ({
  revision, fenced: true, enableAutoFollowUp: false,
  followUpSteps: [{ id: 1, delayValue, delayUnit: 'hours', templateId: 77, templateName: 'Private synthetic template wording' }],
});
beforeEach(() => { resetFollowUpSaveRecoveryForTests(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); resetFollowUpSaveRecoveryForTests(); });

describe('scoped follow-up save recovery', () => {
  it('retains both writes when different A and unchanged C each time out before commit at revision R', () => {
    const a = startFollowUpSave(scope, 'email', settings(2), settings(1));
    if (!a) throw new Error('A did not start'); a('uncertain');
    const c = startFollowUpSave(scope, 'email', settings(1), settings(1));
    if (!c) throw new Error('C did not start'); c('uncertain');
    const value = getFollowUpSaveRecovery(scope).email!;
    reconcileFollowUpSave(scope, 'email', value.token, settings(1));
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed).toBeDefined();
    expect(getFollowUpSaveRecovery(scope).email?.unresolved.map(write => write.settings.followUpSteps[0].delayValue)).toEqual([2, 1]);
  });

  it('keeps a ledger across repeated changes, equal reads, reload, and account/business boundaries', () => {
    for (const [index, delay] of [2, 1, 3, 1, 4].entries()) {
      const settle = startFollowUpSave(scope, 'email', settings(delay), settings(1));
      if (!settle) throw new Error('Repeated save remained blocked'); settle('uncertain');
      const state = getFollowUpSaveRecovery(scope).email!;
      reconcileFollowUpSave(scope, 'email', state.token, settings(1));
      expect(getFollowUpSaveRecovery(scope).email?.unresolved).toHaveLength(index + 1);
    }
    const before = getFollowUpSaveRecovery(scope).email!.unresolved;
    window.dispatchEvent(new Event('pageshow'));
    expect(getFollowUpSaveRecovery(scope).email?.unresolved).toEqual(before);
    expect(getFollowUpSaveRecovery('4101:4103').email).toBeUndefined();
    expect(getFollowUpSaveRecovery('4104:4102').email).toBeUndefined();
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('Private synthetic template wording');
    const value = getFollowUpSaveRecovery(scope).email!;
    reconcileFollowUpSave(scope, 'email', value.token, settings(1, 'confirmed-new-fence'));
    expect(getFollowUpSaveRecovery(scope).email?.unresolved).toEqual([]);
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed).toBeUndefined();
  });

  it('resolves each expected revision independently and rejects equality or unattested hashes as proof', () => {
    const a = startFollowUpSave(scope, 'email', settings(2), settings(1));
    if (!a) throw new Error('Save did not start'); a('uncertain');
    const b = startFollowUpSave(scope, 'email', settings(3, 'later'), null);
    if (!b) throw new Error('Save did not start'); b('uncertain');
    let value = getFollowUpSaveRecovery(scope).email!;
    reconcileFollowUpSave(scope, 'email', value.token, { ...settings(3, 'third'), fenced: false });
    expect(getFollowUpSaveRecovery(scope).email?.unresolved).toHaveLength(2);
    reconcileFollowUpSave(scope, 'email', value.token, settings(3, 'later'));
    value = getFollowUpSaveRecovery(scope).email!;
    expect(value.unresolved.map(write => write.settings.revision)).toEqual(['later']);
    expect(value.unconfirmed).toBeDefined();
    reconcileFollowUpSave(scope, 'email', value.token, settings(1, 'third'));
    expect(getFollowUpSaveRecovery(scope).email?.unresolved).toEqual([]);
  });

  it('retains older uncertainty after a rejected newer intent and requires a fence for a revisionless write', () => {
    const a = startFollowUpSave(scope, 'email', settings(2), settings(1));
    if (!a) throw new Error('Save did not start'); a('uncertain');
    const rejected = startFollowUpSave(scope, 'email', settings(3), settings(1));
    if (!rejected) throw new Error('Save did not start'); rejected('rejected');
    expect(getFollowUpSaveRecovery(scope).email?.unresolved).toHaveLength(1);
    const unknown = startFollowUpSave(scope, 'email', { ...settings(4), revision: undefined }, settings(1));
    if (!unknown) throw new Error('Save did not start'); unknown('uncertain');
    const value = getFollowUpSaveRecovery(scope).email!;
    reconcileFollowUpSave(scope, 'email', value.token, settings(4, 'fresh'));
    expect(getFollowUpSaveRecovery(scope).email?.unresolved).toHaveLength(1);
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed?.revision).toBeUndefined();
  });

  it('requires a new advanced confirmation for v1 state that may already have lost older intents', () => {
    sessionStorage.setItem(`asksales:follow-up-save:${scope}`, JSON.stringify({ version: 1, values: { email: {
      token: 77, pending: false, needsRefresh: false, attempted: settings(1), unconfirmed: settings(1),
    } } }));
    const value = getFollowUpSaveRecovery(scope).email!;
    reconcileFollowUpSave(scope, 'email', value.token, settings(1, 'different'));
    expect(getFollowUpSaveRecovery(scope).email?.requiresFence).toBe(true);
    const replay = startFollowUpSave(scope, 'email', settings(1), settings(1, 'different'));
    if (!replay) throw new Error('Save did not start'); replay('saved', { fenced: true, advanced: false, revision: 'different' });
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed).toBeDefined();
    const fresh = startFollowUpSave(scope, 'email', settings(1, 'different'), settings(1, 'different'));
    if (!fresh) throw new Error('Save did not start'); fresh('saved', { fenced: true, advanced: true, revision: 'fresh-fence' });
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed).toBeUndefined();
  });

  it('settles a timeout when only writes fail and the seeded prior record still reads successfully', async () => {
    const seeded = startFollowUpSave(scope, 'email', settings(1), settings(1));
    if (!seeded) throw new Error('Seed did not start'); seeded('saved', { fenced: true, revision: 'seeded-fence' });
    const original = sessionStorage.getItem(`asksales:follow-up-save:${scope}`);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota full', 'QuotaExceededError'); });
    vi.useFakeTimers();
    const settle = startFollowUpSave(scope, 'email', settings(2, 'seeded-fence'), settings(1, 'seeded-fence'));
    if (!settle) throw new Error('Save did not start');
    const request = followUpRequest(() => new Promise(() => {})).catch(() => settle('uncertain'));
    await vi.advanceTimersByTimeAsync(FOLLOW_UP_REQUEST_TIMEOUT_MS); await request;
    expect(sessionStorage.getItem(`asksales:follow-up-save:${scope}`)).toBe(original);
    expect(getFollowUpSaveRecovery(scope).email?.pending).toBe(false);
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed?.followUpSteps[0].delayValue).toBe(2);
  });

  it('retains the write-only-failure intent over a reload while an older readable record remains', () => {
    const seeded = startFollowUpSave(scope, 'email', settings(1), settings(1));
    if (!seeded) throw new Error('Seed did not start'); seeded('saved', { fenced: true, revision: 'seeded-fence' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota full', 'QuotaExceededError'); });
    const save = startFollowUpSave(scope, 'email', settings(2, 'seeded-fence'), settings(1, 'seeded-fence'));
    if (!save) throw new Error('Save did not start');
    window.dispatchEvent(new Event('pageshow'));
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed?.followUpSteps[0].delayValue).toBe(2);
    const loaded = getFollowUpSaveRecovery(scope).email!;
    reconcileFollowUpSave(scope, 'email', loaded.token, settings(1, 'seeded-fence'));
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed).toBeDefined();
    const retry = startFollowUpSave(scope, 'email', settings(2, 'seeded-fence'), settings(1, 'seeded-fence'));
    if (!retry) throw new Error('Retry did not start'); retry('saved', { fenced: true, advanced: true, revision: 'new-fence' });
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed).toBeUndefined();
    expect(JSON.stringify(history.state)).not.toContain('Private synthetic template wording');
  });

  it('does not confuse an actually newer persisted token with the stale token left by a failed write', () => {
    const originalSet = Storage.prototype.setItem;
    const seeded = startFollowUpSave(scope, 'email', settings(1), settings(1));
    if (!seeded) throw new Error('Seed did not start'); seeded('saved');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota full', 'QuotaExceededError'); });
    const save = startFollowUpSave(scope, 'email', settings(2), settings(1));
    if (!save) throw new Error('Save did not start');
    const active = getFollowUpSaveRecovery(scope).email!;
    originalSet.call(sessionStorage, `asksales:follow-up-save:${scope}`, JSON.stringify({ version: 2, values: { email: {
      ...active, token: active.token + 100, serial: active.serial + 100, attempted: settings(4), pending: true,
    } } }));
    save('uncertain');
    expect(getFollowUpSaveRecovery(scope).email).toBe(active);
    window.dispatchEvent(new Event('pageshow'));
    expect(getFollowUpSaveRecovery(scope).email?.token).toBe(active.token + 100);
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed?.followUpSteps[0].delayValue).toBe(4);
  });

  it('carries recovery metadata during navigation without Next private history flags', () => {
    window.history.replaceState({ __NA: true, _N: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ['synthetic-tree'] }, '');
    expect(followUpRecoveryHistoryState()).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota full', 'QuotaExceededError'); });
    const settle = startFollowUpSave(scope, 'email', settings(2), settings(1));
    if (!settle) throw new Error('Save did not start'); settle('uncertain');
    expect(window.history.state.__NA).toBe(true);
    const data = followUpRecoveryHistoryState();
    expect(Object.keys(data!)).toEqual(['__asksalesFollowUpRecovery']);
    window.history.pushState(data, '', '?synthetic-navigation=1');
    window.dispatchEvent(new Event('pageshow'));
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed?.followUpSteps[0].delayValue).toBe(2);
  });

  it('releases a never-settling save to uncertainty and retains its attempted timing for retry', async () => {
    vi.useFakeTimers();
    const settle = startFollowUpSave(scope, 'email', settings(2), settings(1));
    if (!settle) throw new Error('Synthetic save did not start');
    const request = followUpRequest(() => new Promise(() => {})).catch(() => settle('uncertain'));
    expect(getFollowUpSaveRecovery(scope).email?.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(FOLLOW_UP_REQUEST_TIMEOUT_MS); await request;
    expect(getFollowUpSaveRecovery(scope).email).toMatchObject({ pending: false, needsRefresh: true, unconfirmed: { followUpSteps: [{ delayValue: 2 }] } });
    const retry = startFollowUpSave(scope, 'email', settings(2), settings(1));
    if (!retry) throw new Error('Retry remained blocked');
    retry('saved', { fenced: true, revision: 'new-fence' });
    const token = getFollowUpSaveRecovery(scope).email!.token;
    reconcileFollowUpSave(scope, 'email', token, settings(2, 'new-fence'));
    expect(getFollowUpSaveRecovery(scope).email).toMatchObject({ pending: false, needsRefresh: false, unconfirmed: undefined });
  });

  it('does not clear an earlier intent from a differing read or an unfenced no-op confirmation', () => {
    const initial = startFollowUpSave(scope, 'email', settings(2), settings(1));
    if (!initial) throw new Error('Save did not start');
    initial('uncertain');
    const token = getFollowUpSaveRecovery(scope).email!.token;
    reconcileFollowUpSave(scope, 'email', token, settings(1));
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed?.followUpSteps[0].delayValue).toBe(2);
    const noop = startFollowUpSave(scope, 'email', settings(1), settings(1));
    if (!noop) throw new Error('Save did not start');
    noop('saved', { revision: 'initial' });
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed?.followUpSteps[0].delayValue).toBe(2);
    const fenced = startFollowUpSave(scope, 'email', settings(1), settings(1));
    if (!fenced) throw new Error('Save did not start');
    fenced('saved', { fenced: true, revision: 'advanced' });
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed).toBeUndefined();
  });

  it('restores structural intent on a new document and ignores the older document after a superseding retry', () => {
    const older = startFollowUpSave(scope, 'email', settings(3), settings(1));
    if (!older) throw new Error('Save did not start');
    const stored = JSON.stringify({ ...sessionStorage });
    expect(stored).not.toContain('Private synthetic template wording');
    window.dispatchEvent(new Event('pageshow'));
    expect(getFollowUpSaveRecovery(scope).email).toMatchObject({ pending: false, unconfirmed: { followUpSteps: [{ delayValue: 3, templateId: 77 }] } });
    const retry = startFollowUpSave(scope, 'email', settings(1), settings(1));
    if (!retry) throw new Error('Save did not start');
    retry('saved', { fenced: true, revision: 'fenced-noop' });
    const newer = getFollowUpSaveRecovery(scope).email;
    older('saved', { fenced: true, revision: 'late-old-intent' });
    expect(getFollowUpSaveRecovery(scope).email).toBe(newer);
  });

  it('keeps delayed settlements isolated to their original actor and business', () => {
    const settle = startFollowUpSave(scope, 'email', settings(3), settings(1));
    if (!settle) throw new Error('Save did not start');
    const otherBusiness = getFollowUpSaveRecovery('4101:4103');
    const otherActor = getFollowUpSaveRecovery('4104:4102');
    settle('uncertain');
    expect(getFollowUpSaveRecovery('4101:4103')).toBe(otherBusiness);
    expect(getFollowUpSaveRecovery('4104:4102')).toBe(otherActor);
    expect(otherBusiness.email).toBeUndefined(); expect(otherActor.email).toBeUndefined();
  });

  it('settles using its in-memory scope when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage disabled'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled'); });
    const settle = startFollowUpSave(scope, 'email', settings(2), settings(1));
    if (!settle) throw new Error('Save did not start');
    settle('uncertain');
    expect(getFollowUpSaveRecovery(scope).email?.pending).toBe(false);
    expect(getFollowUpSaveRecovery(scope).email?.unconfirmed?.followUpSteps[0].delayValue).toBe(2);
  });

  it('restores fallback persistence ownership for every scope before any recovery GET or navigation', async () => {
    const owners = [scope, '4101:4103', '4104:4102'];
    for (const owner of owners) {
      const seeded = startFollowUpSave(owner, 'email', settings(1), settings(1));
      if (!seeded) throw new Error('Seed did not start'); seeded('saved', { fenced: true, revision: 'seeded-fence' });
    }
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota full', 'QuotaExceededError'); });
    for (const [index, owner] of owners.entries()) {
      const save = startFollowUpSave(owner, 'email', settings(index + 2, 'seeded-fence'), settings(1, 'seeded-fence'));
      if (!save) throw new Error('Save did not start'); save('uncertain');
    }
    const events = vi.spyOn(window, 'addEventListener');
    vi.resetModules();
    const reloaded = await import('@/lib/follow-up-save-recovery');
    const handlers = events.mock.calls.filter(([name]) => name === 'beforeunload' || name === 'pageshow');
    try {
      expect(reloaded.getFollowUpSaveRecovery(scope).email?.unresolved).toHaveLength(1);
      const pageshow = handlers.find(([name]) => name === 'pageshow')?.[1];
      if (typeof pageshow !== 'function') throw new Error('Page restoration handler was not installed');
      pageshow(new Event('pageshow'));
      // An ordinary Next Link creates an entry with only Next's own navigation state.
      window.history.replaceState({ __NA: true }, '', '?synthetic-inbox=1');
      const unload = handlers.find(([name]) => name === 'beforeunload')?.[1];
      if (typeof unload !== 'function') throw new Error('Reload persistence handler was not installed');
      unload(new Event('beforeunload'));
      for (const [index, owner] of owners.entries()) {
        const recovered = window.history.state?.__asksalesFollowUpRecovery?.scopes?.[owner]?.email;
        expect(recovered?.unresolved?.[0]?.settings.followUpSteps[0].delayValue).toBe(index + 2);
      }
      expect(window.history.state.__NA).toBe(true);
      expect(JSON.stringify(window.history.state)).not.toContain('Private synthetic template wording');
      expect(reloaded.getFollowUpSaveRecovery('4104:4103').email).toBeUndefined();
    } finally {
      for (const [name, handler] of handlers) window.removeEventListener(name, handler as EventListener);
      reloaded.resetFollowUpSaveRecoveryForTests();
      vi.resetModules();
    }
  });
});
