/** Shared configuration contract; no provider tokens or customer comment text. */
export type InstagramAutomationKind = 'comment_dm' | 'comment_reply';
export type InstagramProfileKind = 'icebreakers' | 'menu';
export interface InstagramMessageButton {
  title: string;
  url: string;
}
export interface InstagramMessage {
  format: 'text' | 'quick_replies' | 'buttons' | 'carousel';
  text: string;
  quickReplies: Array<{ title: string; payload: string }>;
  buttons: InstagramMessageButton[];
  cards: Array<{
    title: string;
    subtitle: string;
    imageUrl: string;
    buttons: InstagramMessageButton[];
  }>;
}
export interface InstagramRuleDefinition {
  name: string;
  kind: InstagramAutomationKind;
  trigger: {
    keywords: string[];
    negativeKeywords: string[];
    matchMode: 'contains' | 'exact';
    scope: 'all' | 'reels' | 'specific';
    mediaIds: string[];
  };
  message: InstagramMessage;
  publicReplies: string[];
  followGate: { enabled: boolean; prompt: string; retryMessage: string };
  filters: {
    followers: 'any' | 'followers' | 'non_followers';
    skipPreviouslyMessaged: boolean;
    maxPerDay: number;
    cooldownMinutes: number;
  };
  tags: string[];
}
export interface InstagramProfileConfig {
  locales: Array<{
    locale: string;
    questions: Array<{ id: string; question: string }>;
    items: Array<{
      id: string;
      title: string;
      type: 'link' | 'action';
      url: string;
      payload: string;
      response: InstagramMessage;
    }>;
  }>;
}
export interface InstagramAutomationRule {
  id: number;
  accountId: string;
  definition: InstagramRuleDefinition;
  status: 'paused' | 'active';
  priority: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface InstagramAutomationProfile {
  kind: InstagramProfileKind;
  config: InstagramProfileConfig;
  publishedConfig: InstagramProfileConfig | null;
  revision: number;
  syncStatus: 'draft' | 'published' | 'error' | 'syncing' | 'reconciling';
  syncError: string | null;
  syncedAt: string | null;
}
export interface InstagramAutomationReadiness {
  /** Saved account authorization, independent of rollout and feature readiness. */
  authorized?: boolean;
  checks?: Array<{ id: string; title: string; ready: boolean; action: 'reconnect' | 'administrator' | null }>;
  expiresAt?: string | null;
  messages: boolean;
  comments: boolean;
  profile: boolean;
  reasons: string[];
  richMessages: boolean;
  enabled: boolean;
}
export interface InstagramAutomationRun {
  id: number;
  ruleId: number | null;
  ruleName: string;
  sourceKey: string;
  status: string;
  reason: string | null;
  privateMessageId: string | null;
  publicMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  effects?: Array<{ kind: string; status: string; error: string | null }>;
}
export interface InstagramAutomationOverview {
  account: { id: string; username: string | null };
  readiness: InstagramAutomationReadiness;
  profiles: InstagramAutomationProfile[];
  rules: InstagramAutomationRule[];
  stats: {
    triggers: number;
    sent: number;
    failed: number;
    skipped: number;
    pending: number;
    uncertain: number;
  };
}
export interface InstagramAutomationMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
}
export const emptyInstagramMessage = (): InstagramMessage => ({
  format: 'text',
  text: '',
  quickReplies: [],
  buttons: [],
  cards: [],
});
export const emptyInstagramProfile = (): InstagramProfileConfig => ({
  locales: [{ locale: 'default', questions: [], items: [] }],
});
export const newInstagramRule = (kind: InstagramAutomationKind): InstagramRuleDefinition => ({
  name: '',
  kind,
  trigger: {
    keywords: [],
    negativeKeywords: [],
    matchMode: 'contains',
    scope: 'all',
    mediaIds: [],
  },
  message: emptyInstagramMessage(),
  publicReplies: [],
  followGate: {
    enabled: false,
    prompt: 'Please follow our account, then reply DONE to receive your content.',
    retryMessage:
      'We could not confirm your follow yet. Please check that you follow this account and reply DONE to try again, or reply HELP for support.',
  },
  filters: { followers: 'any', skipPreviouslyMessaged: false, maxPerDay: 0, cooldownMinutes: 0 },
  tags: [],
});
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown, max: number) =>
  typeof x === 'string' && x.trim().length > 0 && x.length <= max;
