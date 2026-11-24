/* eslint-disable @typescript-eslint/no-explicit-any */
import { runToolCallingLoop } from '../utils/toolCallingLoop.js';
import { checkRoomAvailabilityTool, bookRoomTool } from '../tools/hotelTools.js';
import { getMessagesByConversationId } from '../../models/outreachConversations/functions.js';
import { logger } from '../../utils/logger.js';
import type { ToolContext } from '../tools/toolRegistry.js';

interface RunSupportAgentOptions {
  userId: number;
  conversationId: number;
  messageText: string;
  kbContext: string;
  channel: string;
   
  lead?: any;
  enabledAgent?: {
    agentType: string;
    displayName: string;
    systemPrompt: string;
  };
}

export async function getDynamicHotelContext(userId: number): Promise<string> {
  try {
    const { db } = await import('../../models/db.js');
    const { sql } = await import('drizzle-orm');
    
    // Find hotel property
    const hotelRows = await db.execute(sql`SELECT id, name, currency FROM hotel_properties WHERE user_id = ${userId} LIMIT 1`);
     
    const hotel = (hotelRows.rows as any[])[0];
    if (!hotel) return '';

    const hotelId = Number(hotel.id);
    const currency = hotel.currency || 'INR';

    // Get room types
    const rtRows = await db.execute(sql`SELECT id, name, capacity, base_price, description FROM room_types WHERE hotel_id = ${hotelId}`);
     
    const roomTypes = rtRows.rows as any[];

    // Get availability for the next 30 days
    const today = new Date().toISOString().slice(0, 10);
    const maxDate = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

    const avRows = await db.execute(sql`
      SELECT ra.room_type_id, ra.date, ra.available_count, ra.price_per_night
      FROM room_availability ra
      JOIN room_types rt ON rt.id = ra.room_type_id
      WHERE rt.hotel_id = ${hotelId}
        AND ra.date >= ${today}::date
        AND ra.date <= ${maxDate}::date
      ORDER BY ra.date ASC
    `).then((r: any) => r.rows as any[]);

    let text = `\n--- DYNAMIC HOTEL ROOM TYPES & DAILY AVAILABILITY (RAG KNOWLEDGE BASE) ---\n`;
    text += `Hotel Property: ${hotel.name}\n`;
    text += `Default Currency: ${currency}\n\n`;
    text += `Available Room Categories:\n`;
    
    for (const rt of roomTypes) {
      text += `- ${rt.name} (Room Type ID: ${rt.id}): Capacity up to ${rt.capacity} guests. Base Price: ${currency} ${Number(rt.base_price).toFixed(0)}. Description: ${rt.description || 'N/A'}\n`;
      
       
      const rtAv = avRows.filter((a: any) => Number(a.room_type_id) === Number(rt.id));
      if (rtAv.length > 0) {
        text += `  Daily Pricing & Availability (Next 30 Days):\n`;
         
        text += rtAv.map((a: any) => {
          const dStr = (a.date instanceof Date ? a.date.toISOString() : String(a.date)).slice(0, 10);
          return `    * Date: ${dStr} | Available Rooms: ${a.available_count} | Nightly Rate: ${currency} ${Number(a.price_per_night).toFixed(0)}`;
        }).join('\n') + '\n';
      } else {
        text += `  No specific nightly rates/availability configured for the next 30 days. Fall back to Base Price of ${currency} ${Number(rt.base_price).toFixed(0)} per night (subject to confirmation).\n`;
      }
    }
    text += `\nUse the above live availability and pricing details to answer guest questions directly and accurately.`;
    return text;
  } catch (err) {
    logger.error({ err, userId }, '[SupportAgent] Error loading dynamic hotel context');
    return '';
  }
}

