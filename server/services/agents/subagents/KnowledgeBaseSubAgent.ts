import { SubAgentBase, SubAgentContext, SubAgentResult } from './SubAgentBase.js';
import { knowledgeGateway } from '../../knowledge/KnowledgeGateway.js';
import { db } from '../../../models/db.js';
import { sql } from 'drizzle-orm';

export class KnowledgeBaseSubAgent extends SubAgentBase {
  readonly metadata = {
    id: 'knowledge_base',
    name: 'Knowledge Base Sub-Agent',
    description: 'Answers factual questions using the semantic knowledge base and retrieves hotel property specifics.',
    intents: ['faq', 'greeting', 'smalltalk', 'clarify'],
    priority: 40,
    tools: [
      {
        type: 'function',
        function: {
          name: 'answer_from_knowledge_base',
          description: 'Answer a factual question about the hotel or services using the company knowledge base (policies, amenities, cancellation terms, FAQs). Use for any informational question.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'The customer question to look up.' } },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_hotel_info',
          description: 'Fetch general information about the hotel including check-in/out times, contact info, and amenities list.',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
    ],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(name: string, args: any, ctx: SubAgentContext): Promise<SubAgentResult> {
    const { userId } = ctx;

    switch (name) {
      case 'answer_from_knowledge_base': {
        // Tool calls are a presentation of the already-retrieved evidence. They
        // cannot bypass gateway filtering or create an unbounded second search.
        const grounded = ctx.knowledgeResult;
        const groundedSuccess = grounded?.status === 'sufficient' && grounded.evidence.length > 0;
        return {
          toolResults: [{
            name,
            result: {
              success: groundedSuccess,
              code: groundedSuccess ? 'grounded_knowledge' : `knowledge_${grounded?.status || 'insufficient'}`,
              confirmedSideEffect: false,
              knowledge: grounded ? knowledgeGateway.formatEvidence(grounded) : '',
              sources: grounded?.evidence || [],
              grounding_status: grounded?.status || 'insufficient',
            }
          }]
        };
      }

      case 'get_hotel_info': {
        try {
          const rows = await db.execute(sql`
            SELECT name, city, address, phone, email, description, amenities, check_in_time, check_out_time
            FROM hotel_properties WHERE user_id = ${userId} ORDER BY id ASC LIMIT 1
          `);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = (rows.rows as any[])[0];
          if (!r) {
            return {
              toolResults: [{
                name,
                result: { error: 'No hotel property configured for this user.' }
              }]
            };
          }
          return {
            toolResults: [{
              name,
              result: {
                success: true,
                confirmedSideEffect: false,
                name: r.name,
                city: r.city,
                address: r.address || null,
                phone: r.phone || null,
                email: r.email || null,
                description: r.description || null,
                amenities: Array.isArray(r.amenities) ? r.amenities : [],
                checkInTime: r.check_in_time ? String(r.check_in_time).slice(0, 5) : null,
                checkOutTime: r.check_out_time ? String(r.check_out_time).slice(0, 5) : null,
              }
            }]
          };
        } catch {
          return {
            toolResults: [{
              name,
              result: { error: 'Failed to retrieve hotel property info.' }
            }]
          };
        }
      }

      default:
        throw new Error(`Tool ${name} not implemented by KnowledgeBaseSubAgent`);
    }
  }
}
export const knowledgeBaseSubAgent = new KnowledgeBaseSubAgent();
