/** Bounded, synthetic replay against an owner's published flow. No customer writes or sends. */
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { channelGateway } from '../services/agents/pipeline/ChannelGateway.js';
import { validatePlaybookGraph } from '../services/agents/orchestration/PlaybookEngine.js';
import { initializeJourneyState } from '../services/agents/orchestration/SupportJourneyRuntime.js';
import { supportPreviewStore } from '../services/agents/orchestration/SupportPreviewStore.js';
import { sanitizeStructuredForModel } from '../services/agents/orchestration/PrivacyVaultService.js';
import type { PlaybookGraph } from '../models/supportOrchestration/schema.js';

const [owner, selected] = process.argv.slice(2);
const userId = Number(owner), playbookId = Number(selected);
if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(playbookId) || playbookId <= 0) {
  throw new Error('Usage: diagnose-active-occupancy OWNER_ID PUBLISHED_PLAYBOOK_ID');
}
try {
  const result = await db.execute(sql`SELECT p.id, p.agent_type, p.active_version, p.draft_graph, v.graph
    FROM support_playbooks p LEFT JOIN support_playbook_versions v
    ON v.playbook_id=p.id AND v.version=p.active_version
    WHERE p.user_id=${userId} AND p.status<>'archived'
      AND p.agent_type=(SELECT agent_type FROM support_playbooks WHERE id=${playbookId} AND user_id=${userId})`);
  const rows = result.rows as { id: number; agent_type: string; active_version: number; draft_graph: PlaybookGraph; graph?: PlaybookGraph }[];
  for (const row of rows) {
    console.log('PLAYBOOK_VALIDATION=' + JSON.stringify({ id: row.id,
      draftErrors: validatePlaybookGraph(row.draft_graph),
      publishedErrors: row.graph ? validatePlaybookGraph(row.graph) : null,
      steps: row.graph?.nodes.length, connections: row.graph?.edges.length }));
  }
  const selectedRow = rows.find(row => row.id === playbookId);
  const graph = selectedRow?.graph;
  if (!selectedRow || !graph || validatePlaybookGraph(graph).length) throw new Error('A valid owned published playbook is required.');
  const node = graph.nodes.find(item => item.type === 'collect' && item.data && Array.isArray(item.data.fieldKeys)
    && item.data.fieldKeys.includes('stay.children') && item.data.fieldKeys.includes('stay.rooms'));
  if (!node) throw new Error('No supported occupancy step exists.');
  const conversationId = -(1_500_000_000 + crypto.randomInt(0, 500_000_000));
  const state = initializeJourneyState(graph);
  const date = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  for (const [key, value] of Object.entries({ 'journey.type': 'leisure', 'stay.checkIn': date(3), 'stay.checkOut': date(4), 'stay.adults': 2 })) {
    if (state.fields[key]) state.fields[key] = { value, status: 'collected', source: 'customer' };
  }
  state.agentType = selectedRow.agent_type;
  await supportPreviewStore.save(userId, conversationId, { graph, run: {
    id: -1, businessProfileId: null, userId, conversationId, playbookId, playbookVersion: selectedRow.active_version,
    runSequence: 1, variant: null, currentNodeId: node.id, status: 'active', state,
    complianceScore: null, completedAt: null, createdAt: new Date(), updatedAt: new Date(),
  } });
  const history = [{ role: 'assistant', content: 'How many children will be staying? Please reply 0 if none.' }];
  for (const text of ['0', '1', 'No preference']) {
    const output = await channelGateway.process({ userId, conversationId, channel: 'whatsapp',
      senderIdentifier: 'simulator', inboundText: text, rawMessageId: `simulator:${crypto.randomUUID()}`,
      metadata: { executionMode: 'preview', dryRun: true, conversationKind: 'owner_simulator', conversationHistory: history },
    });
    const ctx = output.context;
    console.log('OCCUPANCY_PREVIEW=' + JSON.stringify(sanitizeStructuredForModel({
      input: text, outcome: output.method, countClassification: ctx?.metadata?.activePlaybookCount,
      node: ctx?.metadata?.playbookDirective?.nodeId, reply: ctx?.agentResult?.replyText,
      fields: ctx?.metadata?.playbookDirective?.journey?.fields,
      sideEffectsSuppressed: ctx?.message.metadata?.dryRun === true,
    }).value));
    if (['human_handoff', 'blocked', 'error'].includes(output.method)) throw new Error('Preview did not complete safely.');
    history.push({ role: 'user', content: text }, { role: 'assistant', content: ctx?.agentResult?.replyText || '' });
  }
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Occupancy preview failed.');
  process.exit(1);
}
