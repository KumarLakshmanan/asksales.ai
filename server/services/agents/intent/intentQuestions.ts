import { choice, type DecisionQuestions } from './decisionContract.js';
import { SUPPORT_REQUEST_ACTIONS, SUPPORT_REQUEST_SERVICES } from '../orchestration/SupportSemanticIntent.js';
import { SUPPORT_INTENTS } from '../../../../shared/supportIntents.js';
import { SENTIMENT_LABEL_QUESTION } from './sentimentQuestions.js';

const yesNo = { true: 'Yes, affirmatively requested in this turn and context.', false: 'No; absent, negated, hypothetical, or merely quoted.' };

/** Independent membership choices preserve compound requests; ordering remains
 * an extraction task. Never reduce a multi-agent turn to a single classifier label. */
export const CAMPAIGN_INTENT_QUESTIONS: DecisionQuestions = {
  action: choice('What speech act does the latest user turn perform? Preparing a saved asset or review is work, even when execution is prohibited. Advice or examples requested only as a chat answer, without creating assets/reviews or executing anything, are question, including a subject-line example, outreach prerequisites and a suggested ad budget from multiple specialists. A prohibition on running anything while leaving a review pending is not cancellation.', {
    new_task: 'Requests new work.', continue: 'Proceeds with the current selected work.', revise: 'Changes existing work or prepares selected strategy settings.',
    question: 'Asks only for explanation, status, facts, advice or examples in chat without changing saved work.', switch_agent: 'Explicitly switches the addressed specialist.',
    cancel: 'Cancels a specific operation or campaign.', clarify: 'Ambiguous request or unresolved choice requiring a question.',
  }),
  intent: choice('Classify the overall turn under the campaign router contract. Questions requesting real campaign data are task, even when phrased as show.', {
    conversational: 'Greeting, thanks, or casual conversation without work.',
    task: 'Requests specialist work or factual information from tools: includes showing existing campaign performance, lead records, available strategies, or pending actions.',
    meta: 'Discusses the assistant itself, its capabilities, or how to use it.',
    navigation: 'Only asks to open or switch a UI view, not retrieve, analyze or change information.',
  }),
  'semanticRequest.status': choice('Is the requested answer ONLY about pending approvals/reviews, execution progress or recipient delivery receipts? Classify the requested information, not safety prohibitions or old pending cards. Prospective outreach readiness (can we send, what prerequisite is missing), eligible contact counts, sender connections, consent and template requirements are none: they need outreach read-only queries, not historical review receipts. Performance analytics, charts, spend/CTR/conversions and saved content/lead lookups are none, even when the user says do not create reviews, publish, schedule or spend. Compound work requests are none.', {
    none: 'Not exclusively an approval/execution/delivery-status question; includes read-only performance analytics and saved-record lookups.',
    campaign_actions: 'Only asks which actions need approval, are queued/running/completed/failed, or which recipients were sent/delivered.',
  }),
  'semanticRequest.contentOperation': choice('Classify content lifecycle: revising an unexecuted review differs from editing a saved asset. Scheduling a NEW post is publish_new. Advice or an example requested only in chat with no saved content or review is none.', ['none', 'generate', 'revise_review', 'manage_saved', 'publish_new']),
  'semanticRequest.outreachOperation': choice('Is the user preparing recipient outreach, working on a proposal, or neither? Standalone copy is none.', ['none', 'campaign', 'proposal']),
  ...Object.fromEntries(Object.entries({
    icp_generation: 'Business research or creating/revising the ideal customer profile; do not repeat an already approved ICP.',
    lead_generation: 'Prospect search, catalog, search settings, existing shortlist or lead selection.',
    content_studio: 'Standalone copy, templates, images, videos, organic posts or organic publishing/scheduling. Recipient campaign preparation belongs to outreach.',
    outreach: 'Preparing campaigns/sequences for selected recipients, even if copy is also requested and sending is prohibited; proposals and outreach management. Also read-only questions about outreach readiness, usable email/phone counts, missing recipients, sender connections, consent or template prerequisites. Can we send is readiness, not historical delivery status.',
    performance_marketing: 'Paid Meta/Google ads, paid campaign preparation, publication or performance analytics; not organic posts.',
  }).map(([agent, definition]) => [`hiredAgents.${agent}`, choice(`Should hiredAgents include ${agent}? ${definition} Include only work actually requested, not negated or mentioned domains. A status-only campaign_actions request has no agents. A clarify turn has no agents.`, yesNo)])),
};

export const SUPPORT_INTENT_QUESTIONS: DecisionQuestions = {
  contactPreference: choice('Does the customer personally withdraw permission for ALL future automated contact in this conversation? Classify the latest message in any language. Cancellation of a booking, rejection of one offer, quoted examples, and requests for a human are NOT withdrawal of contact permission. A preference limited to promotions, one category, or a different channel is uncertain: this system cannot represent that narrower scope. unchanged never means re-opt-in.', {
    opt_out: 'Explicitly asks this business to stop contacting or messaging them, including conversational paraphrases.',
    unchanged: 'No explicit withdrawal of contact permission.',
  }),
  'sentiment.label': SENTIMENT_LABEL_QUESTION,
  intent: choice('Classify the primary customer intent, independently of whether this is a continuation answering a slot question.', SUPPORT_INTENTS),
  'semanticRequest.action': choice('Classify the LATEST request. A field/date/count answer is continue; a replacement of a previously supplied value is correction. A new reservation request is booking. Exploring a service with do not book is information, not a negated informational request. Polite questions asking you to arrange/reserve an appointment are booking, not factual information, in any language. An existing brochure is document; creating or saving a custom written room/service offer as a draft is proposal_create, even after draft wording appeared in chat. Chat text is not a saved proposal; proposal_revision requires a request to amend an existing proposal. Accepting the immediately preceding offer to connect with support is human, not booking/callback consent; declining it is not human. Recall of previous conversations is history. Negated/hypothetical actions are not explicit.', SUPPORT_REQUEST_ACTIONS),
  'semanticRequest.service': choice('Which service is actually requested? Resolve references using recent context, but honor topic changes; a spa request is never corporate simply because corporate was previously discussed.', SUPPORT_REQUEST_SERVICES),
  'semanticRequest.explicit': choice('Is the selected action actually requested (not negated, hypothetical, quoted or third-party)? Do not book/confirm/contact prohibits those actions, NOT an affirmative request to explore information, switch service, or correct a time.', yesNo),
  'semanticRequest.topicSwitch': choice('Does the customer request a different journey rather than answer, correct or repeat the current question?', yesNo),
  'semanticRequest.pricingRequested': choice('Does the latest turn ask for pricing? An answer supplying a date/count is false even when pricing was discussed earlier.', yesNo),
  'semanticRequest.media': choice('Classify image/gallery intent. Existing documents/PDFs/brochures use none, as do sensitive transactions, refunds, payments and account status.', {
    none: 'No images needed.', explicit: 'Affirmatively requests pictures/photos/visual appearance.', helpful: 'Images materially help the actual product/service comparison.',
  }),
};
