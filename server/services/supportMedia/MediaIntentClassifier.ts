import type { MediaIntent } from './types.js';
import { confidentSemanticIntent, type SupportSemanticIntent } from '../agents/orchestration/SupportSemanticIntent.js';

export function classifyMediaIntent(input: {
  text: string;
  intent?: string;
  semanticRequest?: SupportSemanticIntent;
  helpfulEnabled?: boolean;
  publicReply?: boolean;
  outboundFirstTouch?: boolean;
}): { intent: MediaIntent; reason: string } {
  if (!input.text.trim() || input.outboundFirstTouch) return { intent: 'none', reason: 'No customer request or unsolicited first-touch outreach.' };
  const request = confidentSemanticIntent(input.semanticRequest);
  if (!request || request.action === 'document') return { intent: 'none', reason: 'No confident AI visual intent; documents are not gallery images.' };
  if (['payment_inquiry', 'refund_request', 'ticket_status', 'booking_request', 'modify_booking', 'cancel_booking', 'complaint'].includes(input.intent || '')
    || ['booking', 'refund', 'human', 'proposal_create', 'proposal_revision'].includes(request.action)) {
    return { intent: 'none', reason: 'Sensitive or transactional requests suppress media.' };
  }
  if (request.explicit && request.media === 'explicit') return { intent: 'explicit', reason: 'The AI identified an explicit current visual request.' };
  if (['availability_inquiry', 'pricing_question', 'booking_request'].includes(input.intent || '')) {
    return { intent: 'none', reason: 'Availability, pricing, and booking requests require a textual live-tool answer.' };
  }
  if (input.helpfulEnabled && request.media === 'helpful') {
    return { intent: 'helpful', reason: 'Visuals materially help compare the requested entities.' };
  }
  return { intent: 'none', reason: 'Visuals would not materially improve this reply.' };
}
