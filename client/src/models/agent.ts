export const agentTypes = [
  "orchestrator",
  "supervisor",
  "icp_generation",
  "lead_generation",
  "content_studio",
  "outreach",
  "performance_marketing",
] as const;

export type AgentType = typeof agentTypes[number];