import type { NormalizedMessage } from './agents/pipeline/ChannelGateway.js';
import { AssistantManagementError } from './assistants/AssistantManagementError.js';
import { ConversationRequestError } from './ConversationRequestCoordinator.js';

/** Resolve before persisting a turn or claiming its durable request. A routing
 * rejection is a configuration problem, not a completed AI answer or an
 * interrupted action requiring reconciliation. The gateway rechecks at dispatch.
 */
export async function requireSupportChatAssistant(message: NormalizedMessage): Promise<void> {
  const { AssistantRoutingError, resolveTurnAssistant } = await import('./assistants/AssistantResolver.js');
  try {
    await resolveTurnAssistant({
      ...message,
      metadata: { ...message.metadata, dryRun: true },
    });
  } catch (error) {
    if (!(error instanceof AssistantRoutingError) && !(error instanceof AssistantManagementError)) throw error;
    throw new ConversationRequestError('support_assistant_unavailable',
      `${error.message} Open Manage assistants and select an available assistant configuration before sending a new message.`, 409);
  }
}
