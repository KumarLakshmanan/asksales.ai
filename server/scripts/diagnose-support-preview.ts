/** Run in the configured application environment. Never sends or commits a customer turn. */
import crypto from 'node:crypto';
import { channelGateway } from '../services/agents/pipeline/ChannelGateway.js';
import { sanitizeStructuredForModel } from '../services/agents/orchestration/PrivacyVaultService.js';

const [owner, channel, message] = process.argv.slice(2);
const advisory = process.argv.includes('--advisory');
const historyFlag = process.argv.indexOf('--history');
const history = historyFlag >= 0 ? JSON.parse(process.argv[historyFlag + 1] || 'null') : [];
const followupsFlag = process.argv.indexOf('--follow-ups');
const followups = followupsFlag >= 0 ? JSON.parse(process.argv[followupsFlag + 1] || 'null') : [];
if (!Array.isArray(followups) || followups.length > 12
  || followups.some(turn => typeof turn !== 'string' || !turn.trim() || turn.length > 2000)) {
  throw new Error('Follow-ups must contain at most 12 bounded non-sensitive test messages.');
}
if (!Array.isArray(history) || history.length > 14 || history.some(turn =>
  !['user', 'assistant'].includes(turn?.role) || typeof turn?.content !== 'string' || turn.content.length > 6500)) {
  throw new Error('History must contain at most 14 bounded user/assistant turns.');
}
const userId = Number(owner);
if (!Number.isSafeInteger(userId) || userId <= 0
  || !['web', 'whatsapp', 'instagram', 'facebook', 'email'].includes(channel)
  || !message?.trim() || message.length > 2_000) {
  console.error('Usage: diagnose-support-preview OWNER_ID CHANNEL "non-sensitive test question" [--advisory]');
  process.exit(1);
}

try {
  const conversationId = -(1_500_000_000 + crypto.randomInt(0, 500_000_000));
  for (const turn of [message, ...followups]) {
  const result = await channelGateway.process({
    userId,
    conversationId,
    channel: channel as 'web' | 'whatsapp' | 'instagram' | 'facebook' | 'email',
    senderIdentifier: 'simulator',
    inboundText: turn.trim(),
    rawMessageId: `simulator:${crypto.randomUUID()}`,
    metadata: {
      executionMode: advisory ? 'advisory' : 'preview', dryRun: true,
      conversationKind: advisory ? 'owner_support' : 'owner_simulator',
      conversationHistory: history.slice(-14),
      ...(process.argv.includes('--known-profile') ? { mockContactProfile: { knownName: true } } : {}),
      ...(advisory ? { platformInstructions: 'Answer the workspace owner using published knowledge. This is internal support assistance. Do not start customer intake or ask for contact details. Do not perform external actions.' } : {}),
    },
  });
  const ctx = result.context;
  const evidence = ctx?.contextLanes?.knowledge;
  const diagnostic = sanitizeStructuredForModel({
    outcome: result.method,
    intent: ctx?.nlu?.intent,
    node: ctx?.metadata?.playbookDirective?.nodeId,
    journeyFields: ctx?.metadata?.playbookDirective?.journey?.fields,
    retrievalStatus: evidence?.status,
    retrievalDiagnostics: evidence?.diagnostics,
    classificationUnavailable: ctx?.nlu?.riskFactors.includes('classification_unavailable'),
    evidence: evidence?.evidence.slice(0, 8).map((item) => ({
      id: item.evidenceId, documentId: item.documentId,
    })),
    verification: ctx?.agentResult?.answerVerification,
    repair: ctx?.metadata?.knowledgeAnswerRepair,
    reply: ctx?.agentResult?.replyText,
    policyViolations: ctx?.policyViolations,
    sideEffectsSuppressed: ctx?.message.metadata?.dryRun === true,
  }).value;
  console.log(`SUPPORT_PREVIEW_DIAGNOSTIC=${JSON.stringify(diagnostic)}`);
  history.push({ role: 'user', content: turn }, { role: 'assistant', content: ctx?.agentResult?.replyText || '' });
  }
  process.exit(0);
} catch {
  console.error('Support preview failed; no diagnostic was produced.');
  process.exit(1);
}
