import { matchInstagramRule, newInstagramRule, sortInstagramRules, type InstagramAutomationRule, type InstagramRuleDefinition } from './instagramAutomations';

export interface InstagramAutomationTestResult {
  matched: boolean; targetWins: boolean; winner: { id: number; name: string } | null;
  keyword: string | null; firstResponse: string | null; summary: string; warnings: string[];
}

export const instagramRuleTemplates = [
  { id: 'guide', title: 'Send a guide', description: 'A GUIDE comment receives your download link.', keyword: 'GUIDE', needsLink: true },
  { id: 'discount', title: 'Share a discount', description: 'An OFFER comment receives your offer link.', keyword: 'OFFER', needsLink: true },
  { id: 'pricing', title: 'Answer pricing questions', description: 'A PRICE comment receives your pricing link.', keyword: 'PRICE', needsLink: true },
  { id: 'hours', title: 'Share opening hours', description: 'An HOURS comment receives your opening hours.', keyword: 'HOURS', needsLink: false },
] as const;
export function instagramRuleFromTemplate(id: string, kind: InstagramRuleDefinition['kind'], link: string, hours: string, follow = false) {
  const template = instagramRuleTemplates.find(value => value.id === id);
  if (!template) throw new Error('Choose an automation template.');
  if (template.needsLink) {
    let url: URL;
    try { url = new URL(link); } catch { throw new Error('Enter a complete HTTPS link.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Enter a complete HTTPS link.');
  } else if (!hours.trim()) throw new Error('Enter your opening hours.');
  const definition = newInstagramRule(kind);
  definition.name = template.title;
  definition.trigger.keywords = [template.keyword];
  const text = id === 'hours' ? `Our opening hours: ${hours.trim()}` : id === 'guide' ? `Here is the guide you asked for: ${link.trim()}` : id === 'discount' ? `Here is our current offer: ${link.trim()}` : `You can find our current pricing here: ${link.trim()}`;
  if (kind === 'comment_reply') definition.publicReplies = [text];
  else definition.message.text = text;
  definition.followGate.enabled = kind === 'comment_dm' && follow;
  return definition;
}
export const instagramQuestionTemplates = {
  Retail: ['What products do you recommend?', 'How can I place an order?', 'What are your delivery options?'],
  Services: ['What services do you offer?', 'How can I book an appointment?', 'Where can I find your pricing?'],
  Education: ['Which courses can I join?', 'How do I enroll?', 'What support do students receive?'],
};
export function instagramAutomationSummary(definition: InstagramRuleDefinition) {
  const where = definition.trigger.scope === 'specific' ? `${definition.trigger.mediaIds.length} selected posts or reels` : definition.trigger.scope === 'reels' ? 'any reel' : 'any post or reel';
  const response = definition.kind === 'comment_reply' ? 'post one public reply variation' : definition.followGate.enabled ? 'send a follow prompt, wait for DONE, verify the follow, then send your content' : 'send one private text response';
  return `When a comment on ${where} ${definition.trigger.matchMode === 'exact' ? 'equals' : 'contains'} ${definition.trigger.keywords.join(' or ') || 'your keyword'}, ${response}.`;
}
export interface InstagramRuleOverlap { id: number; name: string; winnerId: number; example: string; }
/** Potential trigger overlaps. Audience/recipient limits can suppress the winning rule, but never cause fallthrough. */
export function instagramRuleOverlaps(candidate: InstagramAutomationRule, rules: InstagramAutomationRule[]): InstagramRuleOverlap[] {
  const result: InstagramRuleOverlap[] = [];
  for (const other of rules) {
    if (other.id === candidate.id || other.status !== 'active') continue;
    const a = candidate.definition, b = other.definition;
    const mediaId = a.trigger.scope === 'specific' ? a.trigger.mediaIds.find(id => b.trigger.scope !== 'specific' || b.trigger.mediaIds.includes(id)) : b.trigger.scope === 'specific' ? b.trigger.mediaIds[0] : 'sample';
    if (!mediaId) continue;
    const isReel = a.trigger.scope === 'reels' || b.trigger.scope === 'reels';
    const examples = [...a.trigger.keywords, ...b.trigger.keywords];
    if (a.trigger.matchMode === 'contains' && b.trigger.matchMode === 'contains') {
      for (const ak of a.trigger.keywords) for (const bk of b.trigger.keywords) examples.push(`${ak} ${bk}`);
    }
    const example = examples.find(text => matchInstagramRule(a, { text, mediaId, isReel }) && matchInstagramRule(b, { text, mediaId, isReel }));
    if (!example) continue;
    const winner = sortInstagramRules([candidate, other])[0];
    result.push({ id: other.id, name: other.definition.name, winnerId: winner.id, example });
  }
  return result;
}
export function instagramActivationIssues(definition: InstagramRuleDefinition, ready: { enabled: boolean; messages: boolean; comments: boolean; richMessages: boolean; reasons: string[] }) {
  const issues: string[] = [];
  if (!ready.enabled) issues.push('Live automations are not enabled for this account.');
  if (!ready.comments) issues.push('Comment access is unavailable. Review the Instagram connection.');
  if (definition.kind === 'comment_dm' && !ready.messages) issues.push('Messaging access is unavailable. Review the Instagram connection.');
  if (definition.kind === 'comment_dm' && definition.message.format !== 'text' && !ready.richMessages) issues.push('Rich messaging is unavailable for this account.');
  return issues;
}
