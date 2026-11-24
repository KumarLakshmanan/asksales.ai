import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmUnsavedNavigation, useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { parseSupportQueueFilters, supportQueueCanonicalHref, supportQueueSearch } from '@/lib/support-queue-query';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('shared unsaved navigation', () => {
  it('does not release an earlier form when another form rejects navigation', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(false);
    renderHook(() => { useUnsavedChanges(true, 'First form'); useUnsavedChanges(true, 'Second form'); });
    expect(confirmUnsavedNavigation()).toBe(false);
    expect(confirmUnsavedNavigation()).toBe(false);
    expect(confirm).toHaveBeenLastCalledWith('First form');
  });
  it('evaluates draft state at navigation time and releases only an approved transition', () => {
    let dirty = false;
    const leave = vi.fn(); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderHook(() => useUnsavedChanges(() => dirty, 'Proposal changed', leave));
    expect(confirmUnsavedNavigation()).toBe(true);
    dirty = true;
    expect(confirmUnsavedNavigation()).toBe(false);
    expect(leave).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    expect(confirmUnsavedNavigation()).toBe(true);
    expect(leave).toHaveBeenCalledOnce();
    expect(confirmUnsavedNavigation()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe('support queue URL contract', () => {
  it('restores every supported filter and page from a shared URL', () => {
    const input = new URLSearchParams('scope=unassigned&page=3&search=Invoice&status=open&priority=high&handoff=active&ownership=human_owned&sla=breached&channel=email&assignee=51&unread=true');
    const filters = parseSupportQueueFilters(input);
    expect(filters).toMatchObject({ scope: 'unassigned', page: 3, search: 'Invoice', status: 'open', priority: 'high', handoff: 'active', ownership: 'human_owned', sla: 'breached', channel: 'email', assignee: '51', unread: true });
    expect(parseSupportQueueFilters(new URLSearchParams(supportQueueSearch(filters)))).toEqual(filters);
    const api = new URLSearchParams(supportQueueSearch(filters, '', true));
    expect(api.get('limit')).toBe('25'); expect(api.get('scope')).toBe('unassigned');
  });
  it.each(['-1', '0', '1.5', 'NaN', '9007199254740992'])('normalizes invalid page %s and enum values without forwarding them', page => {
    const filters = parseSupportQueueFilters(new URLSearchParams({ page, scope: 'all-tenants', status: 'invalid', assignee: '-51', unread: 'yes' }));
    expect(filters).toMatchObject({ page: 1, scope: 'my', status: 'all', assignee: 'all', unread: false });
    expect(supportQueueSearch(filters)).toBe('');
    expect(supportQueueSearch(filters, '', true)).toBe('page=1&limit=25&scope=my');
  });
  it('preserves unrelated URL parameters while resetting defaults', () => {
    const filters = parseSupportQueueFilters(new URLSearchParams());
    expect(supportQueueSearch(filters, 'scope=team&search=old&origin=notification')).toBe('origin=notification');
  });
  it('clears an entirely invalid query on the actual queue route', () => {
    const query = 'scope=wrong&status=invalid&page=-1';
    expect(supportQueueCanonicalHref('/support/tickets', query, `http://localhost/support/tickets?${query}`)).toBe('/support/tickets');
  });
  it('preserves unrelated repeated values and the current fragment while normalizing', () => {
    const query = 'scope=wrong&status=invalid&page=-1&origin=notification&tag=one&tag=two';
    expect(supportQueueCanonicalHref('/support/tickets', query, `http://localhost/support/tickets?${query}#queue`))
      .toBe('/support/tickets?origin=notification&tag=one&tag=two#queue');
  });
  it.each([
    'http://localhost/support/notifications?scope=wrong',
    'http://localhost/support/tickets?scope=team&status=open',
    'http://localhost/support/tickets?origin=new-navigation',
  ])('does not let a stale normalizer overwrite a newer address: %s', current => {
    expect(supportQueueCanonicalHref('/support/tickets', 'scope=wrong', current)).toBeNull();
  });
  it('leaves an already canonical URL unchanged', () => {
    const query = 'origin=notification&scope=team&status=open';
    expect(supportQueueCanonicalHref('/support/tickets', query, `http://localhost/support/tickets?${query}#queue`)).toBeNull();
  });
});
