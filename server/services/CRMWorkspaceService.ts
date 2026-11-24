import { sql, type SQL } from 'drizzle-orm';
import { db } from '../models/db.js';
import { crmService, crmVisibleContactsCte } from './CRMService.js';
import { CrmConfigurationError, getCrmConfiguration } from './CRMConfigurationService.js';
import { getCrmAssignees } from './CRMAssigneeService.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';
import { serializeUtcTimestamp } from '../utils/supportTimestamp.js';
import { crmCsvCell, crmDateBounds, crmHistoryDateBounds, crmPagination, crmReportPlatforms,
  type CrmContactFilters, type CrmHistoryQuery, type CrmWorkQuery } from '../utils/crmWorkspaceValidation.js';

const escapedSearch = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
const rows = (result: any): any[] => (result.rows || []).map((row: any) => Object.fromEntries(Object.entries(row).map(([key,value]) =>
  [key,/(?:At|Date|Deadline)$/.test(key) && (value instanceof Date || typeof value === 'string') ? serializeUtcTimestamp(value) : value])));
const count = (result: any) => Number(rows(result)[0]?.count || 0);
const openTickets = sql`ticket.status NOT IN ('resolved','closed','cancelled') AND ticket.deleted_at IS NULL`;
const actorId = (metadata: SQL, fallback: SQL) => sql`CASE WHEN (${metadata}->>'actorUserId') ~ '^[0-9]{1,9}$'
  THEN (${metadata}->>'actorUserId')::integer ELSE ${fallback} END`;

/** Keep private prompt, vault, send-intent and provider error details out of CRM history. */
const messageColumns = sql`message.id,message.conversation_id AS "conversationId",message.direction,message.subject,
  COALESCE(message.redacted_content,message.content) AS content,
  CASE WHEN message.redacted_content IS NOT NULL AND message.redacted_content IS DISTINCT FROM message.content
    THEN NULL ELSE message.html_content END AS "htmlContent",
  message.attachments,message.status,message.sent_at AS "sentAt",message.delivered_at AS "deliveredAt",
  message.read_at AS "readAt",message.created_at AS "createdAt",message.is_ai_generated AS "isAiGenerated",
  message.message_kind AS "messageKind",message.follow_up_step AS "followUpStep",
  message.manual_review_required AS "manualReviewRequired",
  CASE WHEN message.status IN ('failed','bounced') THEN 'Delivery failed. Review the conversation before trying again.'
    WHEN message.status='manual_review' OR message.manual_review_required THEN 'Delivery outcome needs manual review. Do not resend until it is confirmed.'
    ELSE NULL END AS "deliveryError"`;

export class CRMWorkspaceService {
  private async contact(userId: number, reference: number) {
    const scope = requireBusinessScope();
    if (scope.userId !== userId) throw new CrmConfigurationError('Business profile not found.', 404);
    const contact = await crmService.getContactById(userId, reference);
    if (!contact) throw new CrmConfigurationError('Contact not found.', 404);
    const record = contact as any;
    const contactId = Number(record.id) > 0 ? Number(record.id) : null;
    const leadId = Number(record.leadId ?? record.lead_id ?? (record.id < 0 ? -record.id : 0)) || null;
    // An explicit association wins over a historical lead ID.
    const identity = sql`((${contactId}::integer IS NOT NULL AND conversation.crm_contact_id=${contactId})
      OR (conversation.crm_contact_id IS NULL AND ${leadId}::integer IS NOT NULL AND conversation.lead_id=${leadId}))`;
    return { record, contactId, leadId, scope, identity };
  }

  async activities(userId: number, reference: number, query: CrmHistoryQuery) {
    const { contactId, scope } = await this.contact(userId, reference);
    if (!contactId) return { data: [], pagination: crmPagination(query.page, query.limit, 0) };
    const bounds = crmHistoryDateBounds(query);
    const conditions: SQL[] = [sql`activity.user_id=${userId}`, sql`activity.business_profile_id=${scope.businessProfileId}`,
      sql`activity.contact_id=${contactId}`];
    if (query.type) conditions.push(sql`activity.type=${query.type}`);
    if (query.search) conditions.push(sql`(activity.subject ILIKE ${escapedSearch(query.search)} OR activity.body ILIKE ${escapedSearch(query.search)})`);
    if (bounds.from) conditions.push(sql`activity.created_at >= ${bounds.from}`);
    if (bounds.to) conditions.push(sql`activity.created_at < ${bounds.to}`);
    const where = sql.join(conditions, sql` AND `);
    const [data, total] = await Promise.all([
      db.execute(sql`SELECT activity.id,activity.type,activity.subject,activity.body,activity.metadata,
        activity.created_at AS "createdAt",activity.due_at AS "dueAt",activity.completed_at AS "completedAt",
        activity.priority,activity.updated_at AS "updatedAt"
        FROM crm_activities activity WHERE ${where} ORDER BY activity.created_at DESC,activity.id DESC
        LIMIT ${query.limit} OFFSET ${(query.page-1)*query.limit}`),
      db.execute(sql`SELECT COUNT(*)::int AS count FROM crm_activities activity WHERE ${where}`),
    ]);
    return { data: rows(data), pagination: crmPagination(query.page, query.limit, count(total)) };
  }

