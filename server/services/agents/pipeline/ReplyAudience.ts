/** A staff-triggered composer draft is still destined for a customer. */
export function replyAudience(metadata?: { executionMode?: string; conversationKind?: string }): 'internal' | 'customer' {
  return metadata?.executionMode === 'advisory' && metadata.conversationKind !== 'outreach_draft'
    ? 'internal' : 'customer';
}
