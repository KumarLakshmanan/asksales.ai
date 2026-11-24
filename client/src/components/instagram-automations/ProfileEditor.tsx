'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, ArrowDown, GripVertical, Globe, Plus, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  emptyInstagramMessage,
  emptyInstagramProfile,
  instagramAutomationsApi,
  validateInstagramProfile,
  instagramQuestionTemplates,
  type InstagramAutomationProfile,
  type InstagramAutomationReadiness,
  type InstagramProfileConfig,
  type InstagramProfileKind,
} from '@/lib/instagram-automations';
import { Errors, Field, Section, selectClass } from './Fields';
import { MessageComposer } from './MessageComposer';
import { PhonePreview } from './PhonePreview';
import { focusInvalidField, useEditorGuard } from './useEditorGuard';
import { isProfileDraft, useDraftRecovery } from './useDraftRecovery';

const languages = [
  ['default', 'Default (all languages)'],
  ['en_US', 'English (US)'],
  ['en_GB', 'English (UK)'],
  ['ta_IN', 'Tamil'],
  ['hi_IN', 'Hindi'],
  ['te_IN', 'Telugu'],
  ['ml_IN', 'Malayalam'],
  ['kn_IN', 'Kannada'],
  ['es_ES', 'Spanish'],
  ['fr_FR', 'French'],
  ['de_DE', 'German'],
  ['pt_BR', 'Portuguese (Brazil)'],
  ['ar_AR', 'Arabic'],
  ['id_ID', 'Indonesian'],
  ['ja_JP', 'Japanese'],
  ['ko_KR', 'Korean'],
  ['zh_CN', 'Chinese (simplified)'],
];
const newId = () => `item_${crypto.randomUUID().replace(/-/g, '')}`;
const newMenuItem = (): InstagramProfileConfig['locales'][number]['items'][number] => ({ id: newId(), title: '', type: 'action', url: '', payload: `MENU_${crypto.randomUUID().replace(/-/g, '')}`, response: emptyInstagramMessage() });
const newGroup = (kind: InstagramProfileKind, locale = 'default'): InstagramProfileConfig['locales'][number] => ({ locale, questions: kind === 'icebreakers' ? [{ id: newId(), question: '' }] : [], items: kind === 'menu' ? [newMenuItem()] : [] });
const validLink = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } };
export function ProfileEditor({
  accountId,
  username,
  kind,
  initial,
  readiness,
  onBack,
  onSaved,
}: {
  accountId: string;
  username: string;
  kind: InstagramProfileKind;
  initial: InstagramAutomationProfile | null;
  readiness: InstagramAutomationReadiness;
  onBack: () => void;
  onSaved: (profile: InstagramAutomationProfile) => void;
}) {
  const [startingConfig] = useState<InstagramProfileConfig>(() => initial?.config?.locales.some(group => kind === 'icebreakers' ? group.questions.length : group.items.length) ? structuredClone(initial.config) : { locales: [newGroup(kind)] });
  const [config, setConfig] = useState(startingConfig);
  const editorRef = useRef<HTMLDivElement>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [saved, setSaved] = useState(initial),
    [previewLocale, setPreviewLocale] = useState(0),
    [errors, setErrors] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const syncing = saved?.syncStatus === 'syncing' || saved?.syncStatus === 'reconciling';
  const dirty = JSON.stringify(config) !== JSON.stringify(saved?.config || startingConfig);
  const recovery = useDraftRecovery({ accountId, editor: kind, revision: saved?.revision || 0, value: config, dirty, isDraft: isProfileDraft, onRestore: value => { setConfig(value); setPreviewLocale(0); } });
  const confirmLeave = useEditorGuard(dirty, busy, recovery.clear);
  const drag = useRef<{ group: number; index: number } | null>(null);
  const [industry, setIndustry] = useState<keyof typeof instagramQuestionTemplates>('Retail');
  const leave = () => { if (confirmLeave()) onBack(); };
  const changeGroup = (index: number, patch: Partial<InstagramProfileConfig['locales'][number]>) =>
    setConfig((current) => ({
      locales: current.locales.map((group, i) => (i === index ? { ...group, ...patch } : group)),
    }));
  const save = async (publish: boolean) => {
    const validation = validateInstagramProfile(kind, config);
    setErrors(validation);
    setNotice('');
    if (validation.length) { focusInvalidField(editorRef.current); return; }
    setBusy(true);
    try {
      const result = await api.put<InstagramAutomationProfile>(
        `${instagramAutomationsApi(accountId)}/profiles/${kind}`,
        { config, publish, revision: saved?.revision || 0 }
      );
      if (!alive.current) return;
      setSaved(result);
      recovery.clear();
      setConfig(result.config.locales.length ? result.config : emptyInstagramProfile());
      onSaved(result);
      if (publish && result.syncStatus !== 'published')
        setErrors([
          result.syncError || 'Your draft is saved, but Instagram has not confirmed publication.',
        ]);
      else
        setNotice(
          publish
            ? 'Published and confirmed by Instagram.'
            : 'Draft saved. Publish when you are ready.'
        );
    } catch (cause) {
      if (alive.current) { setErrors([cause instanceof Error ? cause.message : 'Changes could not be saved.']); focusInvalidField(editorRef.current); }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !saved ||
      !window.confirm(
        `Remove ${kind === 'menu' ? 'the main menu' : 'all conversation starters'} from Instagram?`
      )
    )
      return;
    setBusy(true);
    setErrors([]);
    setNotice('');
    try {
      const result = await api.delete<InstagramAutomationProfile>(
        `${instagramAutomationsApi(accountId)}/profiles/${kind}`,
        { body: JSON.stringify({ revision: saved.revision }) }
      );
      if (!alive.current) return;
      setSaved(result);
      recovery.clear();
      setConfig(result.config.locales.length ? result.config : emptyInstagramProfile());
      setPreviewLocale(0);
      onSaved(result);
      if (result.syncStatus === 'error')
        setErrors([result.syncError || 'Instagram could not confirm removal.']);
      else if (result.syncStatus === 'syncing' || result.syncStatus === 'reconciling') setNotice('Removal is being verified by Instagram.');
      else setNotice('Removed from Instagram.');
    } catch (cause) {
      if (alive.current) setErrors([cause instanceof Error ? cause.message : 'The setting could not be removed.']);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const refreshPublication = async () => {
    setBusy(true); setErrors([]);
    try { const result = await api.get<InstagramAutomationProfile | null>(`${instagramAutomationsApi(accountId)}/profiles/${kind}`); if (!alive.current || !result) return; setSaved(result); onSaved(result); if (!dirty) setConfig(result.config.locales.length ? result.config : emptyInstagramProfile()); setNotice(result.syncStatus === 'published' ? 'Published and confirmed by Instagram.' : result.syncStatus === 'syncing' || result.syncStatus === 'reconciling' ? 'Instagram is still verifying this change. Check again shortly.' : 'Publication status refreshed.'); }
    catch (cause) { if (alive.current) setErrors([cause instanceof Error ? cause.message : 'Publication status could not be loaded.']); }
    finally { if (alive.current) setBusy(false); }
  };
  return (
    <div ref={editorRef} className="space-y-5" onInput={(event) => {
      if (event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLInputElement && !['checkbox', 'radio'].includes(event.target.type))) {
        if (errors.length) setErrors([]);
        if (notice) setNotice('');
      }
    }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" disabled={busy} onClick={leave}>
          <ArrowLeft className="h-4 w-4" />
          Automation hub
        </Button>
        <Badge variant="outline">
          {dirty
            ? 'Unsaved changes'
            : syncing
              ? 'Verifying publication'
              : saved?.syncStatus === 'published'
                ? 'Published'
                : saved?.syncStatus === 'error'
                  ? 'Publication needs attention'
                  : 'Draft'}
        </Badge>
      </div>
      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_290px]">
        <div className="min-w-0 space-y-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {kind === 'icebreakers' ? 'Conversation starters' : 'Main menu'}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {kind === 'icebreakers'
                ? 'Suggest questions when someone opens your DMs for the first time. Their choice starts a conversation in your inbox.'
                : 'Give people quick access to links or a saved response from the More options menu in your DMs.'}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">Instagram account: <span className="font-medium text-foreground">@{username.replace(/^@/, '')}</span></p>
          </div>
          <Errors errors={errors} />
          {recovery.banner}
          <p className="rounded-lg border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">The default language is the fallback for everyone. Additional languages override it when supported by Instagram. Preview a language to inspect exactly what its visitors see; no translation is generated automatically.</p>
          {notice && (
            <p
              role="status"
              className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm"
            >
              {notice}
            </p>
          )}
          {saved?.syncError && !errors.length && <Errors errors={[saved.syncError]} />}
          <fieldset disabled={busy || syncing} className="space-y-5">
            {config.locales.map((group, groupIndex) => (
              <Section
                key={groupIndex}
                title={languages.find(([code]) => code === group.locale)?.[1] || group.locale}
                description={
                  kind === 'icebreakers'
                    ? 'Up to 4 questions, 80 characters each.'
                    : 'Up to 3 menu items, 30 characters per label.'
                }
              >
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex-1">
                    <Field label={`Language ${groupIndex + 1}`}>
                      <select
                        className={selectClass}
                        value={group.locale}
                        disabled={groupIndex === 0}
                        onChange={(e) => changeGroup(groupIndex, { locale: e.target.value })}
                      >
                        {languages
                          .filter(
                            ([code]) =>
                              code === group.locale ||
                              !config.locales.some((g) => g.locale === code)
                          )
                          .map(([code, label]) => (
                            <option key={code} value={code}>
                              {label}
                            </option>
                          ))}
                        {!languages.some(([code]) => code === group.locale) && (
                          <option value={group.locale}>{group.locale}</option>
                        )}
                      </select>
                    </Field>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setPreviewLocale(groupIndex)}
                    aria-pressed={previewLocale === groupIndex}
                  >
                    Preview
                  </Button>
                  {groupIndex > 0 && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove language ${groupIndex + 1}`}
                      onClick={() => {
                        setConfig({ locales: config.locales.filter((_, i) => i !== groupIndex) });
                        setPreviewLocale(0);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                {kind === 'icebreakers' ? (
                  <>
                    <div className="space-y-3 rounded-lg border bg-muted/20 p-3"><Field label={`Question preset for ${group.locale}`}><select className={selectClass} value={industry} onChange={event => setIndustry(event.target.value as keyof typeof instagramQuestionTemplates)}>{Object.keys(instagramQuestionTemplates).map(name => <option key={name}>{name}</option>)}</select></Field><p className="text-xs text-muted-foreground">Presets are in English. Edit them for this language before publishing.</p><Button type="button" variant="outline" size="sm" onClick={() => { if (group.questions.some(value => value.question.trim()) && !window.confirm('Replace the questions in this language with the preset?')) return; changeGroup(groupIndex, { questions: instagramQuestionTemplates[industry].map(question => ({ id: newId(), question })) }); }}>Use question preset</Button></div>
                    {group.questions.map((question, i) => (
                      <div key={question.id} className="flex items-end gap-2">
                        <div className="flex-1">
                          <Field
                            label={`Question ${i + 1}${groupIndex ? ` (${group.locale})` : ''}`}
                            hint={`${question.question.length} / 80`}
                            error={errors.length > 0 && !question.question.trim() ? 'Write a question people can tap.' : undefined}
                          >
                            <Input
                              maxLength={80}
                              value={question.question}
                              placeholder="e.g. What are your opening hours?"
                              onChange={(e) =>
                                changeGroup(groupIndex, {
                                  questions: group.questions.map((q, n) =>
                                    n === i ? { ...q, question: e.target.value } : q
                                  ),
                                })
                              }
                            />
                          </Field>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="mb-7"
                          aria-label={`Remove question ${i + 1}`}
                          onClick={() =>
                            changeGroup(groupIndex, {
                              questions: group.questions.filter((_, n) => n !== i),
                            })
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={group.questions.length >= 4}
                      onClick={() =>
                        changeGroup(groupIndex, {
                          questions: [...group.questions, { id: newId(), question: '' }],
                        })
                      }
                    >
                      <Plus className="h-4 w-4" />
                      Add question
                    </Button>
                  </>
                ) : (
                  <>
                    {group.items.map((item, i) => (
                      <div key={item.id} className="space-y-4 rounded-lg border bg-muted/15 p-4" onDragOver={event => { if (drag.current?.group === groupIndex) event.preventDefault(); }} onDrop={event => { event.preventDefault(); const source = drag.current; drag.current = null; if (!source || source.group !== groupIndex || source.index === i) return; const items = [...group.items]; const [moved] = items.splice(source.index, 1); items.splice(i, 0, moved); changeGroup(groupIndex, { items }); }}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2"><span draggable onDragStart={event => { drag.current = { group: groupIndex, index: i }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); }} onDragEnd={() => { drag.current = null; }} title="Drag to reorder" className="cursor-grab"><GripVertical aria-hidden="true" className="h-4 w-4 text-muted-foreground" /></span><h3 className="text-sm font-semibold">Menu item {i + 1}</h3></div>
                          <div className="flex gap-1">{[-1, 1].map(delta => <Button key={delta} type="button" variant="ghost" size="icon" disabled={i + delta < 0 || i + delta >= group.items.length} aria-label={`Move menu item ${i + 1} ${delta < 0 ? 'up' : 'down'} in ${group.locale}`} onClick={() => { const items = [...group.items]; [items[i], items[i + delta]] = [items[i + delta], items[i]]; changeGroup(groupIndex, { items }); }}>{delta < 0 ? <ArrowUp aria-hidden="true" className="h-4 w-4" /> : <ArrowDown aria-hidden="true" className="h-4 w-4" />}</Button>)}
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Remove menu item ${i + 1}`}
                            onClick={() =>
                              changeGroup(groupIndex, {
                                items: group.items.filter((_, n) => n !== i),
                              })
                            }
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                          </div>
                        </div>
                        <p className="text-xs leading-5 text-muted-foreground">{item.type === 'link' ? `Opens ${item.url || 'your HTTPS link'} when tapped.` : `Sends your saved ${item.response.format.replace('_', ' ')} response when tapped.`} Use the phone preview to try this action.</p>
                        <Field
                          label={`Menu item ${i + 1} label`}
                          hint={`${item.title.length} / 30`}
                          error={errors.length > 0 && !item.title.trim() ? 'Add a short label for this menu item.' : undefined}
                        >
                          <Input
                            maxLength={30}
                            placeholder="e.g. View pricing"
                            value={item.title}
                            onChange={(e) =>
                              changeGroup(groupIndex, {
                                items: group.items.map((v, n) =>
                                  n === i ? { ...v, title: e.target.value } : v
                                ),
                              })
                            }
                          />
                        </Field>
                        <Field label={`Menu item ${i + 1} type`}>
                          <select
                            className={selectClass}
                            value={item.type}
                            onChange={(e) =>
                              changeGroup(groupIndex, {
                                items: group.items.map((v, n) =>
                                  n === i ? { ...v, type: e.target.value as 'action' | 'link' } : v
                                ),
                              })
                            }
                          >
                            <option value="action">Send a response</option>
                            <option value="link">Open a link</option>
                          </select>
                        </Field>
                        {item.type === 'link' ? (
                          <Field label={`Menu item ${i + 1} link`} error={errors.length > 0 && !validLink(item.url) ? 'Enter a complete HTTPS link, such as https://example.com/pricing.' : undefined}>
                            <Input
                              type="url"
                              placeholder="https://"
                              value={item.url}
                              onChange={(e) =>
                                changeGroup(groupIndex, {
                                  items: group.items.map((v, n) =>
                                    n === i ? { ...v, url: e.target.value } : v
                                  ),
                                })
                              }
                            />
                          </Field>
                        ) : (
                          <>
                            <details className="rounded-lg border p-3"><summary className="cursor-pointer text-xs text-muted-foreground">Advanced action identifier</summary><div className="mt-3"><Field
                              label={`Menu item ${i + 1} action identifier`}
                              hint="Created automatically. Change it only if your team uses a custom action identifier."
                            >
                              <Input
                                value={item.payload}
                                maxLength={100}
                                onChange={(e) =>
                                  changeGroup(groupIndex, {
                                    items: group.items.map((v, n) =>
                                      n === i ? { ...v, payload: e.target.value } : v
                                    ),
                                  })
                                }
                              />
                            </Field></div></details>
                            <MessageComposer
                              tokens={[]}
                              label={`Menu item ${i + 1} response`}
                              value={item.response}
                              richAllowed={readiness.richMessages}
                              showErrors={errors.length > 0}
                              richReason="This account has not confirmed support for rich messages."
                              onChange={(response) =>
                                changeGroup(groupIndex, {
                                  items: group.items.map((v, n) =>
                                    n === i ? { ...v, response } : v
                                  ),
                                })
                              }
                            />
                          </>
                        )}
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={group.items.length >= 3}
                      onClick={() =>
                        changeGroup(groupIndex, {
                          items: [
                            ...group.items,
                            newMenuItem(),
                          ],
                        })
                      }
                    >
                      <Plus className="h-4 w-4" />
                      Add menu item
                    </Button>
                  </>
                )}
              </Section>
            ))}
            <Button
              type="button"
              variant="outline"
              disabled={config.locales.length >= languages.length}
              onClick={() => {
                const locale = languages.find(
                  ([code]) => !config.locales.some((g) => g.locale === code)
                );
                if (locale) {
                  setConfig({
                    locales: [...config.locales, newGroup(kind, locale[0])],
                  });
                  setPreviewLocale(config.locales.length);
                }
              }}
            >
              <Globe className="h-4 w-4" />
              Add language
            </Button>
          </fieldset>
          {syncing && (
            <div className="rounded-lg border p-4"><p role="status" className="text-sm">Instagram is verifying your changes. Editing is available after the result is confirmed.</p><Button className="mt-3" variant="outline" disabled={busy} onClick={() => void refreshPublication()}>Check publication status</Button></div>
          )}
          {saved?.publishedConfig && saved.syncStatus === 'draft' && <p className="text-xs leading-5 text-muted-foreground">Your saved draft is not live yet. The previously published version remains on Instagram until you publish this draft.</p>}
          <details className="rounded-xl border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">Test and publication details</summary><div className="mt-4 space-y-3 text-sm leading-6"><p>Publish your saved setup and wait for confirmed publication. From a consenting second account, {kind === 'icebreakers' ? 'open a fresh DM conversation and tap each question. Check that its text reaches your inbox.' : 'open the DM menu, try every link, and tap each response action. Compare the message with your saved response.'}</p><p>Test each configured language, then remove the setup and verify that Instagram no longer shows it.</p><p className="text-xs text-muted-foreground">Last confirmed publication: {saved?.syncedAt ? new Date(saved.syncedAt).toLocaleString() : 'None recorded'}. Current status: {saved?.syncStatus || 'Not saved'}.</p>{saved?.syncError && <p className="text-xs text-destructive">{saved.syncError} Your last confirmed publication remains available until a change succeeds.</p>}</div></details>
          {(!readiness.profile || !readiness.enabled) && (
            <p className="rounded-lg border bg-muted/40 p-4 text-sm leading-6 text-muted-foreground">
              Publishing is unavailable for this account. {readiness.reasons.join(' ')} You can save
              a draft and review the account connection from the hub.
            </p>
          )}
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 py-4 backdrop-blur-sm">
            <Button
              variant="ghost"
              className="text-destructive"
              disabled={busy || syncing || !saved}
              onClick={() => void remove()}
            >
              <Trash2 className="h-4 w-4" />
              Remove from Instagram
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy || syncing} onClick={() => void save(false)}>
                Save draft
              </Button>
              <Button
                disabled={busy || syncing || !readiness.profile || !readiness.enabled}
                onClick={() => void save(true)}
              >
                {busy ? 'Saving…' : 'Publish to Instagram'}
              </Button>
            </div>
          </div>
        </div>
        <PhonePreview username={username} kind={kind} profile={config} locale={previewLocale} />
      </div>
    </div>
  );
}