  async conversations(userId: number, reference: number, query: CrmHistoryQuery) {
    const { identity, leadId, scope } = await this.contact(userId, reference);
    const bounds = crmHistoryDateBounds(query);
    const conditions: SQL[] = [sql`conversation.user_id=${userId}`, sql`conversation.business_profile_id=${scope.businessProfileId}`, identity];
    if (query.channel) conditions.push(sql`conversation.channel=${query.channel}`);
    if (query.status) conditions.push(sql`conversation.status=${query.status}`);
    if (query.unread !== undefined) conditions.push(query.unread ? sql`conversation.unread_count>0` : sql`COALESCE(conversation.unread_count,0)=0`);
    if (query.search) conditions.push(sql`(conversation.subject ILIKE ${escapedSearch(query.search)}
      OR conversation.last_message_preview ILIKE ${escapedSearch(query.search)} OR EXISTS (SELECT 1 FROM outreach_messages searchable
        WHERE searchable.conversation_id=conversation.id AND searchable.business_profile_id=${scope.businessProfileId}
          AND COALESCE(searchable.inbox_search_text,searchable.redacted_content,searchable.content) ILIKE ${escapedSearch(query.search)}))`);
    if (bounds.from) conditions.push(sql`COALESCE(conversation.last_message_at,conversation.created_at)>=${bounds.from}`);
    if (bounds.to) conditions.push(sql`COALESCE(conversation.last_message_at,conversation.created_at)<${bounds.to}`);
    const where = sql.join(conditions, sql` AND `);
    const sentConditions: SQL[] = [sql`sent.user_id=${userId}`, sql`sent.business_profile_id=${scope.businessProfileId}`,
      sql`((sent.outreach_message_id IS NULL AND ${leadId}::integer IS NOT NULL AND sent.lead_id=${leadId}) OR EXISTS (
        SELECT 1 FROM outreach_messages linked JOIN outreach_conversations conversation ON conversation.id=linked.conversation_id
        WHERE linked.id=sent.outreach_message_id AND conversation.user_id=${userId}
          AND conversation.business_profile_id=${scope.businessProfileId} AND ${identity}))`];
    if (query.channel) sentConditions.push(sql`sent.channel=${query.channel}`);
    if (query.status) sentConditions.push(sql`sent.status=${query.status}`);
    if (query.search) sentConditions.push(sql`(sent.subject ILIKE ${escapedSearch(query.search)}
      OR COALESCE(sent.inbox_search_text,sent.message) ILIKE ${escapedSearch(query.search)})`);
    if (bounds.from) sentConditions.push(sql`sent.sent_at>=${bounds.from}`);
    if (bounds.to) sentConditions.push(sql`sent.sent_at<${bounds.to}`);
    const sentWhere = sql.join(sentConditions, sql` AND `);
    const [threadsResult, threadCount, sentResult, sentCount] = await Promise.all([
      query.view === 'sent' ? Promise.resolve({ rows: [] }) : db.execute(sql`SELECT conversation.id,conversation.channel,
        conversation.integration_provider AS "integrationProvider",conversation.provider_account_id AS "providerAccountId",
        conversation.lead_name AS "leadName",conversation.lead_email AS "leadEmail",conversation.status,conversation.subject,
        conversation.last_message_at AS "lastMessageAt",conversation.last_message_by AS "lastMessageBy",
        conversation.last_message_preview AS "lastMessagePreview",conversation.total_messages AS "totalMessages",
        conversation.unread_count AS "unreadCount",conversation.created_at AS "createdAt"
        FROM outreach_conversations conversation WHERE ${where}
        ORDER BY conversation.last_message_at DESC NULLS LAST,conversation.id DESC LIMIT ${query.limit} OFFSET ${(query.page-1)*query.limit}`),
      db.execute(sql`SELECT COUNT(*)::int AS count,COALESCE(SUM(conversation.unread_count),0)::int AS unread
        FROM outreach_conversations conversation WHERE ${where}`),
      query.view === 'conversations' ? Promise.resolve({ rows: [] }) : db.execute(sql`SELECT sent.id,sent.lead_id AS "leadId",sent.channel,
        sent.subject,COALESCE(linked.redacted_content,sent.message) AS message,sent.status,sent.sent_at AS "sentAt",
        sent.created_at AS "createdAt",sent.delivery_status AS "deliveryStatus",sent.delivered_at AS "deliveredAt",
        sent.opened_at AS "openedAt",sent.reply_received_at AS "replyReceivedAt",sent.reply_content AS "replyContent",
        sent.is_reply AS "isReply",sent.follow_up_step AS "followUpStep",sent.sentiment,sent.outreach_message_id AS "outreachMessageId"
        FROM sent_messages sent LEFT JOIN outreach_messages linked ON linked.id=sent.outreach_message_id
          AND linked.business_profile_id=${scope.businessProfileId}
        WHERE ${sentWhere} ORDER BY sent.sent_at DESC,sent.id DESC LIMIT ${query.sentLimit} OFFSET ${(query.sentPage-1)*query.sentLimit}`),
      db.execute(sql`SELECT COUNT(*)::int AS count FROM sent_messages sent WHERE ${sentWhere}`),
    ]);
    const threads = rows(threadsResult);
    const ids = threads.map(thread => Number(thread.id));
    const messages = ids.length ? rows(await db.execute(sql`SELECT ${messageColumns} FROM (
      SELECT source.*,ROW_NUMBER() OVER (PARTITION BY source.conversation_id ORDER BY source.created_at DESC,source.id DESC) AS position
      FROM outreach_messages source WHERE source.business_profile_id=${scope.businessProfileId}
        AND source.conversation_id=ANY(${sql.param(ids)}::integer[])) message WHERE position <= ${query.messageLimit}
      ORDER BY message.created_at ASC,message.id ASC`)) : [];
    return { conversations: threads.map(thread => ({ ...thread,
      messages: messages.filter(message => message.conversationId === thread.id),
      messageTotal: Number(thread.totalMessages || 0), messagesHasMore: Number(thread.totalMessages || 0) > query.messageLimit,
    })), sentMessages: rows(sentResult), pagination: crmPagination(query.page,query.limit,count(threadCount)),
    sentPagination: crmPagination(query.sentPage,query.sentLimit,count(sentCount)), totalUnread: Number(rows(threadCount)[0]?.unread || 0) };
  }

