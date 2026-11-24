export const SUPPORT_CHANNEL_OPTIONS = [
  { value: 'email', label: 'Email', description: 'Inbound and outbound support email' },
  { value: 'whatsapp', label: 'WhatsApp', description: 'Private WhatsApp conversations' },
  { value: 'instagram', label: 'Instagram', description: 'Instagram direct messages' },
  { value: 'instagram_comment', label: 'Instagram comments', description: 'Public Instagram comments' },
  { value: 'facebook', label: 'Facebook', description: 'Facebook Messenger conversations' },
  { value: 'facebook_comment', label: 'Facebook comments', description: 'Public Facebook comments' },
  { value: 'web', label: 'Web widget', description: 'Website support widget' },
] as const;

export const SUPPORT_TOOL_OPTIONS = [
  { value: 'answer_from_knowledge_base', label: 'Answer from knowledge base', description: 'Retrieve grounded information with sources', risk: 'read' },
  { value: 'get_hotel_info', label: 'Get hotel information', description: 'Read configured hotel details', risk: 'read' },
  { value: 'check_room_availability', label: 'Check room availability', description: 'Read current room availability', risk: 'read' },
  { value: 'save_booking_details', label: 'Save booking details', description: 'Store customer booking information', risk: 'write' },
  { value: 'create_booking', label: 'Create booking', description: 'Create a booking after required approval', risk: 'write' },
  { value: 'continue_external_booking', label: 'Continue external booking', description: 'Send the owner-approved external booking page after confirmation', risk: 'write' },
  { value: 'quote_or_negotiate_price', label: 'Quote or negotiate price', description: 'Make a price commitment after required approval', risk: 'write' },
  { value: 'handle_objection', label: 'Handle objection', description: 'Use the approved objection-handling guidance', risk: 'read' },
  { value: 'get_payment_methods', label: 'Get payment methods', description: 'Read available payment options', risk: 'read' },
  { value: 'send_payment_link', label: 'Send payment link', description: 'Create or send a payment link after approval', risk: 'write' },
  { value: 'check_payment_status', label: 'Check payment status', description: 'Read a verified payment status', risk: 'read' },
  { value: 'resolve_complaint', label: 'Resolve complaint', description: 'Apply a complaint resolution after approval', risk: 'write' },
  { value: 'escalate_to_human', label: 'Escalate to human', description: 'Stop automation and hand the conversation to an operator', risk: 'handoff' },
  { value: 'create_support_ticket', label: 'Create support ticket', description: 'Create a support ticket after required approval', risk: 'write' },
  { value: 'get_ticket_status', label: 'Get ticket status', description: 'Read the latest verified ticket status', risk: 'read' },
  { value: 'schedule_follow_up', label: 'Schedule follow-up', description: 'Schedule a later response after required approval', risk: 'write' },
  { value: 'qualify_lead', label: 'Qualify lead', description: 'Evaluate lead fit using configured criteria', risk: 'read' },
  { value: 'update_lead_score', label: 'Update lead score', description: 'Write a revised lead score after approval', risk: 'write' },
] as const;

export const SUPPORT_AGENT_TOOL_PRESETS: Record<string, readonly string[]> = {
  hotel_sales: [
    'answer_from_knowledge_base', 'get_hotel_info', 'check_room_availability',
    'save_booking_details', 'create_booking', 'continue_external_booking', 'quote_or_negotiate_price',
    'handle_objection', 'get_payment_methods', 'send_payment_link',
    'check_payment_status', 'escalate_to_human',
  ],
  tech_support: [
    'answer_from_knowledge_base', 'create_support_ticket', 'get_ticket_status',
    'schedule_follow_up', 'escalate_to_human',
  ],
  lead_qualifier: [
    'answer_from_knowledge_base', 'qualify_lead', 'update_lead_score',
    'schedule_follow_up', 'escalate_to_human',
  ],
  customer_success: [
    'answer_from_knowledge_base', 'resolve_complaint', 'create_support_ticket',
    'get_ticket_status', 'schedule_follow_up', 'escalate_to_human',
  ],
  general_service: [
    'answer_from_knowledge_base', 'get_hotel_info', 'escalate_to_human',
  ],
};

