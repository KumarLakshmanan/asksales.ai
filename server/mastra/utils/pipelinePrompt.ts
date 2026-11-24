import type { AgentState, AgentType } from '../state.js';
import { getPersona } from '../agentPersonas.js';

/**
 * The name a specialist uses for a teammate when talking to the user. It must
 * match the persona the chat displays, so it is derived from the shared
 * persona record instead of being typed into each prompt.
 */
export function pipelineAgentLabel(agent: AgentType | string): string {
  if (agent === 'icp_generation') return 'the ICP specialist';
  return getPersona(agent).switchLabel;
}

export interface PipelinePromptOptions {
  /** Completes "After completing <workLabel> and confirming results with the user". */
  workLabel: string;
  /** Example handoff sentence, given the next teammate's display label. */
  handoffExample: (nextName: string) => string;
}

/** PIPELINE STATUS block shared by every specialist system prompt. */
export function buildPipelineStatusPrompt(
  state: Pick<AgentState, 'agentPipeline' | 'agentPipelineIndex'>,
  options: PipelinePromptOptions,
): string {
  const pipeline = state.agentPipeline;
  if (!pipeline || pipeline.length === 0) return '';
  const currentIndex = state.agentPipelineIndex || 0;
  const isLast = currentIndex >= pipeline.length - 1;
  const pipelineList = pipeline.map((agent, index) =>
    `  ${index + 1}. ${pipelineAgentLabel(agent)}${index === currentIndex ? ' ← YOU ARE HERE' : ''}`).join('\n');
  let prompt = `\n\nPIPELINE STATUS:\nFull pipeline:\n${pipelineList}\nYou are agent ${currentIndex + 1} of ${pipeline.length}.`;
  if (isLast) {
    return `${prompt}\nYou are the LAST agent in the pipeline. After completing your work, you do NOT need to call tasks_completed. Simply wrap up and let the user know you're done.`;
  }
  const nextName = pipelineAgentLabel(pipeline[currentIndex + 1]);
  prompt += `\nAfter completing ${options.workLabel} and confirming results with the user, you MUST call tasks_completed to hand off to the next agent: ${nextName}. Refer to that teammate only by this exact name. Introduce the transition in a warm, detailed, and team-oriented way. For example: "${options.handoffExample(nextName)}"`;
  return prompt;
}