  async conversationMessages(userId: number, reference: number, conversationId: number, query: CrmHistoryQuery) {
    const { identity, scope } = await this.contact(userId, reference);
    const found = await db.execute(sql`SELECT conversation.id FROM outreach_conversations conversation
      WHERE conversation.id=${conversationId} AND conversation.user_id=${userId}
        AND conversation.business_profile_id=${scope.businessProfileId} AND ${identity}`);
    if (!rows(found).length) throw new CrmConfigurationError('Conversation not found for this contact.',404);
    if (query.beforeMessageId) {
      const cursor = await db.execute(sql`SELECT id FROM outreach_messages WHERE id=${query.beforeMessageId}
        AND conversation_id=${conversationId} AND business_profile_id=${scope.businessProfileId}`);
      if (!rows(cursor).length) throw new CrmConfigurationError('The message cursor no longer belongs to this conversation. Refresh its history.',400);
    }
    const cursor = query.beforeMessageId ? sql`(message.created_at,message.id) < (
      SELECT edge.created_at,edge.id FROM outreach_messages edge WHERE edge.id=${query.beforeMessageId}
        AND edge.conversation_id=${conversationId} AND edge.business_profile_id=${scope.businessProfileId})` : sql`TRUE`;
    const [data,total] = await Promise.all([
      db.execute(sql`SELECT ${messageColumns} FROM outreach_messages message WHERE message.conversation_id=${conversationId}
        AND message.business_profile_id=${scope.businessProfileId} AND ${cursor} ORDER BY message.created_at DESC,message.id DESC
        LIMIT ${query.limit+1} OFFSET ${query.beforeMessageId ? 0 : (query.page-1)*query.limit}`),
      db.execute(sql`SELECT COUNT(*)::int AS count FROM outreach_messages message WHERE message.conversation_id=${conversationId}
        AND message.business_profile_id=${scope.businessProfileId}`),
    ]);
    const messages = rows(data).slice(0,query.limit).reverse();
    const hasMore = rows(data).length>query.limit;
    const nextBeforeMessageId = hasMore && messages.length ? Number(messages[0].id) : null;
    return { data: messages, pagination: { ...crmPagination(query.page,query.limit,count(total)),hasMore,nextBeforeMessageId },nextBeforeMessageId };
  }

  async tickets(userId: number, reference: number, query: CrmHistoryQuery) {
    const { contactId, leadId, scope } = await this.contact(userId, reference);
    const bounds = crmHistoryDateBounds(query);
    const conditions = [sql`ticket.user_id=${userId}`,sql`ticket.business_profile_id=${scope.businessProfileId}`,sql`ticket.deleted_at IS NULL`,
      sql`((${contactId}::integer IS NOT NULL AND ticket.contact_id=${contactId})
        OR (ticket.contact_id IS NULL AND ${leadId}::integer IS NOT NULL AND ticket.lead_id=${leadId}))`];
    if (query.status) conditions.push(sql`ticket.status=${query.status}`);
    if (query.search) conditions.push(sql`(ticket.subject ILIKE ${escapedSearch(query.search)} OR ticket.ticket_number ILIKE ${escapedSearch(query.search)})`);
    if (bounds.from) conditions.push(sql`ticket.created_at>=${bounds.from}`);
    if (bounds.to) conditions.push(sql`ticket.created_at<${bounds.to}`);
    const where = sql.join(conditions,sql` AND `);
    const [data,total] = await Promise.all([
      db.execute(sql`SELECT ticket.id,ticket.ticket_number AS "ticketNumber",ticket.subject,ticket.description,ticket.status,
        ticket.priority,ticket.category,ticket.sla_deadline AS "slaDeadline",ticket.resolved_at AS "resolvedAt",
        ticket.response_time AS "responseTime",ticket.total_messages AS "totalMessages",ticket.unread_count AS "unreadCount",
        ticket.tags,ticket.created_at AS "createdAt",ticket.updated_at AS "updatedAt",ticket.version,
        ticket.assigned_to AS "assignedTo",ticket.assigned_member_id AS "assignedMemberId",
        CASE WHEN ticket.assigned_member_id IS NOT NULL THEN jsonb_build_object('id',member.id,'name',member.name,'email',member.email,'kind','member')
          WHEN owner.id IS NOT NULL THEN jsonb_build_object('id',owner.id,'name',owner.name,'email',owner.email,'kind','user') ELSE NULL END AS assignee,
        CASE WHEN ticket.sla_deadline IS NULL THEN 'no_sla'
          WHEN ticket.status IN ('resolved','closed') THEN CASE WHEN COALESCE(ticket.resolved_at,ticket.closed_at)<=ticket.sla_deadline THEN 'healthy' ELSE 'breached' END
          WHEN ticket.sla_deadline<NOW() THEN 'breached' WHEN ticket.sla_deadline<NOW()+interval '4 hours' THEN 'at_risk' ELSE 'healthy' END AS "slaStatus",
        ROUND(EXTRACT(epoch FROM (ticket.sla_deadline-NOW()))/3600,1)::float AS "hoursRemaining",
        COALESCE(history.messages,'[]'::jsonb) AS messages,history.messages->-1 AS "latestReply"
        FROM support_tickets ticket LEFT JOIN team_members member ON member.id=ticket.assigned_member_id
          AND member.business_profile_id=${scope.businessProfileId}
        LEFT JOIN users owner ON owner.id=ticket.assigned_to
        LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',recent.id,'content',recent.content,'direction',recent.direction,
          'isInternal',recent.is_internal,'attachments',recent.attachments,'createdAt',recent.created_at) ORDER BY recent.created_at,recent.id) AS messages
          FROM (SELECT message.* FROM support_ticket_messages message WHERE message.ticket_id=ticket.id
            AND message.business_profile_id=${scope.businessProfileId} ORDER BY message.created_at DESC,message.id DESC LIMIT ${query.messageLimit}) recent) history ON TRUE
        WHERE ${where} ORDER BY ticket.created_at DESC,ticket.id DESC LIMIT ${query.limit} OFFSET ${(query.page-1)*query.limit}`),
      db.execute(sql`SELECT COUNT(*)::int AS count FROM support_tickets ticket WHERE ${where}`),
    ]);
    return { tickets: rows(data).map(ticket => ({ ...ticket,
      messages: (ticket.messages || []).map((message: any) => ({ ...message,createdAt: serializeUtcTimestamp(message.createdAt) })),
      latestReply: ticket.latestReply ? { ...ticket.latestReply,createdAt: serializeUtcTimestamp(ticket.latestReply.createdAt) } : null,
    })), pagination: crmPagination(query.page,query.limit,count(total)) };
  }

