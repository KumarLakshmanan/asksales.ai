/**
 * Centralized Agent Persona Data — Single Source of Truth (Client)
 *
 * ALL agent names, avatars, display names, ring colors, bubble classes,
 * and hire messages should be imported from this file.
 * Never hardcode agent persona data in components.
 */

export type AgentType =
  | "orchestrator"
  | "supervisor"
  | "icp_generation"
  | "lead_generation"
  | "content_studio"
  | "outreach"
  | "performance_marketing";

interface AgentPersona {
  firstName: string;
  fullName: string;
  role: string;
  avatar: string;
  ringColor: string;
  bubbleClass: string;
  displayName: string;
  hireMessage: string;
  shortLabel: string;
  specialty: string;
  color: string;
}

// ── Core Definitions ───────────────────────────────────────────────────────────

const PERSONAS: Record<string, AgentPersona> = {
  orchestrator: {
    firstName: "Coordinator",
    fullName: "AI Coordinator",
    role: "Campaign Coordinator",
    avatar: "/agent-avatars/Orchestrator.png",
    ringColor: "#b48cf2",
    bubbleClass: "bg-[#f1edff] dark:bg-[#1f1d3a]",
    displayName: "Coordinator",
    hireMessage: "",
    shortLabel: "Coordinator",
    specialty: "Coordination",
    color: "bg-teal-500",
  },
  supervisor: {
    firstName: "Supervisor",
    fullName: "AI Supervisor",
    role: "Agent Supervisor",
    avatar: "/agent-avatars/Orchestrator.png",
    ringColor: "#b48cf2",
    bubbleClass: "bg-[#f1edff] dark:bg-[#1f1d3a]",
    displayName: "Supervisor",
    hireMessage: "",
    shortLabel: "Supervisor",
    specialty: "Supervision",
    color: "bg-purple-500",
  },
  icp_generation: {
    firstName: "Coordinator",
    fullName: "AI Coordinator",
    role: "ICP Specialist",
    avatar: "/agent-avatars/icp.png",
    ringColor: "#b48cf2",
    bubbleClass: "bg-[#f1edff] dark:bg-[#1f1d3a]",
    displayName: "Coordinator",
    hireMessage: "Build an Ideal Customer Profile",
    shortLabel: "Coordinator",
    specialty: "ICP analysis",
    color: "bg-teal-500",
  },
  lead_generation: {
    firstName: "Marcus",
    fullName: "Marcus Johnson",
    role: "Lead Generation Specialist",
    avatar: "/agent-avatars/leadagent.png",
    ringColor: "#6ee7b7",
    bubbleClass: "bg-[#ecfdf5] dark:bg-[#162c2b]",
    displayName: "Lead Generation Specialist Marcus",
    hireMessage: "Generate leads with Marcus",
    shortLabel: "Lead Gen",
    specialty: "lead generation",
    color: "bg-emerald-500",
  },
  content_studio: {
    firstName: "Alex",
    fullName: "Alex Chen",
    role: "Content Creator",
    avatar: "/agent-avatars/content-studio.png",
    ringColor: "#fdba74",
    bubbleClass: "bg-[#fff1e6] dark:bg-[#2b2030]",
    displayName: "Content Creator Alex",
    hireMessage: "Create content with Alex",
    shortLabel: "Content",
    specialty: "content creation",
    color: "bg-purple-500",
  },
  outreach: {
    firstName: "Emily",
    fullName: "Emily Rodriguez",
    role: "Outreach Specialist",
    avatar: "/agent-avatars/outreach.png",
    ringColor: "#93c5fd",
    bubbleClass: "bg-[#eff6ff] dark:bg-[#18263d]",
    displayName: "Outreach Specialist Emily",
    hireMessage: "Start automated outreach with Emily",
    shortLabel: "Outreach",
    specialty: "outreach",
    color: "bg-blue-500",
  },
  performance_marketing: {
    firstName: "Sarah",
    fullName: "Sarah Martinez",
    role: "Performance Manager",
    avatar: "/agent-avatars/performance.png",
    ringColor: "#fca5a5",
    bubbleClass: "bg-[#fef2f2] dark:bg-[#2f1f2f]",
    displayName: "Performance Manager Sarah",
    hireMessage: "Optimize performance with Sarah",
    shortLabel: "Performance",
    specialty: "performance marketing",
    color: "bg-orange-500",
  },
};

