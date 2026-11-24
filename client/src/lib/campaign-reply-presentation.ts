import type { Message } from '@/models/message';
import { getPersona } from '@/lib/agent-personas';
import { CAMPAIGN_AGENT_MENTIONS, extractCampaignAgentMentions } from '../../../shared/campaignAgentMentions';
import { campaignSpeakerSections, selectCampaignSpeakerReply, stripCampaignSpeakerLabel } from '../../../shared/campaignAgentReply';

export const campaignReplySpeakers = CAMPAIGN_AGENT_MENTIONS.map(({ agent }) => {
  const persona = getPersona(agent);
  return { id: agent, names: [persona.firstName, persona.fullName, persona.displayName] };
});

export function campaignReplyText(text: string, agentType: string) {
  const speaker = campaignReplySpeakers.find(candidate => candidate.id === agentType);
  return speaker ? stripCampaignSpeakerLabel(text, speaker, campaignReplySpeakers) : text;
}

/** Repair presentation of older team turns only when every addressed
 * specialist actually replied with the same set of attributed sections.
 * Stored history stays intact, and a lone combined answer stays complete. */
export function campaignReplyOverrides(messages: Message[]): Map<string, string> {
  const overrides = new Map<string, string>();
  let requested: string[] = [];
  let replies: Message[] = [];
  const finishTurn = () => {
    if (requested.length < 2 || !requested.every(agent => replies.some(reply => reply.agentType === agent))) return;
    const speakers = campaignReplySpeakers.filter(speaker => requested.includes(speaker.id));
    if (!replies.every(reply => {
      const sections = campaignSpeakerSections(reply.content, speakers);
      return sections?.length === requested.length && requested.every(agent => sections.some(section => section.speaker === agent));
    })) return;
    for (const reply of replies) overrides.set(reply.id, selectCampaignSpeakerReply(reply.content, reply.agentType!, speakers));
  };
  for (const message of messages) {
    if (message.role === 'user') {
      finishTurn();
      requested = extractCampaignAgentMentions(message.content).map(mention => mention.agent)
        .filter(agent => agent !== 'orchestrator' && agent !== 'icp_generation');
      replies = [];
    } else if ((message.role === 'agent' || message.role === 'assistant') && requested.includes(message.agentType || '')
      && !message.metadata?.isToolCall && !message.metadata?.isToolResult && !message.metadata?.isTransition
      && !(message.metadata?.streaming && !message.metadata?.streamingComplete)) {
      replies.push(message);
    }
  }
  finishTurn();
  return overrides;
}