  async summary(userId: number, reference: number) {
    const { record, contactId, leadId, scope, identity } = await this.contact(userId,reference);
    const ticketIdentity = sql`((${contactId}::integer IS NOT NULL AND ticket.contact_id=${contactId})
      OR (ticket.contact_id IS NULL AND ${leadId}::integer IS NOT NULL AND ticket.lead_id=${leadId}))`;
    const [totals,reminders,tickets,unanswered,assignees] = await Promise.all([
      db.execute(sql`SELECT
        (SELECT COUNT(*)::int FROM outreach_conversations conversation WHERE conversation.user_id=${userId} AND conversation.business_profile_id=${scope.businessProfileId} AND ${identity}) AS conversations,
        (SELECT COUNT(*)::int FROM outreach_conversations conversation WHERE conversation.user_id=${userId} AND conversation.business_profile_id=${scope.businessProfileId} AND ${identity} AND conversation.unread_count>0) AS "unreadConversations",
        (SELECT COALESCE(SUM(conversation.unread_count),0)::int FROM outreach_conversations conversation WHERE conversation.user_id=${userId} AND conversation.business_profile_id=${scope.businessProfileId} AND ${identity}) AS "unreadMessages",
        (SELECT COUNT(*)::int FROM sent_messages sent WHERE sent.user_id=${userId} AND sent.business_profile_id=${scope.businessProfileId}
          AND ((sent.outreach_message_id IS NULL AND sent.lead_id=${leadId}) OR EXISTS (SELECT 1 FROM outreach_messages message JOIN outreach_conversations conversation ON conversation.id=message.conversation_id
            WHERE message.id=sent.outreach_message_id AND conversation.user_id=${userId} AND conversation.business_profile_id=${scope.businessProfileId} AND ${identity}))) AS "sentMessages",
        (SELECT COUNT(*)::int FROM crm_activities activity WHERE activity.user_id=${userId} AND activity.business_profile_id=${scope.businessProfileId} AND activity.contact_id=${contactId}) AS activities,
        (SELECT COUNT(*)::int FROM support_tickets ticket WHERE ticket.user_id=${userId} AND ticket.business_profile_id=${scope.businessProfileId} AND ticket.deleted_at IS NULL AND ${ticketIdentity}) AS tickets,
        (SELECT COUNT(*)::int FROM support_tickets ticket WHERE ticket.user_id=${userId} AND ticket.business_profile_id=${scope.businessProfileId} AND ${openTickets} AND ${ticketIdentity}) AS "openTickets",
        (SELECT MAX(activity.created_at) FROM crm_activities activity WHERE activity.user_id=${userId} AND activity.business_profile_id=${scope.businessProfileId} AND activity.contact_id=${contactId} AND activity.type='pipeline_change') AS "stageEnteredAt"`),
      db.execute(sql`SELECT reminder.id,reminder.title,reminder.description,reminder.status,
        COALESCE(reminder.snoozed_until,reminder.reminder_due_at) AS "dueDate",reminder.metadata->>'assignedTo' AS "assignedTo",
        reminder.reminder_type AS "reminderType",reminder.metadata->>'priority' AS priority
        FROM crm_activity_reminders reminder WHERE reminder.user_id=${userId} AND reminder.business_profile_id=${scope.businessProfileId}
          AND reminder.contact_id=${contactId} AND reminder.status NOT IN ('completed','cancelled')
        ORDER BY COALESCE(reminder.snoozed_until,reminder.reminder_due_at),reminder.id LIMIT 5`),
      db.execute(sql`SELECT ticket.id,ticket.ticket_number AS "ticketNumber",ticket.subject,ticket.sla_deadline AS "slaDeadline",ticket.priority,ticket.assigned_to AS "assignedTo"
        FROM support_tickets ticket WHERE ticket.user_id=${userId} AND ticket.business_profile_id=${scope.businessProfileId}
          AND ${openTickets} AND ${ticketIdentity} AND ticket.sla_deadline<NOW()+interval '24 hours'
        ORDER BY ticket.sla_deadline,ticket.id LIMIT 5`),
      db.execute(sql`SELECT conversation.id,conversation.channel,conversation.subject,conversation.last_message_at AS "lastMessageAt",conversation.unread_count AS "unreadCount"
        FROM outreach_conversations conversation WHERE conversation.user_id=${userId} AND conversation.business_profile_id=${scope.businessProfileId}
          AND ${identity} AND conversation.status NOT IN ('closed','unsubscribed') AND (conversation.last_message_by='lead' OR conversation.unread_count>0)
        ORDER BY conversation.last_message_at DESC,conversation.id DESC LIMIT 5`),
      getCrmAssignees(userId),
    ]);
    const totalsRow = rows(totals)[0] || {};
    return { counts: { conversations: totalsRow.conversations || 0,sentMessages: totalsRow.sentMessages || 0,
      activities: totalsRow.activities || 0,tickets: totalsRow.tickets || 0,openTickets: totalsRow.openTickets || 0,
      unreadConversations: totalsRow.unreadConversations || 0,unreadMessages: totalsRow.unreadMessages || 0 }, owner: assignees.find(owner => owner.id === record.assignedTo) || null,
    nextReminder: rows(reminders)[0] || null,upcomingReminders: rows(reminders),ticketsDue: rows(tickets),unansweredConversations: rows(unanswered),
    stageEnteredAt: totalsRow.stageEnteredAt || record.createdAt || null };
  }

