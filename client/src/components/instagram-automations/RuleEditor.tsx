'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Plus, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Callout } from '@/components/ui/callout';
import {
  instagramAutomationsApi,
  newInstagramRule,
  validateInstagramRule,
  validateInstagramMessage,
  instagramTextBytes,
  instagramFollowPrompt,
  instagramFollowRetryMessage,
  instagramAutomationSummary,
  instagramRuleOverlaps,
  renderInstagramText,
  type InstagramAutomationKind,
  type InstagramAutomationReadiness,
  type InstagramAutomationRule,
  type InstagramRuleDefinition,
} from '@/lib/instagram-automations';
import { Errors, Field, Section, Toggle, TokenInput, selectClass } from './Fields';
import { MediaPicker } from './MediaPicker';
import { MessageComposer } from './MessageComposer';
import { PhonePreview } from './PhonePreview';
import { focusInvalidField, useEditorGuard } from './useEditorGuard';
import { isRuleDraft, useDraftRecovery } from './useDraftRecovery';
import { TemplatePicker } from './TemplatePicker';
import { AutomationDiagnostics } from './AutomationDiagnostics';

const steps = ['Choose posts', 'Set the trigger', 'Compose the DM', 'Review and save'];
export function RuleEditor({
  accountId,
  username,
  kind,
  initial,
  guided = false,
  followGatePreset = false,
  readiness,
  rules = [],
  onBack,
  onSaved,
}: {
  accountId: string;
  username: string;
  kind: InstagramAutomationKind;
  initial: InstagramAutomationRule | null;
  guided?: boolean;
  followGatePreset?: boolean;
  readiness: InstagramAutomationReadiness;
  rules?: InstagramAutomationRule[];
  onBack: () => void;
  onSaved: (rule: InstagramAutomationRule) => void;
}) {
  const [startingDefinition] = useState<InstagramRuleDefinition>(() => {
    if (initial) return structuredClone(initial.definition);
    const value = newInstagramRule(kind);
    if (kind === 'comment_reply') value.publicReplies = [''];
    if (kind === 'comment_dm' && followGatePreset) value.followGate.enabled = true;
    return value;
  });
  const [definition, setDefinition] = useState(startingDefinition);
  const editorRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [wizard, setWizard] = useState(guided && kind === 'comment_dm'),
    [step, setStep] = useState(0),
    [errors, setErrors] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<'post' | 'comments' | 'dm'>(
      guided ? 'post' : kind === 'comment_reply' ? 'comments' : 'dm'
    );
  const dirty = JSON.stringify(definition) !== JSON.stringify(startingDefinition);
  const recovery = useDraftRecovery({ accountId, editor: initial ? `rule-${initial.id}` : `new-${kind}-${followGatePreset ? 'follow' : 'standard'}`, revision: initial?.revision || 0, value: definition, dirty, isDraft: (value): value is InstagramRuleDefinition => isRuleDraft(value) && value.kind === kind, onRestore: setDefinition });
  const confirmLeave = useEditorGuard(dirty, busy, recovery.clear);
  const [diagnostics, setDiagnostics] = useState(false);
  const overlaps = instagramRuleOverlaps({ id: initial?.id || Number.MAX_SAFE_INTEGER, priority: initial?.priority ?? Number.MAX_SAFE_INTEGER, status: 'active', accountId, definition, revision: 0, createdAt: '', updatedAt: '' }, rules);
  const leave = () => { if (confirmLeave()) onBack(); };
  const goToStep = (nextStep: number) => {
    setStep(nextStep);
    setPreview(nextStep === 0 ? 'post' : nextStep === 1 ? 'comments' : 'dm');
    setErrors([]);
    editorRef.current?.scrollIntoView?.({ block: 'start' });
  };
  const setTrigger = (patch: Partial<InstagramRuleDefinition['trigger']>) =>
    setDefinition((value) => ({ ...value, trigger: { ...value.trigger, ...patch } }));
  const setFilters = (patch: Partial<InstagramRuleDefinition['filters']>) =>
    setDefinition((value) => ({ ...value, filters: { ...value.filters, ...patch } }));
  const update = (patch: Partial<InstagramRuleDefinition>) =>
    setDefinition((value) => ({ ...value, ...patch }));
  const save = async () => {
    const validation = validateInstagramRule(definition);
    setErrors(validation);
    if (validation.length) { focusInvalidField(editorRef.current); return; }
    setBusy(true);
    try {
      const result = initial
        ? await api.put<InstagramAutomationRule>(
            `${instagramAutomationsApi(accountId)}/rules/${initial.id}`,
            { definition, status: initial.status, revision: initial.revision }
          )
        : await api.post<InstagramAutomationRule>(`${instagramAutomationsApi(accountId)}/rules`, {
            definition,
          });
      if (alive.current) { recovery.clear(); onSaved(result); }
    } catch (cause) {
      if (alive.current) { setErrors([cause instanceof Error ? cause.message : 'Automation could not be saved.']); focusInvalidField(editorRef.current); }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const next = () => {
    let validation: string[] = [];
    if (
      step === 0 &&
      definition.trigger.scope === 'specific' &&
      !definition.trigger.mediaIds.length
    )
      validation = ['Select at least one post or reel.'];
    if (step === 1) {
      if (!definition.trigger.keywords.length) validation.push('Add at least one trigger keyword.');
      if (definition.publicReplies.some((text) => !text.trim()))
        validation.push('Write each public reply variation or remove the empty one.');
      if (
        definition.followGate.enabled &&
        (!definition.followGate.prompt.trim() || !definition.followGate.retryMessage.trim())
      )
        validation.push('Write the follow prompt and retry message.');
      if (
        definition.followGate.enabled &&
        (instagramTextBytes(instagramFollowPrompt(definition.followGate.prompt)) > 1000 ||
          instagramTextBytes(instagramFollowRetryMessage(definition.followGate.retryMessage)) > 1000)
      )
        validation.push('Shorten the follow prompt and retry message to fit within 1,000 bytes each.');
    }
    if (step === 2) validation = validateInstagramMessage(definition.message);
    setErrors(validation);
    if (validation.length) { focusInvalidField(editorRef.current); return; }
    goToStep(step + 1);
  };
  const title = definition.followGate.enabled ? initial ? 'Edit follow to unlock' : 'New follow to unlock' : initial
    ? 'Edit automation'
    : kind === 'comment_dm'
      ? 'New comment to DM'
      : 'New public comment reply';
  const scope = (
    <Section
      title="Choose posts"
      description="Choose where a matching comment can start this automation."
    >
      <div className="space-y-2">
        {(
          [
            {
              value: 'all',
              title: 'Any post or reel',
              description: 'Include current and future posts and reels.',
            },
            {
              value: 'specific',
              title: 'Specific posts or reels',
              description: 'Select the exact content for this automation.',
            },
            {
              value: 'reels',
              title: 'Only reels',
              description: 'Respond to matching comments on reels.',
            },
          ] as const
        ).map((item) => (
          <label
            key={item.value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${definition.trigger.scope === item.value ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'}`}
          >
            <input
              type="radio"
              name="media-scope"
              checked={definition.trigger.scope === item.value}
              onChange={() => setTrigger({ scope: item.value })}
              className="mt-1 accent-primary"
            />
            <span>
              <span className="block text-sm font-medium">{item.title}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{item.description}</span>
            </span>
          </label>
        ))}
      </div>
      {definition.trigger.scope === 'specific' && (
        <MediaPicker
          accountId={accountId}
          selected={definition.trigger.mediaIds}
          onChange={(mediaIds) => setTrigger({ mediaIds })}
        />
      )}
    </Section>
  );
  const trigger = (
    <Section
      title="When someone comments"
      description="For example, match GUIDE to send the person your guide. Choose the words your audience will comment."
    >
      <TokenInput
        label="Trigger keywords"
        value={definition.trigger.keywords}
        onChange={(keywords) => setTrigger({ keywords })}
        hint="Any of these keywords can match. Matching ignores letter case."
        placeholder="e.g. guide, price, link"
        error={errors.length > 0 && !definition.trigger.keywords.length ? 'Add at least one keyword.' : undefined}
      />
      <p className="rounded-lg bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">{definition.trigger.keywords.length ? `Example: “${definition.trigger.matchMode === 'contains' ? `Please send ${definition.trigger.keywords[0]}` : definition.trigger.keywords[0]}” will match this rule.` : 'Try a keyword: GUIDE, PRICE, or LINK.'} The saved rule answers before your AI assistant.</p>
      <Field label="Keyword matching">
        <select
          className={selectClass}
          value={definition.trigger.matchMode}
          onChange={(e) => setTrigger({ matchMode: e.target.value as 'contains' | 'exact' })}
        >
          <option value="contains">Comment contains a keyword</option>
          <option value="exact">Whole comment matches a keyword</option>
        </select>
      </Field>
      <TokenInput
        label="Negative keywords"
        value={definition.trigger.negativeKeywords}
        onChange={(negativeKeywords) => setTrigger({ negativeKeywords })}
        hint="Skip this rule if the comment contains any of these."
      />
    </Section>
  );
  const publicReply = (
    <Section
      title={kind === 'comment_reply' ? 'Public reply' : 'Public acknowledgement'}
      description={
        kind === 'comment_reply'
          ? 'Reply directly in the comment thread. One variation is selected for each comment.'
          : 'An acknowledgement is posted only after Instagram accepts the private message.'
      }
    >
      {kind === 'comment_dm' && (
        <Toggle
          label="Reply publicly to the comment"
          checked={definition.publicReplies.length > 0}
          onChange={(checked) => update({ publicReplies: checked ? [''] : [] })}
        />
      )}
      {definition.publicReplies.map((reply, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="flex-1">
            <Field label={`Public reply ${i + 1}`} hint={`${reply.length} / 2,000`} error={errors.length > 0 && !reply.trim() ? 'Write this reply or remove the empty variation.' : undefined}>
              <Textarea
                maxLength={2000}
                value={reply}
                onChange={(e) =>
                  update({
                    publicReplies: definition.publicReplies.map((text, n) =>
                      n === i ? e.target.value : text
                    ),
                  })
                }
                placeholder={kind === 'comment_reply' ? 'e.g. Thanks for asking! Find our current menu at the link in our bio.' : 'e.g. I have sent the details to your DMs. Please check your message requests.'}
              />
            </Field>
          </div>
          <Button
            className="mt-6"
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Remove public reply ${i + 1}`}
            onClick={() =>
              update({ publicReplies: definition.publicReplies.filter((_, n) => n !== i) })
            }
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {(kind === 'comment_reply' || definition.publicReplies.length > 0) && (
        <>
          <p className="text-xs text-muted-foreground">
            Personalize with {'{{username}}'}, {'{{name}}'} or {'{{keyword}}'}.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={definition.publicReplies.length >= 20}
            onClick={() => update({ publicReplies: [...definition.publicReplies, ''] })}
          >
            <Plus className="h-4 w-4" />
            Add reply variation
          </Button>
        </>
      )}
      {definition.publicReplies.length > 1 && <div className="grid gap-3 sm:grid-cols-2" aria-label="Compare public reply variations">{definition.publicReplies.map((reply, index) => <div key={index} className="rounded-lg border bg-muted/20 p-3"><p className="mb-2 text-xs font-medium">Variation {index + 1}</p><p className="whitespace-pre-wrap break-words text-sm leading-6">{renderInstagramText(reply, { username: 'test_person', name: 'Test person', keyword: definition.trigger.keywords[0] || 'GUIDE' }) || 'Write this variation above.'}</p></div>)}</div>}
    </Section>
  );
  const followGate = kind === 'comment_dm' && (
    <Section
      title="Ask people to follow first"
      description="Release your content only after Instagram confirms this person follows your account."
    >
      <Toggle
        label="Require a verified follow"
        hint="First send a text prompt. The person replies DONE, then AskSales checks their follow status before sending the content."
        checked={definition.followGate.enabled}
        onChange={(enabled) =>
          update({
            followGate: { ...definition.followGate, enabled },
            filters: enabled && definition.filters.followers === 'non_followers' ? { ...definition.filters, followers: 'any' } : definition.filters,
            message: !enabled ? { ...definition.message, format: 'text' } : definition.message,
          })
        }
      />
      {definition.followGate.enabled && (
        <>
          <Field label="Follow prompt" hint={`${instagramTextBytes(instagramFollowPrompt(definition.followGate.prompt))} / 1,000 bytes including the reply instruction. Non-English characters may use multiple bytes.`} error={instagramTextBytes(instagramFollowPrompt(definition.followGate.prompt)) > 1000 ? 'Shorten the follow prompt to fit within 1,000 bytes.' : errors.length > 0 && !definition.followGate.prompt.trim() ? 'Write the prompt people receive first.' : undefined}>
            <Textarea
              maxLength={1000}
              rows={3}
              value={definition.followGate.prompt}
              onChange={(e) =>
                update({ followGate: { ...definition.followGate, prompt: e.target.value } })
              }
            />
          </Field>
          <Field
            label="Follow verification retry message"
            hint={`${instagramTextBytes(instagramFollowRetryMessage(definition.followGate.retryMessage))} / 1,000 bytes including the reply instruction. Include a retry and support path; content remains pending until the follow is verified.`}
            error={instagramTextBytes(instagramFollowRetryMessage(definition.followGate.retryMessage)) > 1000 ? 'Shorten the retry message to fit within 1,000 bytes.' : errors.length > 0 && !definition.followGate.retryMessage.trim() ? 'Write a retry and support message.' : undefined}
          >
            <Textarea
              maxLength={1000}
              rows={4}
              value={definition.followGate.retryMessage}
              onChange={(e) =>
                update({ followGate: { ...definition.followGate, retryMessage: e.target.value } })
              }
            />
          </Field>
        </>
      )}
    </Section>
  );
  const message = kind === 'comment_dm' && (
    <Section
      title="Compose the DM"
      description={
        definition.followGate.enabled
          ? 'This is the content sent after the follow is verified.'
          : 'Send one text message privately in response to the comment.'
      }
    >
      <MessageComposer
        value={definition.message}
        onChange={(value) => update({ message: value })}
        richAllowed={definition.followGate.enabled && readiness.richMessages}
        showErrors={errors.length > 0}
        richReason={
          !definition.followGate.enabled
            ? 'The first private reply to a comment supports text. Enable the follow gate to send rich content after the person responds.'
            : 'This account has not confirmed support for rich messages.'
        }
      />
    </Section>
  );
  const filters = (
    <Section
      title="Audience and limits"
      description="Limits apply to this rule and each person. Daily limits reset at midnight UTC."
    >
      <Field label="Audience">
        <select
          className={selectClass}
          value={definition.filters.followers}
          onChange={(e) =>
            setFilters({
              followers: e.target.value as InstagramRuleDefinition['filters']['followers'],
            })
          }
        >
          <option value="any">Everyone</option>
          <option value="followers">Verified followers only</option>
          <option value="non_followers" disabled={definition.followGate.enabled}>
            Verified non-followers only
          </option>
        </select>
      </Field>
      {definition.filters.followers !== 'any' && (
        <p className="text-xs text-muted-foreground">
          If Instagram cannot verify the person’s follow status, delivery is skipped.
        </p>
      )}
      <Toggle
        label="Skip people already answered by this rule"
        checked={definition.filters.skipPreviouslyMessaged}
        onChange={(skipPreviouslyMessaged) => setFilters({ skipPreviouslyMessaged })}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Maximum sends per person per day" hint="0 means no additional daily limit.">
          <Input
            type="number"
            min={0}
            max={100000}
            value={definition.filters.maxPerDay}
            onChange={(e) => setFilters({ maxPerDay: Number(e.target.value) })}
          />
        </Field>
        <Field label="Cooldown per person (minutes)" hint="0 means no additional cooldown.">
          <Input
            type="number"
            min={0}
            max={100000}
            value={definition.filters.cooldownMinutes}
            onChange={(e) => setFilters({ cooldownMinutes: Number(e.target.value) })}
          />
        </Field>
      </div>
      <TokenInput
        label="Contact tags"
        value={definition.tags}
        onChange={(tags) => update({ tags })}
        hint="Add these tags when this rule triggers."
      />
    </Section>
  );
  return (
    <div ref={editorRef} className="space-y-5" onInput={(event) => {
      if (event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLInputElement && !['checkbox', 'radio'].includes(event.target.type))) {
        if (errors.length) setErrors([]);
      }
    }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" disabled={busy} onClick={leave}>
          <ArrowLeft className="h-4 w-4" />
          Back to automations
        </Button>
        {kind === 'comment_dm' && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setWizard((value) => !value);
              setPreview(!wizard ? (step === 0 ? 'post' : step === 1 ? 'comments' : 'dm') : 'dm');
              setErrors([]);
            }}
          >
            {wizard ? 'Switch to advanced editor' : 'Use guided setup'}
          </Button>
        )}
      </div>
      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_290px]">
        <div className="min-w-0 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {initial?.status === 'active'
                  ? 'Saving updates this active automation.'
                  : definition.followGate.enabled ? 'Ask for a follow after a keyword comment. Send your content after the person replies and Instagram verifies the follow.' : kind === 'comment_dm' ? 'A keyword in a comment sends one private response. Save your setup, then turn it on from saved automations.' : 'A keyword in a comment posts your response in the same thread. Save your setup, then turn it on from saved automations.'}
              </p>
            </div>
            <Badge variant="outline">{initial?.status === 'active' ? 'Active' : 'Paused'}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">Sending from <span className="font-medium text-foreground">@{username.replace(/^@/, '')}</span>{dirty ? ' · Unsaved changes' : ''}</p>
          {recovery.banner}
          {definition.followGate.enabled && <Section title="How follow to unlock works"><ol className="grid gap-2 text-xs leading-5 sm:grid-cols-4" aria-label="Follow verification flow">{['Keyword comment', 'Follow prompt + reply DONE', 'Instagram verifies the follow', 'Promised content arrives'].map((label, index) => <li key={label} className="rounded-lg border bg-muted/20 p-3"><span className="mb-1 block font-semibold text-primary">{index + 1}</span>{label}</li>)}</ol><p className="text-xs text-muted-foreground">An unconfirmed follow keeps the content pending and sends your retry message.</p></Section>}
          {wizard && (
            <ol aria-label="Setup progress" className="grid grid-cols-4 gap-2">
              {steps.map((label, i) => (
                <li
                  key={label}
                  className={`border-t-2 pt-2 ${i <= step ? 'border-primary' : 'border-muted'}`}
                >
                  <button type="button" disabled={i >= step || busy} onClick={() => goToStep(i)} aria-current={i === step ? 'step' : undefined}
                    className={`flex items-center gap-1 text-[11px] ${i === step ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
                  >
                    {i < step ? <Check className="h-3 w-3 shrink-0" /> : `${i + 1}. `}
                    {label}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <Errors errors={errors} />
          <fieldset disabled={busy} className="space-y-5">
            {!initial && (!wizard || step === 0) && <TemplatePicker kind={kind} follow={definition.followGate.enabled} onApply={value => { if (dirty && !window.confirm('Replace this unfinished setup with the template?')) return; setDefinition(value); setErrors([]); }} />}
            {(!wizard || step === 3) && (
              <Section title={wizard ? 'Review your automation' : 'Automation details'}>
                <Field label="Automation name" hint="Only your team sees this name." error={errors.length > 0 && !definition.name.trim() ? 'Name this automation so you can find it later.' : undefined}>
                  <Input
                    value={definition.name}
                    maxLength={120}
                    placeholder="e.g. Product guide requests"
                    onChange={(e) => update({ name: e.target.value })}
                  />
                </Field>
                {wizard && (
                  <dl className="grid grid-cols-[100px_1fr] gap-x-4 gap-y-3 text-sm">
                    <dt className="text-muted-foreground">Posts</dt>
                    <dd>
                      {definition.trigger.scope === 'specific'
                        ? `${definition.trigger.mediaIds.length} selected`
                        : definition.trigger.scope === 'reels'
                          ? 'Only reels'
                          : 'Any post or reel'}
                    </dd>
                    <dt className="text-muted-foreground">Keywords</dt>
                    <dd className="break-words">{definition.trigger.keywords.join(', ')}</dd>
                    <dt className="text-muted-foreground">Follow gate</dt>
                    <dd>{definition.followGate.enabled ? 'Verified follow required' : 'Off'}</dd>
                    <dt className="text-muted-foreground">First message</dt>
                    <dd>{definition.followGate.enabled ? 'Follow prompt' : 'Your DM content'}</dd>
                  </dl>
                )}
              </Section>
            )}
            {(!wizard || step === 0) && scope}
            {(!wizard || step === 1) && (
              <>
                {trigger}
                {publicReply}
                {followGate}
              </>
            )}
            {(!wizard || step === 2) && message}
            {(!wizard || step === 3) && filters}
          </fieldset>
          {(!wizard || step === 3) && <Section title="Before activation"><p className="text-sm leading-6">{instagramAutomationSummary(definition)}</p><p className="text-xs text-muted-foreground">{definition.publicReplies.length} public reply variation(s). {definition.filters.maxPerDay ? `Up to ${definition.filters.maxPerDay} sends per person each day.` : 'No additional daily recipient limit.'} {definition.filters.cooldownMinutes ? `${definition.filters.cooldownMinutes}-minute recipient cooldown.` : ''}</p>{overlaps.length > 0 && <Callout tone="warning" size="sm" title={`Potential overlap with ${overlaps.length} active automation(s)`}><div className="space-y-2">{overlaps.slice(0, 5).map(overlap => <p key={overlap.id} className="text-xs leading-5">“{overlap.name}” also matches “{overlap.example}” on shared content. {overlap.winnerId === initial?.id ? 'This automation takes priority.' : 'Review scope and priority before activating.'}</p>)}<p className="text-xs text-muted-foreground">One automation wins per comment. Audience checks can suppress its reply without passing the comment to another automation.</p></div></Callout>}</Section>}
          {initial && <div className="space-y-4"><Button type="button" variant="outline" onClick={() => setDiagnostics(value => !value)}>{diagnostics ? 'Hide test and delivery details' : 'Test and delivery details'}</Button>{diagnostics && <><p className="text-xs text-muted-foreground">Testing uses the saved version. Save any edits before checking them.</p><AutomationDiagnostics accountId={accountId} rule={initial} /></>}</div>}
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 py-4 backdrop-blur-sm">
            {wizard && step > 0 ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  goToStep(step - 1);
                }}
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
            ) : (
              <Button variant="outline" disabled={busy} onClick={leave}>
                Cancel
              </Button>
            )}
            {wizard && step < 3 ? (
              <Button onClick={next}>
                Next
                <ArrowRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : initial ? 'Save changes' : 'Create paused automation'}
              </Button>
            )}
          </div>
        </div>
        <PhonePreview username={username} rule={definition} tab={preview} onTab={setPreview} />
      </div>
    </div>
  );
}
