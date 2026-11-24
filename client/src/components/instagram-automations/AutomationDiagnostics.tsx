'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { instagramAutomationsApi, type InstagramAutomationRule, type InstagramAutomationRun, type InstagramAutomationTestResult } from '@/lib/instagram-automations';
import { Errors, Field, Section, selectClass } from './Fields';
import { instagramRunOutcome, instagramEffectName, instagramEffectOutcome } from './deliveryLabels';

export function AutomationDiagnostics({ accountId, rule }: { accountId: string; rule: InstagramAutomationRule }) {
  const [text, setText] = useState(rule.definition.trigger.keywords[0] || ''), [mediaId, setMediaId] = useState(rule.definition.trigger.mediaIds[0] || ''), [isReel, setIsReel] = useState(rule.definition.trigger.scope === 'reels');
  const [result, setResult] = useState<InstagramAutomationTestResult | null>(null), [error, setError] = useState(''), [testing, setTesting] = useState(false);
  const [runs, setRuns] = useState<InstagramAutomationRun[]>([]), [loading, setLoading] = useState(false), [deliveryError, setDeliveryError] = useState(''), [deliveryLoaded, setDeliveryLoaded] = useState(false);
  const generation = useRef(0), sampleGeneration = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => {
    sampleGeneration.current += 1;
    setResult(null); setError(''); setTesting(false);
    return () => { sampleGeneration.current += 1; };
  }, [accountId, rule.id, rule.revision]);
  const invalidateSample = () => {
    sampleGeneration.current += 1;
    setResult(null); setError(''); setTesting(false);
  };
  const checkSample = async () => {
    const version = ++sampleGeneration.current;
    setTesting(true); setError(''); setResult(null);
    try {
      const response = await api.post<InstagramAutomationTestResult>(`${instagramAutomationsApi(accountId)}/rules/${rule.id}/test`, { text, mediaId, isReel });
      if (alive.current && version === sampleGeneration.current) setResult(response);
    } catch (cause) {
      if (alive.current && version === sampleGeneration.current) setError((cause as Error).message);
    } finally {
      if (alive.current && version === sampleGeneration.current) setTesting(false);
    }
  };
  useLayoutEffect(() => {
    generation.current += 1;
    setRuns([]); setDeliveryLoaded(false); setDeliveryError(''); setLoading(false);
    return () => { generation.current += 1; };
  }, [accountId, rule.id]);
  const load = async () => {
    const version = ++generation.current; setLoading(true); setDeliveryError('');
    try { const response = await api.get<{ runs: InstagramAutomationRun[] }>(`${instagramAutomationsApi(accountId)}/runs?ruleId=${rule.id}`); if (version === generation.current && alive.current) { setRuns(response.runs); setDeliveryLoaded(true); } }
    catch (cause) { if (version === generation.current && alive.current) setDeliveryError((cause as Error).message); }
    finally { if (version === generation.current && alive.current) setLoading(false); }
  };
  return <div className="space-y-5">
    <Section title="Check a sample comment" description="Test matching and priority using the saved setup. This simulation sends nothing to Instagram.">
      <Field label="Sample comment"><Textarea maxLength={2000} value={text} onChange={event => { setText(event.target.value); invalidateSample(); }} /></Field>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="Sample post or reel ID" hint="Use a selected post ID when testing specific content."><Input value={mediaId} maxLength={255} onChange={event => { setMediaId(event.target.value); invalidateSample(); }} /></Field><Field label="Sample content type"><select className={selectClass} value={isReel ? 'reel' : 'post'} onChange={event => { setIsReel(event.target.value === 'reel'); invalidateSample(); }}><option value="post">Post</option><option value="reel">Reel</option></select></Field></div>
      <Errors errors={error ? [error] : []} />
      <Button type="button" disabled={testing || !text.trim()} onClick={() => void checkSample()}>{testing ? 'Checking…' : 'Check sample comment'}</Button>
      {result && <div role="status" className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm"><p className="font-medium">{!result.matched ? 'This comment does not match this automation.' : result.targetWins ? 'This automation would win the trigger match.' : `“${result.winner?.name}” takes priority over this automation.`}</p><p>{result.summary}</p>{result.firstResponse && <div><p className="mb-1 text-xs text-muted-foreground">Example first response</p><p className="whitespace-pre-wrap rounded-lg border bg-background p-3">{result.firstResponse}</p></div>}<ul className="list-inside list-disc space-y-1 text-xs leading-5 text-muted-foreground">{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div>}
    </Section>
    <Section title="Test on Instagram" description="Use a second account whose owner agrees to test with you.">
      <ol className="list-inside list-decimal space-y-2 text-sm leading-6"><li>Save your setup and resolve any connection issues, then activate this automation.</li><li>From the second account, comment a matching keyword on an eligible post or reel.</li><li>{rule.definition.kind === 'comment_reply' ? 'Check the public comment thread for the reply.' : 'Check DMs and message requests for the private response.'}</li>{rule.definition.followGate.enabled && <li>Follow the account and reply DONE. Verify that the promised content arrives only after Instagram confirms the follow.</li>}<li>Refresh delivery details below and compare the receipt with the Instagram conversation.</li></ol>
      <p className="text-xs leading-5 text-muted-foreground">Use a fresh comment for each test. Instagram allows one initial private reply per comment within seven days; follow-up content needs a messaging interaction. An accepted request does not confirm that the person read it.</p>
    </Section>
    <Section title="Recent delivery details" description="Recorded outcomes for this automation only. A refresh retains the last loaded results if it fails.">
      <Button type="button" variant="outline" disabled={loading} onClick={() => void load()}>{loading ? 'Loading delivery details…' : 'Refresh delivery details'}</Button>
      <Errors errors={deliveryError ? [deliveryError] : []} />
      {!loading && !runs.length && <p className="text-sm text-muted-foreground">{deliveryLoaded ? 'No recorded deliveries for this automation yet.' : 'No delivery results loaded. Run your test, then refresh.'}</p>}
      <div className="space-y-3">{runs.slice(0, 10).map(run => <article key={run.id} className="space-y-2 rounded-lg border p-3 text-sm"><p className="font-medium">{instagramRunOutcome(run.status)} · Run #{run.id}</p><p className="text-xs text-muted-foreground">{new Date(run.createdAt).toLocaleString()}</p><p className="text-xs leading-5">{run.reason || 'Review the recorded effects below.'}</p>{run.effects?.map(effect => <p key={effect.kind} className="text-xs">{instagramEffectName(effect.kind)}: {instagramEffectOutcome(effect.status)}{effect.error ? ` — ${effect.error}` : ''}</p>)}{run.status === 'uncertain' && <p className="text-xs">Check Instagram before trying a fresh test. Replaying this send could deliver twice.</p>}{run.status === 'failed' && <p className="text-xs">Resolve the reported issue, then test with a fresh comment. Previous sends are not replayed automatically.</p>}</article>)}</div>
    </Section>
  </div>;
}