  async timeline(userId: number, reference: number, query: CrmHistoryQuery) {
    const { contactId,leadId,scope,identity } = await this.contact(userId,reference);
    const bounds = crmHistoryDateBounds(query);
    const cte = sql`WITH entries AS (
      SELECT 'activity:'||activity.id AS id,'activity' AS kind,activity.type,activity.subject,activity.body,activity.created_at,
        ${actorId(sql`activity.metadata`,sql`NULL::integer`)} AS actor_user_id,
        jsonb_build_object('url',${`/dashboard/crm/contacts/${reference}?tab=activity`}::text,'label','View activity') AS related,activity.metadata
      FROM crm_activities activity WHERE activity.user_id=${userId} AND activity.business_profile_id=${scope.businessProfileId}
        AND activity.contact_id=${contactId} AND activity.outreach_message_id IS NULL
      UNION ALL SELECT 'message:'||message.id,'conversation',message.direction||'_message',COALESCE(message.subject,conversation.channel||' message'),
        COALESCE(message.redacted_content,message.content),message.created_at,
        CASE WHEN message.direction='outbound' THEN ${actorId(sql`message.metadata`,sql`message.user_id`)} ELSE NULL END,
        jsonb_build_object('url',${`/dashboard/crm/contacts/${reference}?tab=conversations`}::text,'label','Open conversation'),
        jsonb_build_object('conversationId',conversation.id,'channel',conversation.channel,'direction',message.direction,'status',message.status,'isAiGenerated',message.is_ai_generated)
      FROM outreach_messages message JOIN outreach_conversations conversation ON conversation.id=message.conversation_id
      WHERE conversation.user_id=${userId} AND conversation.business_profile_id=${scope.businessProfileId}
        AND message.business_profile_id=${scope.businessProfileId} AND ${identity}
      UNION ALL SELECT 'ticket:'||ticket.id,'ticket','ticket_created',ticket.subject,ticket.description,ticket.created_at,NULL::integer,
        jsonb_build_object('url',${`/dashboard/crm/contacts/${reference}?tab=tickets`}::text,'label','Open ticket'),
        jsonb_build_object('ticketId',ticket.id,'ticketNumber',ticket.ticket_number,'status',ticket.status,'priority',ticket.priority)
      FROM support_tickets ticket WHERE ticket.user_id=${userId} AND ticket.business_profile_id=${scope.businessProfileId} AND ticket.deleted_at IS NULL
        AND (ticket.contact_id=${contactId} OR (ticket.contact_id IS NULL AND ticket.lead_id=${leadId}))
      UNION ALL SELECT 'ticket-message:'||message.id,'ticket',CASE WHEN message.is_internal THEN 'internal_note' ELSE 'ticket_reply' END,
        ticket.subject,message.content,message.created_at,message.actor_user_id,
        jsonb_build_object('url',${`/dashboard/crm/contacts/${reference}?tab=tickets`}::text,'label','Open ticket'),
        jsonb_build_object('ticketId',ticket.id,'ticketNumber',ticket.ticket_number,'direction',message.direction,'isInternal',message.is_internal)
      FROM support_ticket_messages message JOIN support_tickets ticket ON ticket.id=message.ticket_id
      WHERE ticket.user_id=${userId} AND ticket.business_profile_id=${scope.businessProfileId} AND message.business_profile_id=${scope.businessProfileId}
        AND ticket.deleted_at IS NULL AND (ticket.contact_id=${contactId} OR (ticket.contact_id IS NULL AND ticket.lead_id=${leadId}))
      UNION ALL SELECT 'reminder:'||reminder.id,'reminder','reminder_'||reminder.status,reminder.title,reminder.description,
        CASE WHEN reminder.status IN ('completed','sent') THEN reminder.updated_at ELSE reminder.created_at END,
        ${actorId(sql`reminder.metadata`,sql`NULL::integer`)},
        jsonb_build_object('url','/dashboard/crm/reminders','label','Open reminder'),
        jsonb_build_object('reminderId',reminder.id,'dueDate',COALESCE(reminder.snoozed_until,reminder.reminder_due_at),'status',reminder.status,'assignedTo',reminder.metadata->'assignedTo')
      FROM crm_activity_reminders reminder WHERE reminder.user_id=${userId} AND reminder.business_profile_id=${scope.businessProfileId} AND reminder.contact_id=${contactId}
      UNION ALL SELECT 'automation:'||run.id,'automation',run.event_type,run.automation_name||' · '||run.status,
        CASE WHEN run.status='failed' THEN 'The automation failed. Open the run to review its steps.'
          WHEN run.status='manual_review' THEN 'This run needs review before any further delivery.' ELSE 'Triggered by '||REPLACE(run.event_type,'_',' ') END,
        run.created_at,NULL::integer,jsonb_build_object('url','/dashboard/crm/automations/'||run.automation_id||'/runs?run='||run.id,'label','Open automation run'),
        jsonb_build_object('runId',run.id,'automationId',run.automation_id,'eventType',run.event_type,'status',run.status,'revision',run.revision)
      FROM crm_automation_runs run WHERE run.user_id=${userId} AND run.business_profile_id=${scope.businessProfileId} AND run.contact_id=${contactId}
    )`;
    const conditions: SQL[] = [sql`TRUE`];
    if (query.type) conditions.push(['activity','conversation','ticket','reminder','automation'].includes(query.type)
      ? sql`entry.kind=${query.type}` : sql`entry.type=${query.type}`);
    if (query.search) conditions.push(sql`(entry.subject ILIKE ${escapedSearch(query.search)} OR entry.body ILIKE ${escapedSearch(query.search)})`);
    if (bounds.from) conditions.push(sql`entry.created_at>=${bounds.from}`);
    if (bounds.to) conditions.push(sql`entry.created_at<${bounds.to}`);
    const where = sql.join(conditions,sql` AND `);
    const [data,total] = await Promise.all([
      db.execute(sql`${cte} SELECT entry.id,entry.kind,entry.type,entry.subject,entry.body,entry.created_at AS "createdAt",entry.related,entry.metadata,
        CASE WHEN actor.id IS NOT NULL THEN jsonb_build_object('id',actor.id,'name',actor.name) ELSE NULL END AS actor
        FROM entries entry LEFT JOIN users actor ON actor.id=entry.actor_user_id AND (actor.id=${userId} OR EXISTS (
          SELECT 1 FROM business_profile_memberships member WHERE member.user_id=actor.id AND member.business_profile_id=${scope.businessProfileId}))
        WHERE ${where} ORDER BY entry.created_at DESC,entry.id DESC LIMIT ${query.limit} OFFSET ${(query.page-1)*query.limit}`),
      db.execute(sql`${cte} SELECT COUNT(*)::int AS count FROM entries entry WHERE ${where}`),
    ]);
    return { data: rows(data),pagination: crmPagination(query.page,query.limit,count(total)) };
  }

