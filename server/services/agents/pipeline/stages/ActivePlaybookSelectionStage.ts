import { sql } from 'drizzle-orm';
import { db } from '../../../../models/db.js';
import type {
  PlaybookGraph,
  PlaybookRunStateV2,
} from '../../../../models/supportOrchestration/schema.js';
import { matchExactPlaybookChoice } from '../../orchestration/SupportChoiceDelivery.js';
import { isBookingNameField, matchActiveOccupancyCount, missingFieldsForNode } from '../../orchestration/SupportJourneyRuntime.js';
import type { PipelineContext } from '../ChannelGateway.js';
import type { PipelineStage } from '../PipelineStage.js';
import { supportPreviewStore } from '../../orchestration/SupportPreviewStore.js';
import { currentAssistant } from '../../../assistants/AssistantContext.js';
import { parseExternalSearchCountCorrection } from '../../../booking/ExternalBookingSearchUrl.js';

/**
 * Identifies an exact response to the current immutable playbook field before
 * generic intent policies run. Fixed safety, privacy, prohibited-topic and
 * inbound guardrail stages execute before this stage and remain authoritative.
 */
export class ActivePlaybookSelectionStage implements PipelineStage {
  name = 'ActivePlaybookSelection';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.message.metadata?.publicReply || ctx.message.channel.endsWith('_comment')) return ctx;
    // A fragment such as "yes" or "4 PM" cannot select an earlier field when
    // the conversation that supplied its meaning is unavailable.
    if (ctx.metadata?.historyStatus === 'unavailable') return ctx;
    if (ctx.metadata?.skipAgentGeneration && ctx.agentResult) return ctx;
    if (ctx.metadata?.suspendPlaybookForHandoff === true) return ctx;
    const preview = ctx.message.metadata?.executionMode === 'preview'
      ? await supportPreviewStore.load(ctx.message.userId, ctx.message.conversationId) : null;
    const assistant=currentAssistant();
    const assignedPlaybookIds = assistant?.configuration.playbooks.assignments.map(a => a.playbookId) || [];
    // An assistant with no assigned playbooks cannot resume one. Avoid both
    // invalid empty SQL and accidentally selecting another assistant's run.
    if (assistant && assignedPlaybookIds.length === 0) return ctx;
    const result = ctx.message.metadata?.dryRun === true ? { rows: preview?.run.status === 'active' ? [{
      id: -1, current_node_id: preview.run.currentNodeId, state: preview.run.state, graph: preview.graph,
    }] : [] } : await db.execute(sql`
      SELECT r.id, r.current_node_id, r.state, v.graph
      FROM support_playbook_runs r
      JOIN support_playbook_versions v
        ON v.playbook_id = r.playbook_id
       AND v.version = r.playbook_version
      WHERE r.user_id = ${ctx.message.userId}
        AND r.conversation_id = ${ctx.message.conversationId}
        AND r.status = 'active'
        ${assistant ? sql`AND r.state->>'assistantId'=${assistant.provenance.assistantId}
          AND r.state->>'assistantRevision'=${String(assistant.provenance.revision)}
          AND r.playbook_id IN (${sql.join(assignedPlaybookIds.map(id => sql`${id}`), sql`, `)})` : sql``}
      ORDER BY r.id DESC
      LIMIT 1
    `);
    const row = result.rows[0] as {
      id?: number;
      current_node_id?: string;
      state?: PlaybookRunStateV2;
      graph?: PlaybookGraph;
    } | undefined;
    if (assistant && row?.state && ((row.state as any).assistantId !== assistant.provenance.assistantId
      || (row.state as any).assistantRevision !== assistant.provenance.revision)) return ctx;
    if (!row?.id) {
      const correction = parseExternalSearchCountCorrection(ctx.message.inboundText);
      if (!correction || !assistant || ctx.message.channel !== 'whatsapp'
        || assistant.provenance.surface !== 'private' || assistant.provenance.channel !== 'whatsapp'
        || ctx.metadata?.agentConfig?.agentType !== 'hotel_sales'
        || ctx.message.metadata?.executionMode !== 'customer' || ctx.message.metadata?.dryRun
        || !Number.isSafeInteger(ctx.message.messageId) || Number(ctx.message.messageId) <= 0) return ctx;
      const completed = await db.execute(sql`
        SELECT r.id FROM support_playbook_runs r
        JOIN outreach_messages inbound ON inbound.id=${ctx.message.messageId}
          AND inbound.user_id=r.user_id AND inbound.conversation_id=r.conversation_id
          AND inbound.business_profile_id=r.business_profile_id AND inbound.direction='inbound'
        WHERE r.user_id=${ctx.message.userId} AND r.conversation_id=${ctx.message.conversationId}
          AND r.status='completed' AND r.current_node_id='external-search-complete'
          AND r.state->>'deliveryStatus'='sent' AND r.state->>'agentType'='hotel_sales'
          AND r.state->>'assistantId'=${assistant.provenance.assistantId}
          AND r.state->>'assistantRevision'=${String(assistant.provenance.revision)}
          AND r.state->>'assistantBindingId'=${String(assistant.provenance.bindingId)}
          AND r.playbook_id IN (${sql.join(assignedPlaybookIds.map(id => sql`${id}`), sql`, `)})
        ORDER BY r.id DESC LIMIT 1
      `);
      if (completed.rows[0]?.id) ctx.metadata = { ...ctx.metadata,
        completedPublicSearchCount: { runId: Number(completed.rows[0].id), correction } };
      return ctx;
    }
    if (!row.graph || row.graph.schemaVersion !== 2 || !row.current_node_id) return ctx;
    const node = row.graph.nodes.find((candidate) => candidate.id === row.current_node_id);
    if (!node || node.type !== 'collect') return ctx;
    const field = missingFieldsForNode(row.graph, node, row.state || { graphVersion: 2, fields: {} })[0];
    if (!field) return ctx;
    if (assistant && field.pii && field.pii !== 'none' && !assistant.configuration.privacy.permittedCollectionFields.includes(field.key)) return ctx;
    if (isBookingNameField(row.graph, node, field)) {
      ctx.metadata = { ...ctx.metadata, bookingNameCollection: true };
    }
    const count = matchActiveOccupancyCount(field, ctx.message.inboundText);
    if (count !== undefined) {
      ctx.metadata = {
        ...ctx.metadata,
        activePlaybookCount: { runId: Number(row.id), nodeId: node.id, fieldKey: field.key, value: count },
      };
    }
    const match = matchExactPlaybookChoice(field, ctx.message.inboundText);
    if (!match) return ctx;
    ctx.metadata = {
      ...ctx.metadata,
      activePlaybookSelection: {
        runId: Number(row.id),
        nodeId: node.id,
        fieldKey: field.key,
        value: match.value,
        label: match.label,
      },
    };
    return ctx;
  }
}
