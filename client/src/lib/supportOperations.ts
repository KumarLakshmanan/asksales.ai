export interface TicketPipeline {
  open: number;
  inProgress: number;
  waitingOnCustomer: number;
  resolved: number;
  closed: number;
  total: number;
}

export interface SupportTeamMember {
  id: number;
  teamId: number;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  isOnCall: boolean;
  presenceState?: "active" | "away";
  lastSeenAt?: string | null;
  unrepliedWorkload?: number;
  projectedResponseMinutes?: number;
  ticketPipeline?: TicketPipeline;
  createdAt: string;
}

export interface SupportTeam {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  isActive: boolean;
  members: SupportTeamMember[];
  ticketPipeline?: TicketPipeline;
}

export interface SupportOperationsTicket {
  id: number;
  ticketNumber: string;
  subject: string;
  description: string | null;
  status: "open" | "in_progress" | "waiting_on_customer" | "resolved" | "closed";
  priority: string;
  category: string | null;
  teamId: number | null;
  assignedMemberId: number | null;
  assignedMemberName?: string | null;
  customerName?: string | null;
  totalMessages: number;
  unreadCount: number;
  operationalUnreadCount?: number;
  lastMessagePreview?: string | null;
  lastMessageAt?: string | null;
  slaDeadline: string | null;
  createdAt: string;
  updatedAt: string;
}

export const SUPPORT_PIPELINE_STAGES = [
  { key: "open" as const, label: "Open", tone: "bg-info", soft: "bg-info/10 text-info" },
  { key: "in_progress" as const, label: "In progress", tone: "bg-warning", soft: "bg-warning/10 text-warning" },
  { key: "waiting_on_customer" as const, label: "Waiting", tone: "bg-primary", soft: "bg-primary/10 text-primary" },
  { key: "resolved" as const, label: "Resolved", tone: "bg-success", soft: "bg-success/10 text-success" },
  { key: "closed" as const, label: "Closed", tone: "bg-muted-foreground/60", soft: "bg-muted text-muted-foreground" },
];

export function formatSupportDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

export function memberRoute(teamId: number | string, memberId: number | string) {
  return `/dashboard/support/teams/${teamId}/members/${memberId}`;
}
