import { SubAgentBase, SubAgentContext, SubAgentResult } from './SubAgentBase.js';

export class EscalationSubAgent extends SubAgentBase {
  readonly metadata = {
    id: 'escalation',
    name: 'Escalation Sub-Agent',
    description: 'Handles human handoffs.',
    intents: ['speak_to_human'],
    priority: 5,
    tools: [
      {
        type: 'function',
        function: {
          name: 'escalate_to_human',
          description: 'Hand the conversation to a human. Use for: corporate bookings, complaints, refunds, legal threats, repeated dissatisfaction, or explicit requests for a person.',
          parameters: {
            type: 'object',
            properties: {
              reason: { type: 'string', description: 'The reason why the customer is being escalated.' },
              type: { type: 'string', enum: ['support', 'sales'], description: 'The department to escalate to.' },
            },
            required: ['reason', 'type'],
          },
        },
      },
    ],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(name: string, args: any, _ctx: SubAgentContext): Promise<SubAgentResult> {
    switch (name) {
      case 'escalate_to_human': {
        const type = args.type === 'sales' ? 'sales' : 'support';
        return {
          escalated: true,
          escalationReason: args.reason || 'Escalated by agent tool call',
          escalationType: type,
          crmPipelineStatus: type === 'sales' ? 'negotiation' : 'ticket_open',
          toolResults: [{
            name,
            result: { success: true, confirmedSideEffect: false, escalated: true, note: 'Human handoff requested.' }
          }]
        };
      }

      // A recorded legacy tool call may still be replayed for review. It must
      // receive a truthful outcome rather than creating an unsent enrollment.
      case 'schedule_follow_up':
        return { toolResults: [{ name, result: {
          success: false,
          confirmedSideEffect: false,
          status: 'requires_configuration',
          message: 'No follow-up was scheduled. Automatic check-ins require a published assistant follow-up sequence with approved templates for this receiving account.',
        } }] };

      default:
        throw new Error(`Tool ${name} not implemented by EscalationSubAgent`);
    }
  }
}
export const escalationSubAgent = new EscalationSubAgent();
