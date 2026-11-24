import type { PipelineContext } from '../pipeline/ChannelGateway.js';
import { logger } from '../../../utils/logger.js';
import { selectSupportHistory } from '../orchestration/SupportConversationMemory.js';
import type { confidentSemanticIntent } from '../orchestration/SupportSemanticIntent.js';
import { getHotelPaymentConfiguration } from '../../booking/PaymentProvider.js';
import { validateExternalBookingUrlDestination } from '../../booking/ExternalBookingUrl.js';
import { buildExternalBookingSearchUrl, parseExternalSearchCountCorrection } from '../../booking/ExternalBookingSearchUrl.js';

/** Hotel-only: answer a stay booking/search request with the approved
 * external booking-page link instead of generating a reply. Moved out of the
 * shared AgentDispatchStage unchanged. Returns true when it set
 * ctx.agentResult and the dispatch stage must stop. */
export async function prepareHotelBookingSearchReply(input: {
  ctx: PipelineContext;
  userId: number;
  inboundText: string;
  channel: string;
  agentType: string | undefined;
  request: ReturnType<typeof confidentSemanticIntent>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  playbookDirective: any;
  publicSearchFollowUp: boolean;
}): Promise<boolean> {
  const { ctx, userId, inboundText, channel, agentType, request, playbookDirective, publicSearchFollowUp } = input;
  const trip = ctx.nlu?.entities || {};
  // Only a search correction may inherit public search parameters. Never
  // hydrate contact fields, reservation IDs or a committed booking from history.
  const countCorrection = publicSearchFollowUp ? parseExternalSearchCountCorrection(inboundText) : undefined;
  // A count-only sentence cannot authorize model-extracted date/room changes.
  const searchFields: Record<string, unknown> = { ...(countCorrection || trip) };
  let inheritedPublicSearch = false;
  if (publicSearchFollowUp || (request?.action === 'correction' && request.service === 'stay' && !request.topicSwitch)) {
    for (const turn of selectSupportHistory(ctx.message.metadata?.conversationHistory, 15).reverse()) {
      if (turn.role !== 'assistant') continue;
      const urlText = turn.content.match(/https:\/\/[^\s<>]+/)?.[0];
      if (!urlText) continue;
      try {
        const previous = new URL(urlText);
        const configured = await getHotelPaymentConfiguration(userId);
        const approved = new URL(configured.externalBooking.url || '');
        if (previous.origin !== approved.origin || previous.pathname !== approved.pathname
          || previous.searchParams.get('propertyId') !== approved.searchParams.get('propertyId')) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(previous.searchParams.get('checkIn') || '')
          || !/^\d{4}-\d{2}-\d{2}$/.test(previous.searchParams.get('checkOut') || '')) continue;
        for (const key of ['checkIn', 'checkOut', 'adults', 'children', 'rooms']) {
          if ((searchFields[key] == null || searchFields[key] === '') && previous.searchParams.has(key)) searchFields[key] = previous.searchParams.get(key);
        }
        inheritedPublicSearch = true;
        break;
      } catch { /* Invalid history is never search authority. */ }
    }
  }
  const datedStayEnquiry = request?.action === 'information'
    && ['booking_request','availability_inquiry','pricing_question'].includes(ctx.nlu?.intent || '')
    && /^\d{4}-\d{2}-\d{2}$/.test(String(trip.checkIn || ''))
    && /^\d{4}-\d{2}-\d{2}$/.test(String(trip.checkOut || ''));
  const validPublicCounts = [['adults',1,50],['children',0,20],['rooms',1,20]].every(([key,min,max]) => {
    const value = Number(searchFields[String(key)]);
    return Number.isSafeInteger(value) && value >= Number(min) && value <= Number(max);
  });
  if (publicSearchFollowUp && (!inheritedPublicSearch || !validPublicCounts)) {
    const replyText = 'Please confirm the check-in and check-out dates and guest counts so I can update the booking search link.';
    playbookDirective.compliance = { verbatim: replyText };
    ctx.agentResult = { replyText, confidence: 1, escalated: false, groundingStatus: 'not_required',
      outcome: 'clarification', effectProposals: [], toolCallsExecuted: [] };
    ctx.metadata = { ...ctx.metadata, suppressBusinessEffects: true };
    return true;
  }
  if ((playbookDirective?.nodeId === 'privacy-blocked' || publicSearchFollowUp) && agentType === 'hotel_sales'
    && !ctx.message.metadata?.publicReply && !channel.endsWith('_comment')
    && (publicSearchFollowUp || (request?.explicit && request.service === 'stay' && (['booking','booking_link','correction'].includes(request.action) || datedStayEnquiry)))) {
    try {
      const config = await getHotelPaymentConfiguration(userId);
      const approved = config.paymentMethodsEnabled === false
        ? await validateExternalBookingUrlDestination(config.externalBooking.url) : null;
      if (approved) {
        const base = new URL(approved);
        for (const key of [...base.searchParams.keys()]) if (key !== 'propertyId') base.searchParams.delete(key);
        base.hash = '';
        // Search only: never hydrate contact fields or reuse the old blocked
        // journey. Final guest details and confirmation belong on that page.
        const fields = searchFields;
        const url = buildExternalBookingSearchUrl({ baseUrl: base.toString(),
          checkIn: String(fields.checkIn || ''), checkOut: String(fields.checkOut || ''),
          adults: Number(fields.adults), children: Number(fields.children), rooms: Number(fields.rooms) }) || base.toString();
        const replyText = `You can check availability and book securely on the official booking page:\n${url}\nFinal availability, price and booking confirmation are completed there.`;
        playbookDirective.compliance = { verbatim: replyText };
        ctx.agentResult = { replyText, confidence: 1, escalated: false, groundingStatus: 'not_required',
          outcome: 'clarification', effectProposals: [], toolCallsExecuted: [] };
        ctx.metadata = { ...ctx.metadata, publicBookingSearch: true, suppressBusinessEffects: true };
        ctx.verifiedMedia = [];
        return true;
      }
    } catch (error) {
      logger.warn({ err: error }, '[AgentDispatch] Privacy-safe booking search unavailable');
    }
  }
  return false;
}
