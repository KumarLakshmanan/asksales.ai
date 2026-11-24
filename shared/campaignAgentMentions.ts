/** Leading mentions address a campaign agent; email addresses and social handles
 * inside the request remain ordinary content. A mention never authorizes a tool. */
export const CAMPAIGN_AGENT_MENTIONS = [
  { agent: 'orchestrator', handle: 'coordinator', aliases: ['orchestrator', 'supervisor'] },
  { agent: 'icp_generation', handle: 'icp', aliases: ['icp_generation'] },
  { agent: 'lead_generation', handle: 'marcus', aliases: ['lead', 'leads', 'lead_generation'] },
  { agent: 'content_studio', handle: 'alex', aliases: ['content', 'content_studio'] },
  { agent: 'outreach', handle: 'emily', aliases: ['outreach'] },
  { agent: 'performance_marketing', handle: 'sarah', aliases: ['performance', 'performance_marketing', 'analytics'] },
] as const;

/** Only a contiguous run of leading @handles is addressing. Later handles in
 * ordinary prose or email addresses remain message content. */
export function extractCampaignAgentMentions(text: string) {
  const mentions: (typeof CAMPAIGN_AGENT_MENTIONS)[number][] = [];
  let remaining = text.trimStart();
  while (remaining.startsWith('@')) {
    const match = /^@([a-z_]+)(?=\s|:|,|$)/i.exec(remaining);
    if (!match) break;
    const handle = match[1].toLowerCase();
    const mention = CAMPAIGN_AGENT_MENTIONS.find(item => item.handle === handle || item.aliases.some(alias => alias === handle));
    if (!mention) break;
    if (!mentions.some(item => item.agent === mention.agent)) mentions.push(mention);
    remaining = remaining.slice(match[0].length).replace(/^[,:]\s*/, '').trimStart();
  }
  return mentions;
}
