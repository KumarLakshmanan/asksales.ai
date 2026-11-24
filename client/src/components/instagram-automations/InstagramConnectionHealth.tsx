'use client';
import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { instagramAutomationsApi, type InstagramAutomationReadiness } from '@/lib/instagram-automations';
import type { MetaMessagingAccount } from '@/lib/integrations';

export function InstagramConnectionHealth({ account, onReconnect }: { account: MetaMessagingAccount; onReconnect?: () => void }) {
  const [ready, setReady] = useState<InstagramAutomationReadiness | null>(null), [error, setError] = useState(''), [checking, setChecking] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setReady(null); setError('');
    if (!account.instagramAccountId || (!account.connected && !account.authorized)) return;
    setChecking(true);
    api.get<InstagramAutomationReadiness>(`${instagramAutomationsApi(account.instagramAccountId)}/readiness${refresh ? '?verify=1' : ''}`).then(value => { if (alive) setReady(value); }).catch(cause => { if (alive) setError((cause as Error).message); }).finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, [account.instagramAccountId, account.connected, account.authorized, account.lastVerifiedAt, refresh]);
  const expiry = account.expiresAt ? new Date(account.expiresAt).getTime() : null;
  const reconnect = account.requiresReconnect || account.tokenExpired || (expiry !== null && expiry <= Date.now()) || ready?.checks?.some(check => !check.ready && check.action === 'reconnect');
  const expiresSoon = expiry !== null && expiry > Date.now() && expiry - Date.now() < 7 * 86400000;
  return <section aria-label="Instagram connection health" className="space-y-3 border-t p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Connection health</h3><Button variant="outline" size="sm" disabled={checking} onClick={() => setRefresh(value => value + 1)}>{checking ? 'Checking…' : 'Check connection health'}</Button></div>
    <p className="text-xs text-muted-foreground">{refresh ? 'Includes the current Instagram event subscriptions.' : 'Saved connection status. Check connection health to verify current Instagram event subscriptions.'}</p>
    {(reconnect || expiresSoon) && <Callout tone="warning" size="sm" actions={onReconnect && <Button size="sm" onClick={onReconnect}>Reconnect Instagram</Button>}>{reconnect ? 'Reconnect this account to restore authorization or required access.' : `Your authorization expires on ${new Date(expiry!).toLocaleDateString()}. Reconnect before it expires.`}{!onReconnect && ' Use the reconnect button in the account section above.'}</Callout>}
    {ready?.checks && <ul className="space-y-2">{ready.checks.map(check => <li key={check.id} className="flex items-start gap-2 text-xs leading-5">{check.ready ? <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}<span>{check.title}: {check.ready ? 'Ready' : check.action === 'reconnect' ? 'Reconnect account' : 'Administrator setup needed'}</span></li>)}</ul>}
    {ready?.reasons.length ? <details><summary className="cursor-pointer text-xs font-medium">Connection details</summary><ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted-foreground">{ready.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details> : null}
    {error && <p role="alert" className="text-xs text-destructive">Connection health could not be checked. {error} Try checking again.</p>}
    {!account.connected && !account.authorized && <p className="text-xs text-muted-foreground">Connect a professional Instagram account to check automation readiness.</p>}
  </section>;
}