  async work(userId: number, query: CrmWorkQuery) {
    const scope = requireBusinessScope();
    const configuration = await getCrmConfiguration(userId);
    const stages = configuration.stages.filter(stage => stage.type !== 'won' && stage.type !== 'lost').map(stage => stage.key);
    const stuckBefore = new Date(Date.now()-configuration.preferences.stuckThreshold*86_400_000);
    // Reminders use Workspace owner for legacy/missing or explicit-null
    // assignments; a contact's owner does not reassign its follow-up.
    const assignee = sql`CASE WHEN (reminder.metadata->>'assignedTo') ~ '^[0-9]{1,9}$' THEN (reminder.metadata->>'assignedTo')::integer ELSE ${userId}::integer END`;
    const name = sql`COALESCE(NULLIF(TRIM(CONCAT(base.first_name,' ',base.last_name)),''),base.email,'Contact')`;
    // Count and list share eligibility. Sent/failed describe notification
    // delivery; the reminder remains actionable until completed or cancelled.
    const cte = sql`${crmVisibleContactsCte(userId,configuration)},items AS (
      SELECT 'reminder:'||reminder.id AS id,reminder.id AS entity_id,'reminder' AS type,COALESCE(reminder.title,'Follow up') AS title,
        reminder.description,base.id AS contact_id,${name} AS contact_name,${assignee} AS owner_user_id,
        COALESCE(reminder.snoozed_until,reminder.reminder_due_at) AS due_at,COALESCE(reminder.metadata->>'priority','medium') AS priority,
        reminder.status,CASE WHEN base.id IS NOT NULL THEN '/dashboard/crm/contacts/'||base.id ELSE '/dashboard/crm/reminders' END AS url
      FROM crm_activity_reminders reminder LEFT JOIN base ON base.crm_contact_id=reminder.contact_id
      WHERE reminder.user_id=${userId} AND reminder.business_profile_id=${scope.businessProfileId} AND reminder.status NOT IN ('completed','cancelled')
        AND COALESCE(reminder.snoozed_until,reminder.reminder_due_at)<NOW()+interval '7 days'
        AND (reminder.contact_id IS NULL OR base.id IS NOT NULL)
      UNION ALL SELECT 'conversation:'||conversation.id,conversation.id,'conversation',COALESCE(conversation.subject,'Unanswered '||conversation.channel||' conversation'),
        conversation.last_message_preview,base.id,${name},base.assigned_to,conversation.last_message_at,'high',conversation.status,
        '/dashboard/crm/contacts/'||base.id||'?tab=conversations'
      FROM outreach_conversations conversation JOIN base ON conversation.crm_contact_id=base.crm_contact_id
        OR (conversation.crm_contact_id IS NULL AND conversation.lead_id=base.lead_id)
      WHERE conversation.user_id=${userId} AND conversation.business_profile_id=${scope.businessProfileId}
        AND conversation.status NOT IN ('closed','unsubscribed','bounced') AND (conversation.last_message_by='lead' OR conversation.unread_count>0)
      UNION ALL SELECT 'contact:'||base.id,base.id,'stuck_contact','Follow up with '||${name},
        'This contact has stayed in '||base.pipeline_status||' beyond the configured threshold.',base.id,${name},base.assigned_to,
        base.stage_entered_at+(${configuration.preferences.stuckThreshold}*interval '1 day'),base.priority,base.pipeline_status,
        '/dashboard/crm/contacts/'||base.id
      FROM base WHERE base.pipeline_status=ANY(${sql.param(stages)}::text[]) AND base.stage_entered_at<${stuckBefore}
      UNION ALL SELECT 'ticket:'||ticket.id,ticket.id,'ticket',ticket.ticket_number||' · '||ticket.subject,ticket.description,
        base.id,${name},COALESCE(ticket.assigned_to,base.assigned_to),ticket.sla_deadline,ticket.priority,ticket.status,
        CASE WHEN base.id IS NOT NULL THEN '/dashboard/crm/contacts/'||base.id||'?tab=tickets' ELSE '/dashboard/support/'||ticket.id END
      FROM support_tickets ticket LEFT JOIN base ON ticket.contact_id=base.crm_contact_id OR (ticket.contact_id IS NULL AND ticket.lead_id=base.lead_id)
      WHERE ticket.user_id=${userId} AND ticket.business_profile_id=${scope.businessProfileId} AND ${openTickets}
        AND (ticket.sla_deadline<NOW()+interval '24 hours' OR ticket.unread_count>0)
        AND (ticket.contact_id IS NULL OR base.id IS NOT NULL)
    )`;
    const conditions: SQL[] = [sql`TRUE`];
    const owner = query.assignedTo ?? query.ownerUserId;
    if (owner === 'unassigned') conditions.push(sql`item.owner_user_id IS NULL`);
    else if (owner) conditions.push(sql`item.owner_user_id=${owner}`);
    if (query.search) conditions.push(sql`(item.title ILIKE ${escapedSearch(query.search)} OR item.contact_name ILIKE ${escapedSearch(query.search)})`);
    const where = sql.join(conditions,sql` AND `);
    const typeWhere = query.type === 'all' ? sql`TRUE` : sql`item.type=${query.type}`;
    const [data,totals] = await Promise.all([
      db.execute(sql`${cte} SELECT item.id,item.entity_id AS "entityId",item.type,item.title,item.description,item.contact_id AS "contactId",
        item.contact_name AS "contactName",item.owner_user_id AS "ownerUserId",item.due_at AS "dueAt",item.priority,item.status,item.url,
        COALESCE(item.type<>'conversation' AND item.due_at<NOW(),false) AS overdue FROM items item WHERE ${where} AND ${typeWhere}
        ORDER BY COALESCE(item.type<>'conversation' AND item.due_at<NOW(),false) DESC,CASE item.priority WHEN 'urgent' THEN 5 WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
          item.due_at ASC NULLS LAST,item.id ASC LIMIT ${query.limit} OFFSET ${(query.page-1)*query.limit}`),
      db.execute(sql`${cte} SELECT item.type,COUNT(*)::int AS count FROM items item WHERE ${where} GROUP BY item.type`),
    ]);
    const counts: Record<string,number> = { reminder: 0,conversation: 0,stuck_contact: 0,ticket: 0 };
    rows(totals).forEach(row => { counts[row.type] = row.count; });
    const total = query.type === 'all' ? Object.values(counts).reduce((sum,value) => sum+value,0) : counts[query.type];
    return { items: rows(data),counts,...crmPagination(query.page,query.limit,total) };
  }

