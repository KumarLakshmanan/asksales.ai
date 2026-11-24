'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Copy,
  History,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SearchInput } from '@/components/ui/search-input';
import { Callout } from '@/components/ui/callout';
import { PageLoadingState, PageErrorState } from '@/components/ui/page-state';
import {
  instagramAutomationsApi,
  sortInstagramRules,
  instagramActivationIssues,
  instagramAutomationSummary,
  instagramAccountAuthorization,
  type InstagramAutomationReadiness,
  instagramRuleOverlaps,
  type InstagramAutomationKind,
  type InstagramAutomationOverview,
  type InstagramAutomationRule,
  type InstagramAutomationRun,
} from '@/lib/instagram-automations';
import { Errors, selectClass } from './Fields';
import { ProfileEditor } from './ProfileEditor';
import { RuleEditor } from './RuleEditor';
import { AutomationCatalog } from './AutomationCatalog';
import { AutomationDiagnostics } from './AutomationDiagnostics';
import { instagramRunOutcome, instagramEffectName, instagramEffectOutcome } from './deliveryLabels';

export type AutomationView = 'hub' | 'rules' | 'icebreakers' | 'menu' | 'new' | 'edit' | 'history' | 'details';
export interface AutomationNavigation {
  view: AutomationView;
  kind?: InstagramAutomationKind;
  ruleId?: number;
  guided?: boolean;
  preset?: 'follow' | 'standard';
}
const scopes = {
  all: 'Any post or reel',
  reels: 'Only reels',
  specific: 'Specific posts or reels',
};
export function AutomationHistory({ accountId }: { accountId: string }) {
  const [runs, setRuns] = useState<InstagramAutomationRun[]>([]),
    [cursor, setCursor] = useState<number | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const generation = useRef(0);
  const load = useCallback(
    async (older?: number) => {
      const version = ++generation.current;
      setLoading(true);
      setError('');
      try {
        const result = await api.get<{ runs: InstagramAutomationRun[]; nextCursor: number | null }>(
          `${instagramAutomationsApi(accountId)}/runs${older ? `?cursor=${older}` : ''}`
        );
        if (version !== generation.current) return;
        setRuns((previous) =>
          older
            ? [
                ...previous,
                ...result.runs.filter(
                  (run) => !previous.some((existing) => existing.id === run.id)
                ),
              ]
            : result.runs
        );
        setCursor(result.nextCursor);
      } catch (cause) {
        if (version === generation.current) setError(cause instanceof Error ? cause.message : 'History could not be loaded.');
      } finally {
        if (version === generation.current) setLoading(false);
      }
    },
    [accountId]
  );
  useEffect(() => {
    setRuns([]); setCursor(null);
    void load();
    return () => { generation.current += 1; };
  }, [load]);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Execution history</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Replies can take a moment to appear in your inbox. History shows whether Instagram accepted each request.
          </p>
        </div>
        <Button
          variant="outline"
          aria-label="Refresh execution history"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      <Errors errors={error ? [error] : []} />
      {!runs.length && !loading && !error ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <History className="mx-auto h-7 w-7 text-muted-foreground" />
          <p className="mt-3 font-medium">No executions yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Matching comments and menu actions will appear here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="block w-full text-left text-sm md:table">
            <thead className="hidden bg-muted/50 text-xs text-muted-foreground md:table-header-group">
              <tr>
                <th className="px-4 py-3">Automation</th>
                <th className="px-4 py-3">Outcome</th>
                <th className="px-4 py-3">Details</th>
                <th className="px-4 py-3">Time</th>
              </tr>
            </thead>
            <tbody className="block divide-y md:table-row-group">
              {runs.map((run) => (
                <tr key={run.id} className="block space-y-3 p-4 md:table-row md:space-y-0 md:p-0">
                  <td className="block md:table-cell md:min-w-[160px] md:px-4 md:py-4">
                    <p className="font-medium">{run.ruleName || 'Profile action'}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Run #{run.id}</p>
                  </td>
                  <td className="block md:table-cell md:px-4 md:py-4">
                    <Badge variant={run.status === 'failed' ? 'destructive' : 'outline'}>
                      {instagramRunOutcome(run.status)}
                    </Badge>
                  </td>
                  <td className="block text-xs leading-5 text-muted-foreground md:table-cell md:min-w-[230px] md:max-w-sm md:px-4 md:py-4">
                    {run.reason ||
                      (run.privateMessageId
                        ? 'Instagram accepted the private message.'
                        : run.publicMessageId
                          ? 'Instagram accepted the public reply.'
                          : 'No delivery confirmation recorded.')}
                    {run.effects?.map((effect) => (
                      <p key={effect.kind} className="mt-1">
                        {instagramEffectName(effect.kind)}:{' '}
                        {instagramEffectOutcome(effect.status)}
                        {effect.error ? ` — ${effect.error}` : ''}
                      </p>
                    ))}
                    {run.status === 'uncertain' && (
                      <p className="mt-1">
                        Delivery could not be confirmed. An automatic retry could send twice.
                      </p>
                    )}
                  </td>
                  <td className="block text-xs text-muted-foreground md:table-cell md:whitespace-nowrap md:px-4 md:py-4">
                    {new Date(run.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading history…
        </p>
      )}
      {cursor && (
        <Button variant="outline" disabled={loading} onClick={() => void load(cursor)}>
          Load older executions
        </Button>
      )}
      {error && (
        <Button variant="outline" onClick={() => void load()}>
          Retry history
        </Button>
      )}
    </div>
  );
}

export function AutomationHub({
  accountId,
  navigation,
  onNavigate,
  accountControl,
}: {
  accountId: string;
  navigation: AutomationNavigation;
  onNavigate: (navigation: AutomationNavigation) => void;
  accountControl?: React.ReactNode;
}) {
  const [data, setData] = useState<InstagramAutomationOverview | null>(null),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(''),
    [actionErrors, setActionErrors] = useState<string[]>([]),
    [pending, setPending] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [checkingConnection, setCheckingConnection] = useState(false);
  const generation = useRef(0), action = useRef<number | null>(null);
  const [search, setSearch] = useState(''),
    [statusFilter, setStatusFilter] = useState('all'),
    [typeFilter, setTypeFilter] = useState('all');
  const reload = useCallback(async () => {
    // A focus refresh must not replace a pending action or invalidate its cleanup.
    if (action.current !== null) return;
    const version = ++generation.current;
    setLoading(true);
    setLoadError('');
    try {
      const result = await api.get<InstagramAutomationOverview>(instagramAutomationsApi(accountId));
      if (version === generation.current) setData(result);
    } catch (cause) {
      if (version === generation.current) setLoadError(cause instanceof Error ? cause.message : 'Automations could not be loaded.');
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [accountId]);
  useEffect(() => {
    action.current = null;
    setPending(null);
    setData(null);
    void reload();
    return () => { action.current = null; generation.current += 1; };
  }, [reload]);
  useEffect(() => {
    const refreshOnReturn = () => { if (document.visibilityState === 'visible') void reload(); };
    window.addEventListener('focus', refreshOnReturn);
    return () => window.removeEventListener('focus', refreshOnReturn);
  }, [reload]);
  useEffect(() => {
    if (navigation.view === 'rules') setTypeFilter(navigation.kind || 'all');
  }, [navigation.view, navigation.kind]);
  const sorted = useMemo(() => sortInstagramRules(data?.rules || []), [data?.rules]);
  const visible = sorted.filter(
    (rule) =>
      (typeFilter === 'all' || rule.definition.kind === typeFilter) &&
      (statusFilter === 'all' || rule.status === statusFilter) &&
      rule.definition.name.toLowerCase().includes(search.toLowerCase()) &&
      (navigation.preset !== 'follow' || rule.definition.followGate.enabled) &&
      (navigation.preset !== 'standard' || !rule.definition.followGate.enabled)
  );
  if (loading && !data) return <PageLoadingState label="Loading Instagram automations…" />;
  if (!data)
    return (
      <PageErrorState
        title="Automations could not be loaded"
        description={loadError}
        reset={() => void reload()}
      />
    );
  const ready = data.readiness,
    username = data.account.username || 'Your account';
  const authorized = instagramAccountAuthorization(ready);
  const verifyConnection = async () => {
    if (action.current !== null) return;
    const version = ++generation.current;
    setCheckingConnection(true);
    setActionErrors([]);
    try {
      const readiness = await api.get<InstagramAutomationReadiness>(`${instagramAutomationsApi(accountId)}/readiness?verify=1`);
      if (version === generation.current) setData(value => value ? { ...value, readiness } : value);
    } catch (cause) {
      if (version === generation.current) setActionErrors([cause instanceof Error ? cause.message : 'Connection could not be checked. Try again.']);
    } finally {
      setCheckingConnection(false);
    }
  };
  const back = () => {
    setActionErrors([]);
    onNavigate({ view: 'hub' });
  };
  const canActivate = (rule: InstagramAutomationRule) =>
    ready.enabled &&
    ready.comments &&
    (rule.definition.kind === 'comment_reply' || ready.messages) &&
    (rule.definition.kind === 'comment_reply' ||
      rule.definition.message.format === 'text' ||
      ready.richMessages);
  const replaceRule = (rule: InstagramAutomationRule) =>
    setData((value) =>
      value
        ? {
            ...value,
            rules: value.rules.some((r) => r.id === rule.id)
              ? value.rules.map((r) => (r.id === rule.id ? rule : r))
              : [...value.rules, rule],
          }
        : value
    );
  const beginAction = (ruleId: number) => {
    if (action.current !== null) return null;
    const version = ++generation.current;
    action.current = version;
    // Any earlier overview read is now stale, including its loading indicator.
    setLoading(false);
    setPending(ruleId);
    setActionErrors([]);
    return version;
  };
  const finishAction = (version: number) => {
    if (action.current !== version) return;
    action.current = null;
    if (version === generation.current) setPending(null);
  };
  const toggle = async (rule: InstagramAutomationRule) => {
    if (rule.status === 'paused') {
      const overlaps = instagramRuleOverlaps(rule, data.rules);
      const review = instagramAutomationSummary(rule.definition) + (overlaps.length ? `\n\nPotential overlap with ${overlaps.map(value => value.name).join(', ')}. Specific posts win first, then reels, then any post; list priority decides within a scope.` : '');
      if (!window.confirm(`${review}\n\nActivate this automation for new comments?`)) return;
    }
    const version = beginAction(rule.id);
    if (version === null) return;
    try {
      const result = await api.put<InstagramAutomationRule>(
        `${instagramAutomationsApi(accountId)}/rules/${rule.id}`,
        {
          definition: rule.definition,
          status: rule.status === 'active' ? 'paused' : 'active',
          revision: rule.revision,
        }
      );
      if (version !== generation.current) return;
      replaceRule(result);
      setNotice(result.status === 'active' ? `“${result.definition.name}” is active and will respond to new matching comments.` : `“${result.definition.name}” is paused.`);
    } catch (cause) {
      if (version === generation.current) setActionErrors([cause instanceof Error ? cause.message : 'Status could not be changed.']);
    } finally {
      finishAction(version);
    }
  };
  const remove = async (rule: InstagramAutomationRule) => {
    if (!window.confirm(`Delete “${rule.definition.name}” and stop future runs?`)) return;
    const version = beginAction(rule.id);
    if (version === null) return;
    try {
      await api.delete(`${instagramAutomationsApi(accountId)}/rules/${rule.id}`, {
        body: JSON.stringify({ revision: rule.revision }),
      });
      if (version !== generation.current) return;
      setData((value) =>
        value ? { ...value, rules: value.rules.filter((r) => r.id !== rule.id) } : value
      );
      setNotice(`“${rule.definition.name}” was deleted.`);
    } catch (cause) {
      if (version === generation.current) setActionErrors([
        cause instanceof Error ? cause.message : 'Automation could not be deleted.',
      ]);
    } finally {
      finishAction(version);
    }
  };
  const move = async (rule: InstagramAutomationRule, delta: number) => {
    const index = sorted.findIndex((r) => r.id === rule.id),
      next = sorted[index + delta];
    if (!next || next.definition.trigger.scope !== rule.definition.trigger.scope) return;
    const version = beginAction(rule.id);
    if (version === null) return;
    const ordered = [...sorted];
    [ordered[index], ordered[index + delta]] = [ordered[index + delta], ordered[index]];
    try {
      const result = await api.put<InstagramAutomationRule[]>(
        `${instagramAutomationsApi(accountId)}/rules/order`,
        { ids: ordered.map((r) => r.id) }
      );
      if (version !== generation.current) return;
      setData((value) => (value ? { ...value, rules: result } : value));
      setNotice('Rule order saved. The first matching rule within each scope wins.');
    } catch (cause) {
      if (version === generation.current) setActionErrors([cause instanceof Error ? cause.message : 'Order could not be saved.']);
    } finally {
      finishAction(version);
    }
  };
  const duplicate = async (rule: InstagramAutomationRule) => {
    const version = beginAction(rule.id); if (version === null) return;
    try { const copied = await api.post<InstagramAutomationRule>(`${instagramAutomationsApi(accountId)}/rules/${rule.id}/duplicate`, { revision: rule.revision }); if (version !== generation.current) return; replaceRule(copied); setNotice('Copy created and paused. Choose its posts and review the trigger before activating.'); onNavigate({ view: 'edit', ruleId: copied.id }); }
    catch (cause) { if (version === generation.current) setActionErrors([(cause as Error).message]); }
    finally { finishAction(version); }
  };
  if (navigation.view === 'icebreakers' || navigation.view === 'menu')
    return (
      <ProfileEditor
        key={navigation.view}
        accountId={accountId}
        username={username}
        kind={navigation.view}
        readiness={ready}
        initial={data.profiles.find((profile) => profile.kind === navigation.view) || null}
        onBack={back}
        onSaved={(profile) =>
          setData((value) =>
            value
              ? {
                  ...value,
                  profiles: [...value.profiles.filter((p) => p.kind !== profile.kind), profile],
                }
              : value
          )
        }
      />
    );
  if (navigation.view === 'new' || navigation.view === 'edit') {
    const rule =
      navigation.view === 'edit' ? data.rules.find((r) => r.id === navigation.ruleId) : null;
    if (navigation.view === 'edit' && !rule)
      return (
        <div className="space-y-4">
          <Errors errors={['This automation does not exist for this account.']} />
          <Button onClick={() => onNavigate({ view: 'rules' })}>Back to automations</Button>
        </div>
      );
    return (
      <RuleEditor
        key={rule?.id || `new-${navigation.kind}-${navigation.preset || 'default'}`}
        accountId={accountId}
        username={username}
        kind={rule?.definition.kind || navigation.kind || 'comment_dm'}
        initial={rule || null}
        guided={navigation.guided}
        followGatePreset={navigation.preset === 'follow'}
        readiness={ready}
        rules={data.rules}
        onBack={() => onNavigate({ view: 'rules' })}
        onSaved={(saved) => {
          replaceRule(saved);
          setNotice(saved.status === 'active' ? 'Changes saved. This automation is active.' : 'Automation saved and paused. Select Activate when you are ready to respond to new comments.');
          onNavigate({ view: 'rules' });
        }}
      />
    );
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/dashboard/integrations/instagram"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Instagram connection
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">@{username.replace(/^@/, '')}</span>
          {accountControl}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh automations"
            disabled={loading || pending !== null || checkingConnection}
            onClick={() => void reload()}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>
      <section aria-label="Automation account connection" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="min-w-0"><p className="text-sm font-medium">{authorized === true ? `Instagram account connected · @${username.replace(/^@/, '')}` : authorized === false ? 'Instagram authorization needs attention' : 'Instagram authorization has not been verified'}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Account connection and automation access are checked separately. Each card shows the access it needs.</p></div>
        <Button size="sm" variant="outline" disabled={checkingConnection || loading || pending !== null} onClick={() => void verifyConnection()}><RefreshCw aria-hidden="true" className={`h-4 w-4 ${checkingConnection ? 'animate-spin' : ''}`} />{checkingConnection ? 'Checking connection…' : 'Check connection'}</Button>
      </section>
      {navigation.view !== 'hub' && <Button variant="ghost" className="px-0" onClick={back}><ArrowLeft aria-hidden="true" className="h-4 w-4" />All automations</Button>}
      {(!ready.enabled || ready.reasons.length > 0) && (
        <Callout
          tone="warning"
          title={!ready.enabled ? 'Live automations are not enabled yet' : 'Check permissions before publishing'}
          actions={
            <Button asChild size="sm" variant="outline">
              <Link href="/dashboard/integrations/instagram">Review connection</Link>
            </Button>
          }
        >
            <ul className="list-inside list-disc space-y-1 text-xs leading-5 text-muted-foreground">
              {(ready.reasons.length
                ? ready.reasons
                : [
                    'Live automations are not enabled for this workspace yet. You can prepare and save your setup.',
                  ]
              ).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
        </Callout>
      )}
      <Errors errors={actionErrors} />
      {loadError && <div className="space-y-2"><Errors errors={[`Refresh failed. Your previously loaded setup is still shown. ${loadError}`]} /><Button size="sm" variant="outline" onClick={() => void reload()}>Retry refresh</Button></div>}
      {notice && <p role="status" className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm">{notice}</p>}
      {navigation.view === 'history' ? (
        <AutomationHistory accountId={accountId} />
      ) : navigation.view === 'details' ? (
        data.rules.find(rule => rule.id === navigation.ruleId) ? <><h1 className="text-2xl font-semibold">Test and delivery: {data.rules.find(rule => rule.id === navigation.ruleId)!.definition.name}</h1><AutomationDiagnostics key={navigation.ruleId} accountId={accountId} rule={data.rules.find(rule => rule.id === navigation.ruleId)!} /></> : <Errors errors={['This automation does not exist for this account.']} />
      ) : navigation.view === 'hub' ? (
        <>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Instagram automations</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Choose what happens when someone opens your DMs or comments on your content.
              Every setup here belongs to @{username.replace(/^@/, '')}.
            </p>
          </div>
          <AutomationCatalog data={data} onNavigate={onNavigate} />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Saved automations</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                One rule wins per comment: specific posts first, then reels, then any post. Within
                each scope, the first matching rule wins.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => onNavigate({ view: 'new', kind: 'comment_reply' })}
              >
                New public reply
              </Button>
              <Button onClick={() => onNavigate({ view: 'new', kind: 'comment_dm', guided: true })}>
                <Plus className="h-4 w-4" />
                New comment to DM
              </Button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_190px_150px]">
            <SearchInput
              aria-label="Search automations"
              placeholder="Search automations"
              value={search}
              onValueChange={setSearch}
            />
            <select
              aria-label="Filter automation type"
              className={selectClass}
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="all">All comment automations</option>
              <option value="comment_dm">Comment to DM</option>
              <option value="comment_reply">Public comment reply</option>
            </select>
            <select
              aria-label="Filter status"
              className={selectClass}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </select>
          </div>
          {(search || statusFilter !== 'all' || typeFilter !== 'all' || navigation.preset) && (
            <p className="text-xs text-muted-foreground">
              Clear filters to change rule order.{' '}
              <button
                className="text-primary underline"
                onClick={() => {
                  setSearch('');
                  setStatusFilter('all');
                  setTypeFilter('all');
                  if (navigation.preset) onNavigate({ view: 'rules' });
                }}
              >
                Clear filters
              </button>
            </p>
          )}
          {!visible.length ? (
            <div className="rounded-xl border border-dashed p-10 text-center">
              <MessageSquare className="mx-auto h-8 w-8 text-muted-foreground" />
              <h2 className="mt-4 font-semibold">
                {data.rules.length ? 'No matching automations' : 'Start with a keyword'}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {data.rules.length
                  ? 'Change the filters to find your automation.'
                  : 'Create a rule to turn a comment into a helpful response.'}
              </p>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {visible.map((rule) => {
                const index = sorted.findIndex((r) => r.id === rule.id),
                  filtered = !!search || statusFilter !== 'all' || typeFilter !== 'all' || !!navigation.preset,
                  overlaps = instagramRuleOverlaps(rule, data.rules);
                return (
                  <div key={rule.id} className="rounded-xl border bg-card p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">Priority {index + 1}</Badge>
                          <button
                            className="text-left font-semibold hover:text-primary"
                            onClick={() => onNavigate({ view: 'edit', ruleId: rule.id })}
                          >
                            {rule.definition.name}
                          </button>
                          <Badge variant={rule.status === 'active' ? 'default' : 'outline'}>
                            {rule.status === 'active' ? 'Active' : 'Paused'}
                          </Badge>
                        </div>
                        <p className="mt-2 max-w-lg text-xs leading-5 text-muted-foreground">{instagramAutomationSummary(rule.definition)}</p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {rule.definition.kind === 'comment_dm'
                            ? 'Comment to DM'
                            : 'Public comment reply'}{' '}
                          · {scopes[rule.definition.trigger.scope]}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {rule.definition.trigger.keywords.map((keyword) => (
                            <span key={keyword} className="rounded bg-muted px-2 py-1 text-xs">
                              {keyword}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        <Button size="sm" variant="outline" aria-label={`Duplicate ${rule.definition.name}`} disabled={pending !== null} onClick={() => void duplicate(rule)}><Copy aria-hidden="true" className="h-3.5 w-3.5" />Duplicate</Button>
                        <Button size="sm" variant="outline" onClick={() => onNavigate({ view: 'details', ruleId: rule.id })}>Test & delivery</Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Move ${rule.definition.name} up`}
                          disabled={
                            pending !== null ||
                            filtered ||
                            sorted[index - 1]?.definition.trigger.scope !==
                              rule.definition.trigger.scope
                          }
                          onClick={() => void move(rule, -1)}
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Move ${rule.definition.name} down`}
                          disabled={
                            pending !== null ||
                            filtered ||
                            sorted[index + 1]?.definition.trigger.scope !==
                              rule.definition.trigger.scope
                          }
                          onClick={() => void move(rule, 1)}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending !== null}
                          onClick={() => onNavigate({ view: 'edit', ruleId: rule.id })}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`${rule.status === 'active' ? 'Pause' : 'Activate'} ${rule.definition.name}`}
                          disabled={
                            pending !== null || (rule.status === 'paused' && !canActivate(rule))
                          }
                          onClick={() => void toggle(rule)}
                        >
                          {rule.status === 'active' ? (
                            <Pause className="h-3.5 w-3.5" />
                          ) : (
                            <Play className="h-3.5 w-3.5" />
                          )}
                          {rule.status === 'active' ? 'Pause' : 'Activate'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${rule.definition.name}`}
                          disabled={pending !== null}
                          onClick={() => void remove(rule)}
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </div>
                    </div>
                    {rule.status === 'paused' && !canActivate(rule) && (
                      <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
                        {instagramActivationIssues(rule.definition, ready).join(' ')}
                      </p>
                    )}
                    {overlaps.length > 0 && <details className="mt-3 border-t pt-3"><summary className="cursor-pointer text-xs font-medium text-amber-700 dark:text-amber-300">Review {overlaps.length} potential overlap(s)</summary><div className="mt-2 space-y-2">{overlaps.slice(0, 5).map(overlap => <p key={overlap.id} className="text-xs leading-5">“{overlap.name}” can also match “{overlap.example}”. {overlap.winnerId === rule.id ? 'This automation takes priority.' : 'That automation takes priority.'}</p>)}</div></details>}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
