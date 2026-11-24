import { SubAgentBase, SubAgentContext, SubAgentResult } from './SubAgentBase.js';
import { logger } from '../../../utils/logger.js';

export class SubAgentRegistry {
  private static instance: SubAgentRegistry;
  private registry: Map<string, SubAgentBase> = new Map();

  private constructor() {}

  public static getInstance(): SubAgentRegistry {
    if (!SubAgentRegistry.instance) {
      SubAgentRegistry.instance = new SubAgentRegistry();
    }
    return SubAgentRegistry.instance;
  }

  public register(subAgent: SubAgentBase): void {
    if (this.registry.has(subAgent.metadata.id)) {
      logger.warn(`[SubAgentRegistry] Overwriting registered sub-agent: ${subAgent.metadata.id}`);
    }
    this.registry.set(subAgent.metadata.id, subAgent);
    logger.info(`[SubAgentRegistry] Registered sub-agent: ${subAgent.metadata.id} (${subAgent.metadata.name})`);
  }

  public getById(id: string): SubAgentBase | undefined {
    return this.registry.get(id);
  }

  public getAll(): SubAgentBase[] {
    return Array.from(this.registry.values());
  }

  public getForIds(ids: string[]): SubAgentBase[] {
    return ids
      .map(id => this.registry.get(id))
      .filter((agent): agent is SubAgentBase => agent !== undefined);
  }

  public getForIntent(intent: string): SubAgentBase[] {
    return this.getAll()
      .filter(agent => agent.metadata.intents.includes(intent))
      .sort((a, b) => a.metadata.priority - b.metadata.priority);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public getToolsForSubAgents(ids: string[]): any[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any[] = [];
    const seen = new Set<string>();

    for (const id of ids) {
      const agent = this.registry.get(id);
      if (!agent) continue;

      for (const tool of agent.metadata.tools) {
        const name = tool.function?.name;
        if (name && !seen.has(name)) {
          seen.add(name);
          tools.push(tool);
        }
      }
    }

    return tools;
  }

  public async dispatch(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any,
    ctx: SubAgentContext,
    subAgentIds: string[]
  ): Promise<SubAgentResult> {
    const activeSubAgents = this.getForIds(subAgentIds);
    
    // Find the sub-agent that exposes this tool
    const targetAgent = activeSubAgents.find(agent => 
      agent.metadata.tools.some(tool => tool.function?.name === toolName)
    );

    if (!targetAgent) {
      logger.error(`[SubAgentRegistry] No composed sub-agent found for tool: ${toolName}`);
      throw new Error(`Tool ${toolName} is not supported by any composed sub-agents.`);
    }

    logger.info(`[SubAgentRegistry] Dispatching tool ${toolName} to sub-agent: ${targetAgent.metadata.id}`);
    return targetAgent.execute(toolName, args, ctx);
  }

  /** Executes a previously approved durable tool request after process restart. */
  public async dispatchAny(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any,
    ctx: SubAgentContext,
  ): Promise<SubAgentResult> {
    const targetAgent = this.getAll().find((agent) =>
      agent.metadata.tools.some((tool) => tool.function?.name === toolName));
    if (!targetAgent) throw new Error(`Tool ${toolName} is not registered for durable execution.`);
    return targetAgent.execute(toolName, args, ctx);
  }
}

export const subAgentRegistry = SubAgentRegistry.getInstance();
