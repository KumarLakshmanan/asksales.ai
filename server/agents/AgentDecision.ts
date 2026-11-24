/**
 * Agent Decision Interface
 * 
 * Defines the structured output format for agent nodes.
 * Agents produce decisions (commands), NOT side-effects.
 * Side-effects are delegated to Tool Workers via the Job Queue.
 */

// ─── Agent Decision Types ───────────────────────────────────────────────────────

export type AgentDecisionType =
  | 'execute_tool'    // Execute a tool via worker
  | 'respond'         // Respond to user with a message
  | 'route_to_agent'  // Route to a different agent
  | 'require_approval'// Require human approval before proceeding
  | 'complete'        // Mark workflow as complete
  | 'request_input'   // Request additional input from user
  | 'schedule_action' // Schedule a future action
  | 'no_op';          // No operation needed

// ─── Tool Execution Command ─────────────────────────────────────────────────────

export interface ToolCommand {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: Record<string, any>;
  priority?: 'high' | 'normal' | 'low';
  delayMs?: number;
  retryPolicy?: {
    maxAttempts: number;
    backoffMs: number;
  };
}

// ─── Agent Decision ─────────────────────────────────────────────────────────────

export interface AgentDecision {
  type: AgentDecisionType;
  
  // For 'respond' type
  message?: string;
  
  // For 'execute_tool' type
  tools?: ToolCommand[];
  
  // For 'route_to_agent' type
  targetAgent?: string;
  routingReason?: string;
  
  // For 'require_approval' type
  approvalData?: {
    description: string;
    impact: string;
    estimatedCost?: number;
    requiredBy?: string;
  };
  
  // For 'schedule_action' type
  schedule?: {
    executeAt: string; // ISO timestamp
    action: ToolCommand;
  };
  
  // Metadata
  confidence: number; // 0-1, how confident the agent is
  reasoning?: string; // Internal reasoning (for debugging, not shown to user)
  
  // UI hints
  actionButtons?: Array<{
    id: string;
    label: string;
    action: string;
    type?: 'primary' | 'secondary' | 'danger';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data?: Record<string, any>;
  }>;
}

// ─── Decision Builder ───────────────────────────────────────────────────────────

export class DecisionBuilder {
  private decision: Partial<AgentDecision> = {};

  static respond(message: string): AgentDecision {
    return {
      type: 'respond',
      message,
      confidence: 1.0,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static executeTool(toolName: string, parameters: Record<string, any>): AgentDecision {
    return {
      type: 'execute_tool',
      tools: [{ toolName, parameters }],
      confidence: 1.0,
    };
  }

  static executeTools(tools: ToolCommand[]): AgentDecision {
    return {
      type: 'execute_tool',
      tools,
      confidence: 1.0,
    };
  }

  static routeTo(agent: string, reason?: string): AgentDecision {
    return {
      type: 'route_to_agent',
      targetAgent: agent,
      routingReason: reason,
      confidence: 1.0,
    };
  }

  static requireApproval(description: string, impact: string): AgentDecision {
    return {
      type: 'require_approval',
      approvalData: { description, impact },
      confidence: 1.0,
    };
  }

  static complete(message?: string): AgentDecision {
    return {
      type: 'complete',
      message,
      confidence: 1.0,
    };
  }

  static requestInput(message: string, actionButtons?: AgentDecision['actionButtons']): AgentDecision {
    return {
      type: 'request_input',
      message,
      actionButtons,
      confidence: 1.0,
    };
  }

  static noOp(): AgentDecision {
    return {
      type: 'no_op',
      confidence: 1.0,
    };
  }
}
