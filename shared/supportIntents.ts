/** Canonical routing vocabulary shared by classification, validation, and editors. */
export type SupportIntent =
  | 'greeting' | 'faq' | 'availability_inquiry' | 'pricing_question' | 'booking_request'
  | 'negotiation' | 'modify_booking' | 'cancel_booking' | 'complaint' | 'refund_request'
  | 'support_request' | 'speak_to_human' | 'smalltalk' | 'clarify' | 'other'
  | 'payment_inquiry' | 'ticket_status'
  | 'lead_qualification' | 'sales_inquiry' | 'purchase_intent' | 'demo_request'
  | 'proposal_request' | 'proposal_status' | 'proposal_revision';
export const SUPPORT_INTENTS: SupportIntent[] = [
  'greeting', 'faq', 'availability_inquiry', 'pricing_question', 'booking_request',
  'negotiation', 'modify_booking', 'cancel_booking', 'complaint', 'refund_request',
  'support_request', 'speak_to_human', 'smalltalk', 'clarify', 'other',
  'payment_inquiry', 'ticket_status', 'lead_qualification', 'sales_inquiry', 'purchase_intent',
  'demo_request', 'proposal_request', 'proposal_status', 'proposal_revision',
];
