"use client";
import type { ChannelFollowUpSettings } from '@/hooks/use-channel-follow-up-settings';
import type { InboxChannel } from '../../../shared/outreachInbox';
import { isFollowUpStepId } from '../../../shared/followUpSettings';

interface UnresolvedWrite { token: number; settings: ChannelFollowUpSettings }
export interface FollowUpSaveRecovery {
  token: number; serial: number; pending: boolean; needsRefresh: boolean;
  attempted: ChannelFollowUpSettings; unresolved: UnresolvedWrite[];
  requiresFence?: boolean; unconfirmed?: ChannelFollowUpSettings;
}
type RecoveryState = Partial<Record<InboxChannel, FollowUpSaveRecovery>>;
type Confirmation = { fenced?: boolean; advanced?: boolean; revision?: string };
const empty: RecoveryState = Object.freeze({});
const scopes = new Map<string, RecoveryState>();
const listeners = new Set<() => void>();
const failedScopes = new Set<string>();
const staleStorageTokens = new Map<string, number | undefined>();
const historyKey = '__asksalesFollowUpRecovery';
let token = 0; let serial = 0;
const storageKey = (scope: string) => `asksales:follow-up-save:${scope}`;
const operationKey = (scope: string, channel: InboxChannel) => `${scope}:${channel}`;

