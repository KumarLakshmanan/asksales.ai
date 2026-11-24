import { assistantDeliveryMetadata, assistantsRuntimeEnabled, currentAssistant } from '../../assistants/AssistantContext.js';
import { assistantDeliveryCurrent, assistantProvenanceCurrent } from '../../assistants/AssistantFreshness.js';
import type { AssistantProvenance } from '../../../../shared/outreachAssistants.js';

export const AUTOMATIC_REPLY_DISABLED = 'Automatic support replies are disabled for this platform.';

const automaticKinds = new Set([
  'pipeline_message', 'pipeline_choice', 'public_comment', 'email_smart_reply',
  'voice_reply', 'post_media_resume', 'post_media_failure', 'external_booking_private_handoff',
  'support_document',
  'support_media',
  'assistant_follow_up',
]);

export function socialDraftChannel(channel: string): boolean {
  return ['whatsapp', 'instagram', 'facebook'].includes(channel.replace(/_comment$/, ''));
}

export function isAutomaticSupportDelivery(metadata?: Record<string, unknown> | null): boolean {
  return automaticKinds.has(String(metadata?.dispatchKind || ''));
}

/** Read current settings at delivery time so work queued before a toggle is also stopped. */
export async function automaticSupportReplyAllowed(userId: number, channel: string, providerAccountId?: string | null, metadata?: Record<string,unknown>): Promise<boolean> {
  const assistant=currentAssistant();
  metadata={...assistantDeliveryMetadata(),...metadata};
  const provenance=(metadata?.assistant || assistant?.provenance) as AssistantProvenance | undefined;
  if (assistantsRuntimeEnabled() && provenance) {
    if (assistant?.preview || !provenance || provenance.channel !== channel.replace(/_comment$/,'')
      || provenance.surface !== (channel.endsWith('_comment') ? 'public_comment' : 'private')
      || (providerAccountId && providerAccountId !== provenance.accountId)
      || (assistant && (assistant.provenance.bindingId !== provenance.bindingId || assistant.provenance.revision !== provenance.revision))) return false;
    // Support follow-ups defer outside hours in their own scheduler. Regular
    // replies stay silent and away replies require their delivery reservation.
    return metadata?.dispatchKind === 'assistant_follow_up' ? assistantProvenanceCurrent(provenance)
      : assistantDeliveryCurrent(provenance,metadata);
  }
  return false;
}
