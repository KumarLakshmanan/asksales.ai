/** Registered names shared by authoring and the server capability registry.
 * Execution permissions, argument validation and approval remain server-owned.
 */
export const SUPPORT_CAPABILITY_NAMES = [
  'ticket.status',
  'catalog.search',
  'availability.check',
  'quote.present',
  'proposal.list',
  'proposal.request',
  'proposal.revision_request',
  'knowledge.answer',
  'media.select',
  'asset.deliver',
  'inquiry.create',
  'callback.request',
  'checkout.continue',
  'human_handoff.create',
] as const;

export type SupportCapabilityName = typeof SUPPORT_CAPABILITY_NAMES[number];
