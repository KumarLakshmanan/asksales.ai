export interface Contact {
  automationReviewRequired?: boolean;
  refreshRequired?: boolean;
  id: number;
  leadId: number | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  company: string | null;
  role: string | null;
  status: string;
  pipelineStatus: string;
  lastSentimentStatus: string | null;
  priority: string;
  source: string;
  assignedTo?: number | null;
  nextFollowUpAt?: string | null;
  website?: string | null;
  linkedinUrl?: string | null;
  dealValue: string | null;
  currency: string;
  sentimentScore: number | null;
  fitScore: number | null;
  totalOutreachSent: number;
  tags: string[];
  notes: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrmActivity {
  id: number;
  type: string;
  subject: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface OutreachMessage {
  messageKind?: string;
  followUpStep?: number | null;
  id: number;
  conversationId: number;
  direction: string;
  subject: string | null;
  content: string;
  htmlContent: string | null;
  status: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  isAiGenerated: boolean | null;
  manualReviewRequired?: boolean;
  deliveryError?: string | null;
  createdAt: string;
}

export interface OutreachConversation {
  id: number;
  channel: string;
  integrationProvider: string | null;
  leadName: string | null;
  leadEmail: string | null;
  status: string;
  subject?: string | null;
  lastMessageAt: string | null;
  lastMessageBy: string | null;
  lastMessagePreview: string | null;
  totalMessages: number | null;
  unreadCount: number | null;
  createdAt: string;
  messages: OutreachMessage[];
  messageTotal?: number;
  messagesHasMore?: boolean;
  providerAccountId?: string | number | null;
  providerAccountName?: string | null;
}

export interface SentMessage {
  id: number;
  channel: string;
  subject: string | null;
  message: string;
  leadName: string | null;
  deliveryStatus: string | null;
  followUpStep?: number | null;
  sentiment: string | null;
  sentimentConfidence: string | null;
  replyContent: string | null;
  replyReceivedAt: string | null;
  createdAt: string;
}

export interface TicketMessage {
  id: number;
  ticketId: number;
  userId: number;
  direction: string;
  content: string;
  isInternal: boolean | null;
  attachments: Array<{ name: string; url: string; type: string }> | null;
  createdAt: string;
}

export interface SupportTicket {
  id: number;
  ticketNumber: string;
  subject: string;
  description: string | null;
  status: string;
  priority: string;
  category: string | null;
  slaDeadline: string | null;
  resolvedAt: string | null;
  responseTime: number | null;
  totalMessages: number | null;
  unreadCount: number | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  messages: TicketMessage[];
  slaStatus: "breached" | "at_risk" | "healthy" | "no_sla";
  hoursRemaining: number | null;
  assignee?: { id: number; name: string; email?: string } | null;
  latestReply?: { content: string; createdAt: string; direction?: string } | null;
}

export interface CrmPagination { page: number; limit: number; total: number; totalPages: number; hasMore?: boolean; nextBeforeMessageId?: number | null; }
export interface CrmAssignee { id: number; name: string; email: string; role?: string; }
export interface CrmWorkspaceSummary {
  counts: { conversations: number; sentMessages: number; activities: number; tickets: number; openTickets: number; unreadConversations: number };
  owner: CrmAssignee | null;
  nextReminder: { id: number; title: string; dueDate: string; status: string; assignedTo?: number | null } | null;
  upcomingReminders: Array<{ id: number; title: string; dueDate: string; status: string }>;
  ticketsDue: Array<{ id: number; ticketNumber: string; subject: string; slaDeadline: string }>;
  unansweredConversations: Array<{ id: number; channel: string; subject?: string; lastMessageAt: string }>;
  stageEnteredAt?: string | null;
}
export interface CrmTimelineItem {
  id: string | number; kind: string; type: string; subject: string | null; body: string | null; createdAt: string;
  actor: { id: number | null; name: string } | null;
  related: { url: string; label: string } | null;
  metadata?: Record<string, unknown> | null;
}
export type CrmHistoryTab = 'conversations' | 'sent-messages' | 'activity' | 'timeline' | 'tickets';
export interface CrmHistoryFilters { search: string; channel: string; unread: boolean; type: string; status: string; from: string; to: string; page: number; }
export const EMPTY_HISTORY_FILTERS: CrmHistoryFilters = { search: '', channel: 'all', unread: false, type: 'all', status: 'all', from: '', to: '', page: 1 };
export function contactDisplayName(contact: Pick<Contact, 'firstName' | 'lastName' | 'email' | 'phone'>) {
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || contact.phone || 'Unnamed contact';
}
export function historyQuery(filters: CrmHistoryFilters, tab: CrmHistoryTab): URLSearchParams {
  const q = new URLSearchParams({page: String(filters.page), limit: '20'});
  if (filters.search.trim()) q.set('search', filters.search.trim());
  if (filters.from) q.set('from', new Date(filters.from+'T00:00:00').toISOString());
  if (filters.to) {
    const end = new Date(filters.to+'T00:00:00');
    end.setDate(end.getDate()+1);
    q.set('to', end.toISOString());
  }
  if (tab === 'conversations' || tab === 'sent-messages') {
    if (filters.channel !== 'all') q.set('channel', filters.channel);
    if (tab === 'conversations' && filters.unread) q.set('unread', 'true');
    q.set('messageLimit', '20');
    if (tab === 'sent-messages') { q.set('view', 'sent'); q.set('sentPage', String(filters.page)); q.set('sentLimit', '20'); }
    else { q.set('view', 'conversations'); q.set('sentLimit', '1'); }
  }
  if ((tab === 'activity' || tab === 'timeline') && filters.type !== 'all') q.set('type', filters.type);
  if (tab === 'tickets' && filters.status !== 'all') q.set('status', filters.status);
  return q;
}