  async reports(userId: number, query: Record<string,unknown>) {
    const configuration = await getCrmConfiguration(userId);
    const platforms = crmReportPlatforms(configuration,query);
    const bounds = crmDateBounds(configuration.preferences,query);
    const reportConfiguration = { ...configuration,preferences: { ...configuration.preferences,
      platform: platforms as CrmConfigurationPlatform,dateRange: bounds.dateRange as typeof configuration.preferences.dateRange,
      ...(bounds.dateStart ? { dateStart: bounds.dateStart } : {}),...(bounds.dateEnd ? { dateEnd: bounds.dateEnd } : {}) } };
    const scope = requireBusinessScope();
    const cohortConditions: SQL[] = [sql`TRUE`];
    if (bounds.from) cohortConditions.push(sql`base.created_at>=${bounds.from}`);
    if (bounds.to) cohortConditions.push(sql`base.created_at<${bounds.to}`);
    if (!platforms.includes('all')) cohortConditions.push(sql`EXISTS (SELECT 1 FROM outreach_conversations selected
      WHERE selected.user_id=${userId} AND selected.business_profile_id=${scope.businessProfileId}
        AND selected.channel=ANY(${sql.param(platforms)}::text[]) AND (selected.crm_contact_id=base.crm_contact_id
          OR (selected.crm_contact_id IS NULL AND selected.lead_id=base.lead_id)))`);
    const cohort = sql.join(cohortConditions,sql` AND `);
    const channel = platforms.includes('all') ? sql`TRUE` : sql`conversation.channel=ANY(${sql.param(platforms)}::text[])`;
    const cte = crmVisibleContactsCte(userId,configuration);
    const [analytics,channels,durations] = await Promise.all([
      crmService.getPipelineAnalytics(userId,reportConfiguration,bounds),
      db.execute(sql`${cte} SELECT conversation.channel,COUNT(DISTINCT base.id)::int AS contacts,
        COUNT(DISTINCT conversation.id)::int AS conversations,COALESCE(SUM(conversation.total_messages),0)::int AS messages,
        COALESCE(SUM(conversation.unread_count),0)::int AS unread FROM base JOIN outreach_conversations conversation
          ON conversation.crm_contact_id=base.crm_contact_id OR (conversation.crm_contact_id IS NULL AND conversation.lead_id=base.lead_id)
        WHERE conversation.user_id=${userId} AND conversation.business_profile_id=${scope.businessProfileId} AND ${cohort} AND ${channel}
        GROUP BY conversation.channel ORDER BY contacts DESC,conversation.channel`),
      db.execute(sql`${cte},visits AS (SELECT activity.contact_id,activity.metadata->>'newStatus' AS stage_key,activity.created_at,
        LEAD(activity.created_at) OVER (PARTITION BY activity.contact_id ORDER BY activity.created_at,activity.id) AS next_at
        FROM crm_activities activity WHERE activity.user_id=${userId} AND activity.business_profile_id=${scope.businessProfileId}
          AND activity.type='pipeline_change'),completed AS (
        SELECT visit.stage_key,COUNT(*)::int AS visits,AVG(EXTRACT(epoch FROM (COALESCE(visit.next_at,NOW())-visit.created_at))/86400)::float AS average_days
        FROM visits visit JOIN base ON base.crm_contact_id=visit.contact_id WHERE ${cohort}
          AND ${bounds.from ? sql`visit.created_at>=${bounds.from}` : sql`TRUE`}
          AND ${bounds.to ? sql`visit.created_at<${bounds.to}` : sql`TRUE`} GROUP BY visit.stage_key),current_duration AS (
        SELECT base.pipeline_status AS stage_key,AVG(EXTRACT(epoch FROM (NOW()-base.stage_entered_at))/86400)::float AS current_average_days
        FROM base WHERE ${cohort} GROUP BY base.pipeline_status)
        SELECT COALESCE(completed.stage_key,current_duration.stage_key) AS "stageKey",COALESCE(completed.visits,0) AS visits,
          ROUND(completed.average_days::numeric,2)::float AS "averageDays",ROUND(current_duration.current_average_days::numeric,2)::float AS "currentAverageDays"
        FROM completed FULL JOIN current_duration ON current_duration.stage_key=completed.stage_key`),
    ]);
    return { ...analytics,channels: rows(channels),stageDurations: rows(durations).map(row => ({ ...row,
      label: configuration.stages.find(stage => stage.key === row.stageKey)?.label || row.stageKey })),
    filters: { platforms,dateRange: bounds.dateRange,from: bounds.dateStart,to: bounds.dateEnd,
      dateStart: bounds.dateStart,dateEnd: bounds.dateEnd },
    drilldown: { cohort: 'created',platforms,dateRange: bounds.dateRange,dateStart: bounds.dateStart,dateEnd: bounds.dateEnd } };
  }

