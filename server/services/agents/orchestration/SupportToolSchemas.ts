import { z } from 'zod';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const positiveInt = z.coerce.number().int().positive();
const nonNegativeMoney = z.coerce.number().nonnegative().finite();

const schemas: Record<string, z.ZodTypeAny> = {
  get_customer_chat_history: z.object({ conversation_id: positiveInt.optional(), before_id: z.coerce.number().int().nonnegative().optional() }).strict(),
  answer_from_knowledge_base: z.object({ query: z.string().trim().min(1).max(4_000) }),
  check_payment_status: z.object({ booking_id: positiveInt.optional(), payment_id: z.string().max(255).optional() }),
  check_room_availability: z.object({
    check_in: dateString,
    check_out: dateString,
    guests: positiveInt.max(100),
    adults: positiveInt.max(100).optional(),
    children: z.coerce.number().int().min(0).max(100).optional(),
    rooms: positiveInt.max(100).optional(),
    room_type: z.string().trim().max(160).optional(),
    stay_type: z.enum(['overnight', 'dayuse']).optional(),
    promo_code: z.string().trim().min(1).max(100).optional(),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  }),
  get_hotel_info: z.object({}),
  get_payment_methods: z.object({}),
  get_ticket_status: z.object({ ticket_id: positiveInt.optional() }),
  get_conversation_proposals: z.object({ proposal_id: positiveInt.optional() }).strict(),
  create_conversation_proposal_draft: z.object({
    title: z.string().trim().min(1).max(500),
    context: z.string().trim().max(8_000).optional(),
    requirements: z.object({
      objectives: z.string().trim().max(4_000).optional(),
      deliverables: z.string().trim().max(4_000).optional(),
      timeline: z.string().trim().max(4_000).optional(),
      responsibilities: z.string().trim().max(4_000).optional(),
      budget: z.string().trim().max(4_000).optional(),
    }).strict().optional(),
  }).strict(),
  request_proposal_revision: z.object({
    proposal_id: positiveInt.optional(),
    proposal_number: z.string().trim().min(1).max(50).optional(),
    requested_changes: z.string().trim().min(1).max(8_000),
  }).strict().refine(value => (value.proposal_id !== undefined) !== (value.proposal_number !== undefined), {
    message: 'Provide either proposal_id or proposal_number.',
  }),
  create_booking: z.object({
    room_type_id: positiveInt,
    agreed_price_per_night: nonNegativeMoney,
    guest_name: z.string().trim().min(1).max(200).optional(),
    guest_email: z.string().email().max(320).optional(),
    included_perks: z.array(z.string().trim().min(1).max(240)).max(20).optional(),
  }),
  continue_external_booking: z.object({
    room_type_id: positiveInt.optional(),
    room_type_name: z.string().trim().min(1).max(160).optional(),
    agreed_price_per_night: nonNegativeMoney.optional(),
    guest_name: z.string().trim().min(1).max(200).optional(),
    guest_email: z.string().email().max(320).optional(),
  }).refine((value) => value.room_type_id !== undefined || value.room_type_name !== undefined, {
    message: 'room_type_id or room_type_name is required',
  }),
  save_booking_details: z.object({
    check_in: dateString.optional(), check_out: dateString.optional(), guests: positiveInt.max(100).optional(),
    rooms: positiveInt.max(100).optional(), room_type_id: positiveInt.optional(),
    guest_name: z.string().trim().min(1).max(200).optional(),
    guest_phone: z.string().trim().min(7).max(40).optional(), guest_email: z.string().email().max(320).optional(),
    special_requests: z.string().max(2_000).optional(),
  }),
  send_payment_link: z.object({ booking_id: positiveInt.optional() }),
  resolve_complaint: z.object({ complaint_details: z.string().trim().min(1).max(4_000), resolution_action: z.string().trim().min(1).max(4_000) }),
  quote_or_negotiate_price: z.object({ room_type_id: positiveInt, requested_price_per_night: nonNegativeMoney.optional() }),
  handle_objection: z.object({ objection_type: z.enum(['price', 'thinking_about_it', 'comparing_hotels', 'trust', 'availability', 'other']), room_type_id: positiveInt.optional() }),
  escalate_to_human: z.object({ reason: z.string().trim().min(1).max(2_000), type: z.enum(['support', 'sales']) }),
  create_support_ticket: z.object({ subject: z.string().trim().min(1).max(240), description: z.string().max(10_000).optional(), priority: z.enum(['low', 'medium', 'high', 'urgent']).optional() }),
  // Validate recorded legacy calls; this tool is no longer offered to models.
  schedule_follow_up: z.object({ type: z.enum(['payment_reminder', 're_engagement']), delay_hours: positiveInt.max(8_760).optional() }),
  qualify_lead: z.object({ intent: z.enum(['low', 'exploring', 'serious', 'urgent']), group_size: positiveInt.max(100_000).optional(), rooms_requested: positiveInt.max(100_000).optional(), budget_per_night: nonNegativeMoney.optional(), urgency: z.enum(['low', 'medium', 'high']).optional() }),
  update_lead_score: z.object({ score: z.coerce.number().int().min(0).max(100) }),
};

export function validateSupportToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  partial = false,
): { success: true; data: Record<string, unknown> } | { success: false; error: string } {
  const schema = schemas[toolName];
  if (!schema) return { success: false, error: `No argument schema is registered for ${toolName}.` };
  const selected = partial && schema instanceof z.ZodObject ? schema.partial() : schema;
  const result = selected.safeParse(args);
  if (!result.success) return { success: false, error: result.error.issues.map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`).join('; ') };
  return { success: true, data: result.data as Record<string, unknown> };
}