export function supportToolsForAgent(agentType: string, enabledTools: string[] = []) {
  const preset = new Set(SUPPORT_AGENT_TOOL_PRESETS[agentType] || []);
  const enabled = new Set(enabledTools);
  return SUPPORT_TOOL_OPTIONS.filter((tool) => preset.has(tool.value) || enabled.has(tool.value));
}

export interface SupportPolicyRuleView {
  id: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export function createSupportPolicyRule(type: string, sequence = 1): SupportPolicyRuleView {
  const id = `owner-${type}-${sequence}`;
  const defaults: Record<string, Record<string, unknown>> = {
    operating_hours: { timezone: 'Asia/Kolkata', start: '09:00', end: '18:00', outsideHoursAction: 'auto_reply_with_hours' },
    prohibited_topics: { topics: ['legal advice'], action: 'escalate' },
    max_response_length: { maxChars: 1500, action: 'truncate' },
    escalation_threshold: { threshold: 0.65 },
    rate_limit: { limit: 20, windowSeconds: 3600, action: 'block' },
    channel_restriction: { allowedChannels: ['email', 'whatsapp', 'instagram', 'facebook', 'web'] },
    required_disclaimer: { disclaimer: 'Please confirm important details with our team before making a decision.' },
    auto_escalate_intent: { intents: ['complaint', 'refund_request'] },
  };
  return { id, type, enabled: true, config: defaults[type] || {} };
}

export function replaceSupportPolicyRules(value: unknown, rules: SupportPolicyRuleView[]): unknown {
  if (Array.isArray(value)) return rules;
  if (value && typeof value === 'object') return { ...(value as Record<string, unknown>), rules };
  return { rules };
}

export function supportPolicyRules(value: unknown): SupportPolicyRuleView[] {
  const candidate = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { rules?: unknown }).rules)
      ? (value as { rules: unknown[] }).rules
      : [];
  return candidate.filter((rule): rule is SupportPolicyRuleView => Boolean(
    rule && typeof rule === 'object' && typeof (rule as SupportPolicyRuleView).type === 'string',
  ));
}

export function supportPolicyRuleLabel(type: string): string {
  return ({
    operating_hours: 'Operating hours',
    prohibited_topics: 'Prohibited topics',
    max_response_length: 'Maximum response length',
    escalation_threshold: 'Confidence escalation',
    rate_limit: 'Conversation rate limit',
    channel_restriction: 'Channel restriction',
    required_disclaimer: 'Required disclaimer',
    auto_escalate_intent: 'Automatic human handoff',
  } as Record<string, string>)[type] || type.replaceAll('_', ' ');
}

export function supportPolicyRuleSummary(rule: SupportPolicyRuleView): string {
  const config = rule.config || {};
  switch (rule.type) {
    case 'operating_hours':
      return `${String(config.start || '—')}–${String(config.end || '—')} · ${String(config.timezone || 'timezone not set')}`;
    case 'prohibited_topics':
      return `${Array.isArray(config.topics) ? config.topics.length : 0} protected topic patterns · ${String(config.action || 'block')}`;
    case 'max_response_length':
      return `${String(config.maxChars || '—')} characters · ${String(config.action || 'truncate')}`;
    case 'escalation_threshold':
      return `Hand off below ${Math.round(Number(config.threshold || 0) * 100)}% confidence`;
    case 'rate_limit':
      return `${String(config.limit || '—')} messages per ${String(config.windowSeconds || '—')} seconds · ${String(config.action || 'block')}`;
    case 'channel_restriction':
      return `${Array.isArray(config.allowedChannels) ? config.allowedChannels.length : 0} allowed channels`;
    case 'required_disclaimer':
      return String(config.disclaimer || 'Disclaimer not configured');
    case 'auto_escalate_intent':
      return `${Array.isArray(config.intents) ? config.intents.length : 0} intents trigger human handoff`;
    default:
      return 'Advanced policy rule';
  }
}