/** Meta counts text message size in UTF-8 bytes, including emoji and other languages. */
export function instagramTextBytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
export function instagramFollowPrompt(prompt: string): string {
  return /\bDONE\b/i.test(prompt)
    ? prompt
    : `${prompt}\nReply DONE after following to verify your follow.`;
}
export function instagramFollowRetryMessage(message: string): string {
  return /\bDONE\b/i.test(message)
    ? message
    : `${message}\nReply DONE to retry, or HELP for support.`;
}
const dmText = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 && instagramTextBytes(value) <= 1000;
const strings = (x: unknown, max: number, length: number) =>
  Array.isArray(x) && x.length <= max && x.every((v) => text(v, length));
const https = (x: unknown) => {
  try {
    const u = new URL(String(x));
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
};
function messageShape(value: unknown): boolean {
  const buttons = (v: unknown) =>
    Array.isArray(v) &&
    v.every((b) => record(b) && typeof b.title === 'string' && typeof b.url === 'string');
  return (
    record(value) &&
    ['text', 'quick_replies', 'buttons', 'carousel'].includes(String(value.format)) &&
    typeof value.text === 'string' &&
    value.text.length <= 2000 &&
    buttons(value.buttons) &&
    Array.isArray(value.quickReplies) &&
    value.quickReplies.every(
      (r) => record(r) && typeof r.title === 'string' && typeof r.payload === 'string'
    ) &&
    Array.isArray(value.cards) &&
    value.cards.every(
      (c) =>
        record(c) &&
        typeof c.title === 'string' &&
        typeof c.subtitle === 'string' &&
        typeof c.imageUrl === 'string' &&
        buttons(c.buttons)
    )
  );
}
export function validateInstagramMessage(value: unknown): string[] {
  if (!record(value)) return ['Provide a DM response.'];
  const e: string[] = [];
  if (!messageShape(value))
    e.push('Provide all message fields, including text and message option lists.');
  if (!['text', 'quick_replies', 'buttons', 'carousel'].includes(String(value.format)))
    e.push('Choose a supported message format.');
  if (['text', 'quick_replies'].includes(String(value.format)) && !dmText(value.text))
    e.push('DM text must contain 1–1,000 UTF-8 bytes. Emoji and some languages use multiple bytes.');
  if (value.format === 'buttons' && !text(value.text, 640))
    e.push('Button message text must contain 1–640 characters.');
  const buttons = (b: unknown, required = true) =>
    Array.isArray(b) &&
    (!required || b.length > 0) &&
    b.length <= 3 &&
    b.every((v) => record(v) && text(v.title, 20) && https(v.url));
  if (value.format === 'buttons' && !buttons(value.buttons))
    e.push('Add 1–3 buttons with titles up to 20 characters and HTTPS links.');
  if (
    value.format === 'quick_replies' &&
    !(
      Array.isArray(value.quickReplies) &&
      value.quickReplies.length > 0 &&
      value.quickReplies.length <= 13 &&
      value.quickReplies.every((v) => record(v) && text(v.title, 20) && text(v.payload, 1000))
    )
  )
    e.push('Add 1–13 quick replies with a title and payload.');
  if (
    value.format === 'carousel' &&
    !(
      Array.isArray(value.cards) &&
      value.cards.length > 0 &&
      value.cards.length <= 10 &&
      value.cards.every(
        (v) =>
          record(v) &&
          text(v.title, 80) &&
          typeof v.subtitle === 'string' &&
          v.subtitle.length <= 80 &&
          typeof v.imageUrl === 'string' &&
          (!v.imageUrl || https(v.imageUrl)) &&
          buttons(v.buttons, false) &&
          (Boolean(v.subtitle) || Boolean(v.imageUrl) || (v.buttons as unknown[]).length > 0)
      )
    )
  )
    e.push('Add 1–10 cards with a title and a description, HTTPS image or up to 3 link buttons.');
  return e;
}
export function validateInstagramRule(value: unknown): string[] {
  if (!record(value)) return ['Provide an automation definition.'];
  const e: string[] = [];
  if (!text(value.name, 120)) e.push('Enter an automation name up to 120 characters.');
  if (!['comment_dm', 'comment_reply'].includes(String(value.kind)))
    e.push('Choose an automation type.');
  const t = value.trigger;
  if (
    !record(t) ||
    !strings(t.keywords, 20, 80) ||
    !(t.keywords as string[]).length ||
    !strings(t.negativeKeywords, 20, 80) ||
    !['contains', 'exact'].includes(String(t.matchMode)) ||
    !['all', 'reels', 'specific'].includes(String(t.scope)) ||
    !strings(t.mediaIds, 100, 100) ||
    (t.scope === 'specific' && !(t.mediaIds as string[]).length)
  )
    e.push('Choose keywords, a match mode and a valid post scope.');
  if (
    !strings(value.publicReplies, 20, 2000) ||
    (value.kind === 'comment_reply' && !(value.publicReplies as string[]).length)
  )
    e.push('Add 1–20 public reply variations, each up to 2,000 characters.');
  if (value.kind === 'comment_dm') e.push(...validateInstagramMessage(value.message));
  else if (!messageShape(value.message))
    e.push('Provide a valid empty message configuration for public replies.');
  const f = value.filters;
  if (
    !record(f) ||
    !['any', 'followers', 'non_followers'].includes(String(f.followers)) ||
    typeof f.skipPreviouslyMessaged !== 'boolean' ||
    ![f.maxPerDay, f.cooldownMinutes].every(
      (v) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 100000
    )
  )
    e.push('Set valid audience and delivery limits.');
  const g = value.followGate;
  if (
    !record(g) ||
    typeof g.enabled !== 'boolean' ||
    (g.enabled &&
      (value.kind !== 'comment_dm' ||
        typeof g.prompt !== 'string' ||
        typeof g.retryMessage !== 'string' ||
        !g.prompt.trim() ||
        !g.retryMessage.trim() ||
        !dmText(instagramFollowPrompt(g.prompt)) ||
        !dmText(instagramFollowRetryMessage(g.retryMessage))))
  )
    e.push('Provide a follow prompt and retry message within 1,000 UTF-8 bytes, including the DONE instruction.');
  if (record(g) && g.enabled && record(f) && f.followers === 'non_followers')
    e.push('The follow gate cannot be combined with a non-followers-only filter.');
  if (
    value.kind === 'comment_dm' &&
    record(g) &&
    !g.enabled &&
    record(value.message) &&
    value.message.format !== 'text'
  )
    e.push(
      'Rich messages require a follow-gate interaction before delivery. Initial comment private replies use text.'
    );
  if (!strings(value.tags, 20, 80)) e.push('Use up to 20 contact tags, each up to 80 characters.');
  if (JSON.stringify(value).length > 50000) e.push('The automation is too large.');
  return e;
}
export function validateInstagramProfile(kind: InstagramProfileKind, value: unknown): string[] {
  if (
    !record(value) ||
    !Array.isArray(value.locales) ||
    !value.locales.length ||
    value.locales.length > 20
  )
    return ['Add 1–20 language groups.'];
  const e: string[] = [],
    locales = new Set<string>(),
    ids = new Set<string>(),
    payloads = new Set<string>();
  for (const group of value.locales) {
    if (
      !record(group) ||
      typeof group.locale !== 'string' ||
      !/^(default|[a-z]{2}_[A-Z]{2})$/.test(group.locale) ||
      locales.has(group.locale)
    ) {
      e.push('Use unique language codes such as en_US, plus a default group.');
      continue;
    }
    locales.add(group.locale);
    if (!Array.isArray(group.questions) || !Array.isArray(group.items)) {
      e.push('Each language must include question and menu item lists.');
      continue;
    }
    const entries = kind === 'icebreakers' ? group.questions : group.items;
    if (
      !Array.isArray(entries) ||
      entries.length < 1 ||
      entries.length > (kind === 'icebreakers' ? 4 : 3)
    ) {
      e.push(
        kind === 'icebreakers'
          ? 'Each language needs 1–4 questions.'
          : 'Each language needs 1–3 menu items.'
      );
      continue;
    }
    for (const item of entries) {
      if (
        !record(item) ||
        typeof item.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,60}$/.test(item.id) ||
        ids.has(item.id)
      ) {
        e.push('Each item needs a unique identifier.');
        continue;
      }
      ids.add(item.id);
      if (kind === 'icebreakers') {
        if (!text(item.question, 80)) e.push('Questions must contain 1–80 characters.');
      } else {
        if (
          typeof item.url !== 'string' ||
          typeof item.payload !== 'string' ||
          !messageShape(item.response)
        )
          e.push('Provide the menu link, action identifier and response configuration.');
        if (!text(item.title, 30)) e.push('Menu labels must contain 1–30 characters.');
        if (item.type === 'link') {
          if (!https(item.url)) e.push('Menu links must use HTTPS.');
        } else if (item.type === 'action') {
          if (
            typeof item.payload !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,100}$/.test(item.payload) ||
            payloads.has(item.payload)
          )
            e.push(
              'Menu actions need unique payloads using letters, numbers, underscores or hyphens.'
            );
          else payloads.add(item.payload);
          e.push(...validateInstagramMessage(item.response));
        } else e.push('Choose a menu action or link.');
      }
    }
  }
  if (!locales.has('default')) e.push('Keep a default language group.');
  if (JSON.stringify(value).length > 100000) e.push('The profile configuration is too large.');
  return [...new Set(e)];
}
export function matchInstagramRule(
  rule: InstagramRuleDefinition,
  comment: { text: string; mediaId: string; isReel: boolean }
): string | null {
  if (rule.trigger.scope === 'specific' && !rule.trigger.mediaIds.includes(comment.mediaId))
    return null;
  if (rule.trigger.scope === 'reels' && !comment.isReel) return null;
  const normalized = comment.text.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  if (
    rule.trigger.negativeKeywords.some((k) =>
      normalized.includes(k.normalize('NFKC').trim().toLocaleLowerCase('en-US'))
    )
  )
    return null;
  return (
    rule.trigger.keywords.find((k) =>
      rule.trigger.matchMode === 'exact'
        ? normalized === k.normalize('NFKC').trim().toLocaleLowerCase('en-US')
        : normalized.includes(k.normalize('NFKC').trim().toLocaleLowerCase('en-US'))
    ) ?? null
  );
}
export function sortInstagramRules<
  T extends { id: number; priority: number; definition: InstagramRuleDefinition },
>(rules: T[]): T[] {
  const rank = { specific: 0, reels: 1, all: 2 };
  return [...rules].sort(
    (a, b) =>
      rank[a.definition.trigger.scope] - rank[b.definition.trigger.scope] ||
      a.priority - b.priority ||
      a.id - b.id
  );
}
export function renderInstagramText(
  template: string,
  values: { username?: string; name?: string; keyword?: string }
): string {
  return template
    .replace(
      /\{\{\s*(username|name|keyword)\s*\}\}/g,
      (_, key: keyof typeof values) => values[key] || (key === 'name' ? 'there' : '')
    )
    .slice(0, 2000);
}
