import type { AgentState } from './state.js';
import { AGENT_PERSONAS } from './agentPersonas.js';

const specialistChoices = [
  { agent: 'lead_generation', id: 'hire_lead_gen', label: 'Lead Generation', action: 'HIRE_LEAD_GEN' },
  { agent: 'content_studio', id: 'hire_content_studio', label: 'Content Studio', action: 'HIRE_CONTENT_STUDIO' },
  { agent: 'outreach', id: 'hire_outreach', label: 'Outreach', action: 'HIRE_OUTREACH' },
  { agent: 'performance_marketing', id: 'hire_performance', label: 'Performance Marketing', action: 'HIRE_PERFORMANCE' },
];

/** Use the selected team, never reinterpret the original request after
 * approval. Without a selected team, ICP match scores (when available) order
 * the choices, best match first. */
export function buildApprovedIcpAgentSelection(
  state: Pick<AgentState, 'agentPipeline'>,
  scores?: Record<string, number> | null,
) {
  const selected = specialistChoices.filter(choice => state.agentPipeline?.includes(choice.agent as NonNullable<AgentState['agentPipeline']>[number]));
  const scored = !selected.length && scores
    ? [...specialistChoices].sort((a, b) => (Number(scores[b.agent]) || 0) - (Number(scores[a.agent]) || 0))
    : null;
  const choices = selected.length ? selected : scored || specialistChoices;
  return {
    recommendedAgents: (scored ? scored.filter(choice => (Number(scores?.[choice.agent]) || 0) > 0) : choices).map(choice => choice.agent),
    actionButtons: [
      ...choices.map(({ agent: _agent, ...choice }, index) => ({ ...choice, type: index === 0 ? 'primary' : 'secondary' })),
      { id: 'choose_agent', label: 'Choose agent', action: 'OPEN_TAB', type: 'secondary', data: { tabType: 'agentchoose' } },
    ],
  };
}

/** One sentence naming the agents that best match the approved ICP. */
export function icpAgentRecommendationSentence(scores?: Record<string, number> | null): string | null {
  if (!scores) return null;
  const ranked = specialistChoices
    .map(choice => ({ agent: choice.agent, label: choice.label, score: Math.round(Number(scores[choice.agent]) || 0) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  const name = (entry: typeof ranked[number]) => {
    const persona = (AGENT_PERSONAS as Record<string, { firstName?: string }>)[entry.agent];
    return `${persona?.firstName ? `${persona.firstName} (${entry.label})` : entry.label}, ${entry.score}% match`;
  };
  const [first, ...rest] = ranked;
  return `For this ICP I recommend starting with **${name(first)}**${rest.length ? `, then ${rest.slice(0, 2).map(name).join(' and ')}` : ''}.`;
}
