import { SubAgentBase, SubAgentContext, SubAgentResult } from './SubAgentBase.js';
import { supportService } from '../../SupportService.js';
import { salesIntelligence } from '../SalesIntelligence.js';
import { db } from '../../../models/db.js';
import { supportTicketsTable } from '../../../models/supportTickets/schema.js';
import { and, eq, isNull, or, desc } from 'drizzle-orm';

export class TicketSubAgent extends SubAgentBase {
  readonly metadata = {
    id: 'ticket',
    name: 'Ticket Sub-Agent',
    description: 'Manages support tickets, checking ticket statuses, and creating/escalating support issues.',
    intents: ['support_request', 'speak_to_human'],
    priority: 25,
    tools: [
      {
        type: 'function',
        function: {
          name: 'create_support_ticket',
          description: 'Create a formal support ticket for the customer. Call this when the customer has an issue that requires manual resolution by the support team.',
          parameters: {
            type: 'object',
            properties: {
              subject: { type: 'string', description: 'Brief subject describing the issue.' },
              description: { type: 'string', description: 'Detailed explanation of the problem.' },
              priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Urgency of the request.' },
            },
            required: ['subject'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_ticket_status',
          description: 'Look up the status of existing support tickets linked to this customer.',
          parameters: {
            type: 'object',
            properties: {
              ticket_id: { type: 'integer', description: 'Optional specific ticket ID to lookup.' },
            },
          },
        },
      },
    ],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(name: string, args: any, ctx: SubAgentContext): Promise<SubAgentResult> {
    const { userId, conversationId } = ctx;

    switch (name) {
      case 'create_support_ticket': {
        const priority = args.priority || 'medium';
        const description = args.description || salesIntelligence.buildLeadSummary({
          name: ctx.lead.name || 'Guest',
          phone: ctx.lead.phone || ctx.lead.recipientPhone || 'N/A',
          slots: ctx.slots,
          mem: ctx.memory,
          intel: ctx.intel,
          currency: 'INR',
          reason: args.subject,
          suggestedAction: 'Resolve the customer issue and update them.',
        });

        return {
          crmPipelineStatus: 'ticket_open',
          toolResults: [{
            name,
            result: {
              success: true,
              confirmedSideEffect: false,
              status: 'proposed',
              note: 'Support ticket creation is queued for the post-decision effect gate.'
            }
          }],
          effectProposals: [{
            type: 'support_ticket',
            payload: {
              leadId: ctx.lead.id ?? null,
              outreachConversationId: conversationId,
              subject: String(args.subject || 'Support request'),
              description,
              priority,
              category: 'support',
              tags: ['agent_created', ctx.channel],
            },
          }],
        };
      }

      case 'get_ticket_status': {
        const identityFilters = [
          ...(ctx.lead.id ? [eq(supportTicketsTable.leadId, ctx.lead.id)] : []),
          ...(conversationId > 0 ? [eq(supportTicketsTable.outreachConversationId, conversationId)] : []),
        ];
        if (!identityFilters.length) return { toolResults: [{ name, result: { success: false, error: 'No verified customer ticket context is available.' } }] };
        if (args.ticket_id) {
          const ticket = await supportService.getTicketById(userId, args.ticket_id);
          const authorized = ticket && ((ctx.lead.id && ticket.leadId === ctx.lead.id)
            || (conversationId > 0 && ticket.outreachConversationId === conversationId));
          return {
            toolResults: [{
              name,
              result: authorized ? {
                success: true,
                confirmedSideEffect: false,
                ticket_id: ticket.id,
                ticket_number: ticket.ticketNumber,
                subject: ticket.subject,
                status: ticket.status,
                priority: ticket.priority,
                created_at: ticket.createdAt,
              } : { success: false, error: 'No matching ticket is available in this conversation.' }
            }]
          };
        }

        const tickets: Array<typeof supportTicketsTable.$inferSelect> = await db.select().from(supportTicketsTable)
          .where(and(eq(supportTicketsTable.userId, userId), isNull(supportTicketsTable.deletedAt), or(...identityFilters)))
          .orderBy(desc(supportTicketsTable.updatedAt)).limit(20);
        
        return {
          toolResults: [{
            name,
            result: {
              success: true,
              confirmedSideEffect: false,
              count: tickets.length,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              tickets: tickets.map((t: any) => ({
                ticket_id: t.id,
                ticket_number: t.ticketNumber,
                subject: t.subject,
                status: t.status,
                priority: t.priority,
              }))
            }
          }]
        };
      }

      default:
        throw new Error(`Tool ${name} not implemented by TicketSubAgent`);
    }
  }
}
export const ticketSubAgent = new TicketSubAgent();