// ── Pre-built Maps ─────────────────────────────────────────────────────────────

/** Short first-name labels: { orchestrator: "Orchestrator", lead_generation: "Marcus", ... } */
export const AGENT_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(PERSONAS).map(([k, p]) => [k, p.firstName]),
);

/** Avatar paths: { orchestrator: "/agent-avatars/Orchestrator.png", ... } */
export const AGENT_AVATARS: Record<string, string> = Object.fromEntries(
  Object.entries(PERSONAS).map(([k, p]) => [k, p.avatar]),
);

/** Ring colors for avatar borders */
export const AGENT_RING_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(PERSONAS).map(([k, p]) => [k, p.ringColor]),
);

/** Long display names: { lead_generation: "Lead Generation Specialist Marcus", ... } */
export const AGENT_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(PERSONAS).map(([k, p]) => [k, p.displayName]),
);

/** Full persona info: { name, avatar, ringColor } — for ChatThinkingBubble */
export const AGENT_AVATAR_INFO: Record<string, { name: string; avatar: string; ringColor: string }> = Object.fromEntries(
  Object.entries(PERSONAS).map(([k, p]) => [k, { name: p.firstName, avatar: p.avatar, ringColor: p.ringColor }]),
);

/** Agent definitions: { id, name, specialty, color, avatar } — for conversations page */
export const AGENT_DEFINITIONS: Record<string, { id: string; name: string; specialty: string; color: string; avatar: string }> = {
  orchestrator: { id: "orchestrator", name: PERSONAS.orchestrator.firstName, specialty: PERSONAS.orchestrator.specialty, color: PERSONAS.orchestrator.color, avatar: PERSONAS.orchestrator.avatar },
  lead_generation: { id: "lead-generation", name: PERSONAS.lead_generation.firstName, specialty: PERSONAS.lead_generation.specialty, color: PERSONAS.lead_generation.color, avatar: PERSONAS.lead_generation.avatar },
  content_studio: { id: "content-studio", name: PERSONAS.content_studio.firstName, specialty: PERSONAS.content_studio.specialty, color: PERSONAS.content_studio.color, avatar: PERSONAS.content_studio.avatar },
  performance_marketing: { id: "performance-marketing", name: PERSONAS.performance_marketing.firstName, specialty: PERSONAS.performance_marketing.specialty, color: PERSONAS.performance_marketing.color, avatar: PERSONAS.performance_marketing.avatar },
  outreach: { id: "outreach", name: PERSONAS.outreach.firstName, specialty: PERSONAS.outreach.specialty, color: PERSONAS.outreach.color, avatar: PERSONAS.outreach.avatar },
  icp_generation: { id: "icp", name: PERSONAS.icp_generation.firstName, specialty: PERSONAS.icp_generation.specialty, color: PERSONAS.icp_generation.color, avatar: PERSONAS.icp_generation.avatar },
};

/** Pipeline info: { name, avatar, ringColor, label } — for AgentChooseTab pipeline */
export const AGENT_PIPELINE_INFO: Record<string, { name: string; avatar: string; ringColor: string; label: string }> = {
  lead_generation: { name: PERSONAS.lead_generation.firstName, avatar: PERSONAS.lead_generation.avatar, ringColor: PERSONAS.lead_generation.ringColor, label: PERSONAS.lead_generation.shortLabel },
  content_studio: { name: PERSONAS.content_studio.firstName, avatar: PERSONAS.content_studio.avatar, ringColor: PERSONAS.content_studio.ringColor, label: PERSONAS.content_studio.shortLabel },
  outreach: { name: PERSONAS.outreach.firstName, avatar: PERSONAS.outreach.avatar, ringColor: PERSONAS.outreach.ringColor, label: PERSONAS.outreach.shortLabel },
  performance_marketing: { name: PERSONAS.performance_marketing.firstName, avatar: PERSONAS.performance_marketing.avatar, ringColor: PERSONAS.performance_marketing.ringColor, label: PERSONAS.performance_marketing.shortLabel },
};

/** Get persona data by agent type */
export function getPersona(agentType: AgentType | string): AgentPersona {
  return PERSONAS[agentType] || PERSONAS.orchestrator;
}
