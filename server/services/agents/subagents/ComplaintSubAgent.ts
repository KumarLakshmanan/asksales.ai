import { SubAgentBase, SubAgentContext, SubAgentResult } from './SubAgentBase.js';

export class ComplaintSubAgent extends SubAgentBase {
  readonly metadata = {
    id: 'complaint',
    name: 'Complaint Sub-Agent',
    description: 'Handles customer complaints, refund requests, cancellations, and escalates dissatisfied customers.',
    intents: ['complaint', 'refund_request', 'cancel_booking'],
    priority: 20,
    tools: [
      {
        type: 'function',
        function: {
          name: 'resolve_complaint',
          description: 'Resolve a customer complaint or issue. Use this for minor complaints that can be solved by explaining policies or offering basic troubleshooting.',
          parameters: {
            type: 'object',
            properties: {
              complaint_details: { type: 'string', description: 'Description of the complaint being addressed.' },
              resolution_action: { type: 'string', description: 'The proposed solution or response.' },
            },
            required: ['complaint_details', 'resolution_action'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'escalate_to_human',
          description: 'Hand the conversation to a human. Use for: complaints, refunds, legal threats, repeated dissatisfaction, or explicit requests for a person.',
          parameters: {
            type: 'object',
            properties: {
              reason: { type: 'string', description: 'The reason why the customer is being escalated.' },
              type: { type: 'string', enum: ['support', 'sales'], description: 'The department to escalate to (use "support" for complaints/refunds).' },
            },
            required: ['reason', 'type'],
          },
        },
      },
    ],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  async execute(name: string, args: any, ctx: SubAgentContext): Promise<SubAgentResult> {
    switch (name) {
      case 'resolve_complaint': {
        // Minor complaints are logged, and support is provided. If it's serious, we should advise escalation.
        const isSerious = ['refund_request', 'cancel_booking'].includes(ctx.nlu.intent)
          || ['high', 'critical'].includes(ctx.nlu.riskLevel)
          || ctx.nlu.riskFactors.some(factor => ['legal_threat', 'fraud', 'chargeback_threat'].includes(factor));
        if (isSerious) {
          return {
            escalated: true,
            escalationReason: `Serious complaint: ${args.complaint_details}`,
            escalationType: 'support',
            crmPipelineStatus: 'ticket_open',
            toolResults: [{
              name,
              result: {
                success: false,
                code: 'human_escalation_required',
                confirmedSideEffect: false,
                resolved: false,
                note: 'Complaint is classified as serious. Automatically escalating to a human manager.'
              }
            }]
          };
        }

        return {
          toolResults: [{
            name,
            result: {
              success: true,
              confirmedSideEffect: false,
              resolved: true,
              note: 'Complaint processed. Acknowledge and resolve the concern according to knowledge base guidelines.'
            }
          }]
        };
      }

      case 'escalate_to_human': {
        const type = args.type === 'sales' ? 'sales' : 'support';
        return {
          escalated: true,
          escalationReason: args.reason || 'Customer complaint / escalation request',
          escalationType: type,
          crmPipelineStatus: type === 'sales' ? 'negotiation' : 'ticket_open',
          toolResults: [{
            name,
            result: { success: true, confirmedSideEffect: false, escalated: true, note: 'Human handoff requested.' }
          }]
        };
      }

      default:
        throw new Error(`Tool ${name} not implemented by ComplaintSubAgent`);
    }
  }
}
export const complaintSubAgent = new ComplaintSubAgent();
