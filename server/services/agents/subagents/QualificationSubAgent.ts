import { SubAgentBase, SubAgentContext, SubAgentResult } from './SubAgentBase.js';

const LARGE_GROUP_ROOMS = Number(process.env.SALES_LARGE_GROUP_ROOMS || 5);

export class QualificationSubAgent extends SubAgentBase {
  readonly metadata = {
    id: 'qualification',
    name: 'Qualification Sub-Agent',
    description: 'Scores leads based on customer intent, group size, urgency, and budget.',
    intents: [],
    priority: 35,
    tools: [
      {
        type: 'function',
        function: {
          name: 'qualify_lead',
          description: 'Record a qualification assessment of this prospect (booking intent, group size, budget, urgency). Call once you understand the customer\'s intent. High scores are prioritized for sales follow-up.',
          parameters: {
            type: 'object',
            properties: {
              intent: { type: 'string', enum: ['low', 'exploring', 'serious', 'urgent'] },
              group_size: { type: 'integer' },
              rooms_requested: { type: 'integer' },
              budget_per_night: { type: 'number' },
              urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
            required: ['intent'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'update_lead_score',
          description: 'Update the qualification score of a lead directly.',
          parameters: {
            type: 'object',
            properties: {
              score: { type: 'integer', description: 'The new qualification score (0-100).' },
            },
            required: ['score'],
          },
        },
      },
    ],
  };

  canHandle(_ctx: SubAgentContext): boolean {
    // Cross-cutting, handled manually when needed
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(name: string, args: any, ctx: SubAgentContext): Promise<SubAgentResult> {
    const { lead } = ctx;

    switch (name) {
      case 'qualify_lead': {
        const score = this.computeQualification(args);
        const highValue = score >= 70 || (Number(args.rooms_requested || args.group_size || 0) >= LARGE_GROUP_ROOMS);
        const crmPipelineStatus = score >= 70 ? 'qualified' : 'interested';
        
        const result = {
          success: true,
          confirmedSideEffect: false,
          qualification_score: score,
          high_value: highValue,
          note: highValue ? 'High-value lead — consider sales escalation.' : undefined,
        };

        return {
          toolResults: [{ name, result }],
          crmPipelineStatus,
          effectProposals: [
            ...(lead.id ? [{ type: 'lead_score' as const, payload: { leadId: lead.id, score } }] : []),
            {
              type: 'conversation_state' as const,
              payload: { salesAgentQualification: { score, ...args } },
            },
          ],
        };
      }

      case 'update_lead_score': {
        const score = Number(args.score);
        return {
          toolResults: [{
            name,
            result: { success: true, score, confirmedSideEffect: false }
          }],
          effectProposals: lead.id
            ? [{ type: 'lead_score', payload: { leadId: lead.id, score } }]
            : [],
        };
      }

      default:
        throw new Error(`Tool ${name} not implemented by QualificationSubAgent`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private computeQualification(args: any): number {
    let score = 0;
    const intent = String(args.intent || 'low');
    score += intent === 'urgent' ? 40 : intent === 'serious' ? 30 : intent === 'exploring' ? 15 : 5;
    const urgency = String(args.urgency || 'low');
    score += urgency === 'high' ? 20 : urgency === 'medium' ? 10 : 0;
    const rooms = Number(args.rooms_requested || 0);
    score += rooms >= 10 ? 25 : rooms >= 3 ? 15 : rooms >= 1 ? 8 : 0;
    const group = Number(args.group_size || 0);
    score += group >= 10 ? 10 : group >= 4 ? 6 : 0;
    if (args.budget_per_night) score += 5;
    return Math.min(100, score);
  }

}
export const qualificationSubAgent = new QualificationSubAgent();