export async function runSupportAgent(opts: RunSupportAgentOptions): Promise<string> {
  const { userId, conversationId, messageText, kbContext, channel, lead, enabledAgent } = opts;

  try {
    // 1. Fetch recent messages to build conversation history (memory)
    const dbMessages = await getMessagesByConversationId(conversationId, 10);
    const sortedDbMessages = [...dbMessages].reverse();

    const conversationMsgs: Array<{ role: string; content: string }> = [];
    
    // Add existing history
    for (const msg of sortedDbMessages) {
      if (!msg.content) continue;
      conversationMsgs.push({
        role: msg.direction === 'inbound' ? 'user' : 'assistant',
        content: msg.content,
      });
    }

    // If the latest incoming message is not already in the fetched history, append it
    const lastMsg = conversationMsgs[conversationMsgs.length - 1];
    if (!lastMsg || lastMsg.content !== messageText || lastMsg.role !== 'user') {
      conversationMsgs.push({
        role: 'user',
        content: messageText,
      });
    }

    const agentPrompt = enabledAgent?.systemPrompt || `You are a helpful customer service representative.`;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const agentName = enabledAgent?.displayName || 'Customer Service Representative';
    const agentType = enabledAgent?.agentType || 'general_service';
    const currentDateUtc = new Date().toISOString().slice(0, 10);

    const dynamicHotelContext = await getDynamicHotelContext(userId);

    // 2. Build the support agent system prompt
    let systemPrompt = `${agentPrompt}

Message Channel: ${channel}
Current Date (UTC): ${currentDateUtc}
Lead Information:
- Name: ${lead?.name || 'Unknown'}
- Company: ${lead?.company || 'Unknown'}

Knowledge Base Context (RAG):
${kbContext}
${dynamicHotelContext}

`;

     
    const tools: Record<string, any> = {};
    if (agentType === 'hotel_sales') {
      tools.check_room_availability = checkRoomAvailabilityTool;
      tools.book_room = bookRoomTool;

      systemPrompt += `YOUR TOOLS:
- check_room_availability: Check hotel room availability and pricing for a specific date range and number of guests.
- book_room: Book a room for a guest.

INSTRUCTIONS FOR HOTEL INQUIRIES & BOOKING:
1. Use the Knowledge Base context (RAG) to answer general questions (e.g. policies, amenities, check-in times).
2. For room booking or availability inquiries:
   - You MUST obtain the check-in date, check-out date, and the number of guests.
   - If any of these details are missing, ask the user for them politely.
   - Once you have the check-in date, check-out date, and number of guests, call "check_room_availability".
   - Present the available rooms, their pricing per night, and total prices clearly.
   - Offer the customer to book by paying through a secure payment link.
   - When the guest is ready to book, confirm their details (Name and optionally Email) and call "book_room".
   - After calling "book_room", share the returned paymentLink with the customer so they can complete payment. Explain that once paid, the hotel admin will confirm the booking in their dashboard.
`;
    }

    const isPublicComment = channel === 'instagram_comment' || channel === 'facebook_comment';
    if (isPublicComment) {
      systemPrompt += `
INSTRUCTIONS FOR PUBLIC SOCIAL MEDIA COMMENTS:
1. This is a PUBLIC comment on a social media post, NOT a private DM.
2. Do NOT ask the user for their personal details (such as guest name, email, phone number, check-in/check-out dates, or payment details) in a public comment thread.
3. Answer their questions directly using the available Knowledge Base, post details, and business profile info.
4. If they ask about booking or real-time room availability:
   - Provide general room category information and pricing from the business profile.
   - Do NOT try to gather check-in/check-out slots. Instead, politely invite them to send a Direct Message (DM) to this account or visit our website to check real-time availability and complete their booking.
`;
    }

    // Determine if this is an ongoing conversation (we have history besides the current turn)
    const hasHistory = conversationMsgs.length > 1;

    systemPrompt += `
GENERAL INSTRUCTIONS:
1. Keep your responses under 300 characters for SMS/DMs unless listing room options.
2. Output only the final response text. No quotes, labels, or extra formatting.
3. NEVER use placeholders or template variables (e.g., [link], [meeting link], [insert calendar link], [insert here]). Every word must be ready to send directly as-is.
4. Do not make up information that is not supported by your tools or the Knowledge Base.
5. Treat dates before the Current Date as historical. Do not ask the customer to finalize, pay for, or continue a stay or appointment whose dates have already passed.
6. Never state that a booking, payment, refund, cancellation, or other side effect succeeded unless an authorized tool returned a successful result in this current turn.
7. If the latest customer message is only a greeting or acknowledgement, reply briefly and offer help. Do not resurrect an old request, pending payment, or past booking unless the customer explicitly refers to it.

GREETING POLISHING RULE:
- ${hasHistory
  ? "This conversation is already in progress. Do NOT greet the user by name (e.g., do NOT start your message with 'Hello Lakshman' or 'Hi Lakshman'). Get straight to answering their question."
  : "This is the very first turn of the conversation. You may start your message with a polite greeting including the user's name if known (e.g., 'Hello Lakshman' or 'Hi Lakshman'), then ask how you can help."
}`;

    // 3. Build tool context
    const toolContext: ToolContext = {
      userId,
      threadId: conversationId,
      conversationHistory: conversationMsgs,
    };

    // 4. Execute tool calling loop
    const result = await runToolCallingLoop({
      userId,
      threadId: conversationId,
      systemPrompt,
      messages: conversationMsgs,
      agentType,
      tools,
      toolContext,
      temperature: 0.4,
      loggingContext: { purpose: `webhook_${agentType}`, service: 'SupportAgent' },
    });

    return result.text || 'Thanks for reaching out! We will get back to you soon.';
  } catch (error) {
    logger.error({ err: error, conversationId }, '[SupportAgent] Error executing support agent loop');
    return 'Thanks for your message! Our team will get back to you shortly.';
  }
}