  async exportContacts(userId: number, filters: Partial<CrmContactFilters>) {
    return db.transaction(async (tx: any) => {
    const first = await crmService.getContacts(userId,{ ...filters,page: 1,limit: 500,offset: 0 },tx);
    if (first.total>10_000) throw new CrmConfigurationError('This export matches more than 10,000 contacts. Narrow the filters before exporting.',422);
    const contacts: any[] = [...first.contacts];
    for (let page=2;page<=first.totalPages;page++) {
      const result = await crmService.getContacts(userId,{ ...filters,page,limit: 500,offset: (page-1)*500 },tx);
      contacts.push(...result.contacts);
    }
    const columns: Array<[string,string]> = [['ID','id'],['First name','firstName'],['Last name','lastName'],['Email','email'],['Phone','phone'],
      ['Company','company'],['Role','role'],['Stage','pipelineStatus'],['Priority','priority'],['Assigned user','assignedTo'],
      ['Tags','tags'],['Deal value','dealValue'],['Currency','currency'],['Next follow-up','nextFollowUpAt'],['Created','createdAt']];
    const csv = [columns.map(([label])=>crmCsvCell(label)).join(','),...contacts.map(contact => columns.map(([,key]) =>
      crmCsvCell(Array.isArray(contact[key]) ? contact[key].join('; ') : contact[key] instanceof Date ? contact[key].toISOString() : contact[key])).join(','))].join('\r\n');
    return { csv,filename: `crm-contacts-${new Date().toISOString().slice(0,10)}.csv`,total: first.total,exported: contacts.length,truncated: false };
    // Campaign ownership validation takes a key-share lock. The export still
    // performs no writes, but PostgreSQL disallows that lock in read-only mode.
    },{ isolationLevel: 'repeatable read' });
  }
}

type CrmConfigurationPlatform = import('../../shared/crmConfiguration.js').CrmConfiguration['preferences']['platform'];
export const crmWorkspaceService = new CRMWorkspaceService();
