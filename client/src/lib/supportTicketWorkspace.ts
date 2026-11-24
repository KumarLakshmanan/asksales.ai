export type TicketStatus = "open" | "in_progress" | "waiting_on_customer" | "resolved" | "closed";

export interface SupportMemberTicket {
  id: number;
  ticketNumber: string;
  subject: string;
  description: string | null;
  status: TicketStatus;
  priority: "low" | "medium" | "high" | "urgent" | "critical";
  category: string | null;
  version: number;
  totalMessages: number;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
  slaDeadline: string | null;
  customerName: string | null;
  customerEmail: string | null;
  channel: string;
  conversationId: number | null;
  assignedMemberId: number | null;
  assignedMemberName: string | null;
  teamId: number | null;
  teamName: string | null;
  handoffId: number | null;
  handoffStatus: string | null;
  handoffReason: string | null;
  handoffTriggerType: string | null;
  handoffConfidenceScore: number | null;
  handoffSlaDeadline: string | null;
  handoffAssignedMemberId: number | null;
  ownershipMode: "ai_active" | "human_owned" | string;
  aiReplyEnabled: boolean;
  claimable: boolean;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
}

export interface SupportTeamMemberOption {
  id: number;
  name: string;
  email: string | null;
  role: string;
  teamId: number;
}

export const SUPPORT_MEMBER_PIPELINE_STAGES: Array<{ key: TicketStatus; label: string; tone: string }> = [
  { key: "open", label: "Open", tone: "bg-info" },
  { key: "in_progress", label: "In progress", tone: "bg-warning" },
  { key: "waiting_on_customer", label: "Waiting", tone: "bg-primary" },
  { key: "resolved", label: "Resolved", tone: "bg-success" },
  { key: "closed", label: "Closed", tone: "bg-muted-foreground/60" },
];

interface SupportOwnershipSnapshot {
  handoffId?: number | null;
  handoffAssignedMemberId?: number | null;
  ownershipMode: string;
  aiReplyEnabled?: boolean;
}

export const SUPPORT_AI_READINESS_NOTICE = 'Ownership does not verify AI reply readiness. Replies require an enabled runtime and a ready, published assistant assigned to the account.';

/** These labels describe handoff ownership only, never delivery capability. */
export function supportOwnershipLabel(ticket: SupportOwnershipSnapshot) {
  if (ticket.handoffId && !ticket.handoffAssignedMemberId) return "Needs human";
  if (ticket.handoffId || ["human_owned", "manual"].includes(ticket.ownershipMode)) return "Human owned";
  return ticket.ownershipMode === 'ai_active' ? 'No human takeover' : 'Ownership unverified';
}

export function supportHandoffDescription(ticket: SupportOwnershipSnapshot) {
  if (ticket.handoffId) return ticket.aiReplyEnabled === true
    ? 'This handoff permits limited AI assistance while ticket decisions remain with the support team.'
    : 'This handoff pauses AI replies.';
  if (["human_owned", "manual"].includes(ticket.ownershipMode)) return 'Future messages remain with the support team.';
  return ticket.ownershipMode === 'ai_active'
    ? 'There is no human takeover on this conversation.'
    : 'Conversation ownership has not been verified.';
}

export function isSlaBreached(ticket: SupportMemberTicket) {
  return Boolean(ticket.slaDeadline && !["resolved", "closed"].includes(ticket.status) && new Date(ticket.slaDeadline) < new Date());
}

/** Current ownership is independent of whether the ticket began as an AI handoff. */
export function supportOwnershipStage(ticket: {
  status: string;
  ownershipMode: string;
  handoffId?: number | null;
  handoffAssignedMemberId?: number | null;
  assignedMemberId?: number | null;
}): 'ai' | 'requested' | 'claimed' | 'resolved' {
  if (["resolved", "closed"].includes(ticket.status)) return 'resolved';
  if (ticket.handoffId) return ticket.handoffAssignedMemberId ? 'claimed' : 'requested';
  if (["human_owned", "manual"].includes(ticket.ownershipMode)) {
    return ticket.assignedMemberId ? 'claimed' : 'requested';
  }
  return 'ai';
}