/** Retain structural intent only, excluding customer/message/template wording. */
function structural(settings: ChannelFollowUpSettings): ChannelFollowUpSettings {
  return { revision: settings.revision, enableAutoFollowUp: settings.enableAutoFollowUp, followUpSteps: settings.followUpSteps.map(step => ({
    id: step.id, delayValue: step.delayValue, delayUnit: step.delayUnit, templateId: step.templateId,
    ...(step.enabled === undefined ? {} : { enabled: step.enabled }),
    templateName: step.templateId && step.templateId > 0 ? `Saved template #${step.templateId}` : step.templateId === -1 ? 'Auto-generate' : '',
  })) };
}
function validSettings(value: unknown): value is ChannelFollowUpSettings {
  const settings = value as ChannelFollowUpSettings | undefined;
  return !!settings && typeof settings.enableAutoFollowUp === 'boolean' && Array.isArray(settings.followUpSteps)
    && settings.followUpSteps.length > 0 && settings.followUpSteps.length <= 10
    && settings.followUpSteps.every(step => isFollowUpStepId(step.id) && Number.isInteger(step.delayValue)
      && (step.enabled === undefined || typeof step.enabled === 'boolean')
      && step.delayValue >= (step.enabled === false ? 0 : 1) && ['minutes', 'hours', 'days'].includes(step.delayUnit));
}
function summarize(value: FollowUpSaveRecovery): FollowUpSaveRecovery {
  return { ...value, unconfirmed: value.unresolved.at(-1)?.settings ?? (value.requiresFence ? value.attempted : undefined) };
}
function addWrite(writes: UnresolvedWrite[], write: UnresolvedWrite) {
  return writes.some(value => value.token === write.token) ? writes : [...writes, write];
}
function decode(bundle: unknown): RecoveryState {
  const parsed = bundle as { version?: number; values?: Record<string, FollowUpSaveRecovery> } | null;
  if (![1, 2].includes(parsed?.version ?? 0) || !parsed?.values || typeof parsed.values !== 'object') return empty;
  const values: RecoveryState = {};
  for (const [channel, value] of Object.entries(parsed.values)) {
    if (!['email', 'whatsapp', 'instagram', 'facebook', 'sms'].includes(channel)
      || !Number.isSafeInteger(value?.token) || !validSettings(value.attempted)) continue;
    let unresolved: UnresolvedWrite[];
    if (parsed.version === 2) {
      if (!Array.isArray(value.unresolved) || value.unresolved.some(write => !Number.isSafeInteger(write.token) || !validSettings(write.settings))) continue;
      unresolved = value.unresolved.map(write => ({ token: write.token, settings: structural(write.settings) }));
    } else {
      unresolved = validSettings(value.unconfirmed) ? [{ token: value.token - 1, settings: structural(value.unconfirmed) }] : [];
    }
    if (value.pending) unresolved = addWrite(unresolved, { token: value.token, settings: structural(value.attempted) });
    token = Math.max(token, value.token);
    const savedSerial = Number.isSafeInteger(value.serial) ? value.serial : value.token;
    serial = Math.max(serial, savedSerial);
    values[channel as InboxChannel] = summarize({ token: value.token, serial: savedSerial, pending: false, needsRefresh: true,
      attempted: structural(value.attempted), unresolved,
      // v1 could already have discarded older writes. Equality cannot repair that lost evidence.
      requiresFence: parsed.version === 1 || value.requiresFence === true });
  }
  return values;
}
function readSession(scope: string): RecoveryState {
  if (typeof window === 'undefined') return empty;
  try { return decode(JSON.parse(sessionStorage.getItem(storageKey(scope)) || 'null')); } catch { return empty; }
}
function historyScopes(): Record<string, RecoveryState> {
  if (typeof window === 'undefined') return {};
  const saved = window.history.state?.[historyKey];
  return saved?.version === 2 && saved.scopes && typeof saved.scopes === 'object' ? saved.scopes : {};
}
/** Let Next install its own navigation flags; preserve only our fallback during query changes. */
export function followUpRecoveryHistoryState() {
  if (typeof window === 'undefined') return null;
  const saved = window.history.state?.[historyKey];
  return saved ? { [historyKey]: saved } : null;
}
function newer(first: FollowUpSaveRecovery | undefined, second: FollowUpSaveRecovery | undefined) {
  if (!first) return second; if (!second) return first;
  return first.token > second.token || (first.token === second.token && first.serial >= second.serial) ? first : second;
}
function merge(first: RecoveryState, second: RecoveryState): RecoveryState {
  return Object.fromEntries([...new Set([...Object.keys(first), ...Object.keys(second)])].map(key => [key,
    newer(first[key as InboxChannel], second[key as InboxChannel])])) as RecoveryState;
}
function read(scope: string): RecoveryState {
  const stored = readSession(scope);
  const backup = decode({ version: 2, values: historyScopes()[scope] });
  // Reload must restore the persistence obligation as well as the ledger, even
  // when the settings read never settles and cannot trigger another update.
  if (Object.entries(backup).some(([channel, value]) => newer(stored[channel as InboxChannel], value) === value)) failedScopes.add(scope);
  return merge(stored, backup);
}
export const getFollowUpSaveRecovery = (scope: string): RecoveryState => {
  if (!scopes.has(scope)) scopes.set(scope, read(scope));
  return scopes.get(scope) ?? empty;
};
export const getServerFollowUpSaveRecovery = (): RecoveryState => empty;
export function subscribeFollowUpSaveRecovery(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

function persistHistoryBackup() {
  if (typeof window === 'undefined' || !failedScopes.size) return;
  try {
    const saved = { ...historyScopes() };
    for (const scope of failedScopes) saved[scope] = getFollowUpSaveRecovery(scope);
    window.history.replaceState({ ...window.history.state, [historyKey]: { version: 2, scopes: saved } }, '');
  } catch { /* The in-memory ledger remains intact if both browser persistence mechanisms fail. */ }
}
/** Keep every fallback scope durable across ordinary Next navigation and reload. */
export function preserveFollowUpRecoveryNavigation() {
  for (const scope of Object.keys(historyScopes())) {
    scopes.set(scope, merge(scopes.get(scope) ?? empty, read(scope)));
  }
  persistHistoryBackup();
}
function update(scope: string, channel: InboxChannel, input: FollowUpSaveRecovery, starting = false) {
  let value = summarize({ ...input, serial: ++serial });
  const values = { ...merge(getFollowUpSaveRecovery(scope), read(scope)), [channel]: value };
  const previousToken = readSession(scope)[channel]?.token;
  try {
    sessionStorage.setItem(storageKey(scope), JSON.stringify({ version: 2, values }));
    staleStorageTokens.delete(operationKey(scope, channel)); failedScopes.delete(scope);
  } catch {
    // A failed setItem leaves an older readable token. Only that known stale token is exempt.
    staleStorageTokens.set(operationKey(scope, channel), previousToken); failedScopes.add(scope);
    value = summarize({ ...value, requiresFence: value.requiresFence || starting }); values[channel] = value;
  }
  scopes.set(scope, values); persistHistoryBackup(); listeners.forEach(listener => listener());
}
function ownsOperation(scope: string, channel: InboxChannel, expectedToken: number) {
  if (getFollowUpSaveRecovery(scope)[channel]?.token !== expectedToken) return false;
  const persistedToken = read(scope)[channel]?.token;
  return persistedToken === undefined || persistedToken === expectedToken
    || (staleStorageTokens.has(operationKey(scope, channel)) && persistedToken === staleStorageTokens.get(operationKey(scope, channel)));
}
/** An attested persisted fence can reject every differing write based on an older revision. */
function remaining(writes: UnresolvedWrite[], proof: Confirmation | null | undefined) {
  if (proof?.fenced !== true || typeof proof.revision !== 'string') return writes;
  return writes.filter(write => typeof write.settings.revision !== 'string' || write.settings.revision === proof.revision);
}
export function startFollowUpSave(scope: string, channel: InboxChannel, attempted: ChannelFollowUpSettings, current: ChannelFollowUpSettings | null) {
  scopes.set(scope, merge(getFollowUpSaveRecovery(scope), read(scope)));
  const old = getFollowUpSaveRecovery(scope)[channel];
  if (old?.pending) return false;
  const value: FollowUpSaveRecovery = { token: ++token, serial, pending: true, needsRefresh: false,
    attempted: structural(attempted), unresolved: remaining(old?.unresolved ?? [], current), requiresFence: old?.requiresFence };
  update(scope, channel, value, true);
  return (outcome: 'saved' | 'rejected' | 'uncertain', confirmation?: Confirmation) => {
    if (!ownsOperation(scope, channel, value.token)) return;
    const active = getFollowUpSaveRecovery(scope)[channel]!;
    const advanced = outcome === 'saved' && confirmation?.fenced === true && confirmation.advanced === true
      && typeof attempted.revision === 'string' && typeof confirmation.revision === 'string' && confirmation.revision !== attempted.revision;
    const unresolved = outcome === 'uncertain' ? addWrite(active.unresolved, { token: value.token, settings: value.attempted })
      : outcome === 'saved' ? remaining(active.unresolved, confirmation) : active.unresolved;
    update(scope, channel, { ...active, pending: false, needsRefresh: true, unresolved,
      requiresFence: outcome === 'uncertain' ? active.requiresFence : old?.requiresFence && !advanced });
  };
}
export function reconcileFollowUpSave(scope: string, channel: InboxChannel, expectedToken: number, settings: ChannelFollowUpSettings) {
  const value = getFollowUpSaveRecovery(scope)[channel];
  if (!value || value.pending || !ownsOperation(scope, channel, expectedToken)) return;
  const unresolved = remaining(value.unresolved, settings);
  if (value.needsRefresh || unresolved.length !== value.unresolved.length) update(scope, channel, { ...value, needsRefresh: false, unresolved });
}
export function resetFollowUpSaveRecoveryForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Recovery reset is test-only');
  scopes.clear(); failedScopes.clear(); staleStorageTokens.clear();
  if (typeof window !== 'undefined') {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith('asksales:follow-up-save:')) sessionStorage.removeItem(key);
    const { [historyKey]: _recovery, ...rest } = window.history.state ?? {}; window.history.replaceState(rest, '');
  }
  listeners.forEach(listener => listener());
}
if (typeof window !== 'undefined') {
  // The persistent application provider imports this module on Inbox and other
  // routes too; recover all scope keys before navigation can replace the entry.
  preserveFollowUpRecoveryNavigation();
  window.addEventListener('pageshow', () => {
    scopes.clear(); preserveFollowUpRecoveryNavigation(); listeners.forEach(listener => listener());
  });
  // Preserve the fallback on the active entry after a client-side navigation, before reload.
  window.addEventListener('beforeunload', persistHistoryBackup);
}
