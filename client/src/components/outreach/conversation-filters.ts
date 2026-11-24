export type ConversationStatusFilter = 'all' | 'open' | 'completed' | 'read' | 'unread';
export type ConversationDateFilter = 'all' | 'today' | '7days' | '30days' | 'custom';

export interface ConversationFilters {
  status: ConversationStatusFilter;
  date: ConversationDateFilter;
  from: string;
  to: string;
}

export const DEFAULT_CONVERSATION_FILTERS: ConversationFilters = {
  status: 'all', date: 'all', from: '', to: '',
};

function istDateParts(date: Date): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return [value('year'), value('month'), value('day')];
}

function istDay(date: Date): number {
  const [year, month, day] = istDateParts(date);
  return Date.UTC(year, month - 1, day);
}

function dateAtIstMidnight(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - 330 * 60_000).toISOString();
}

export function conversationFilterQuery(filters: ConversationFilters, now = new Date()): string {
  const params = new URLSearchParams();
  if (filters.status !== 'all') params.set('status', filters.status);

  let from = filters.from;
  let to = filters.to;
  if (filters.date !== 'custom' && filters.date !== 'all') {
    const days = filters.date === 'today' ? 1 : filters.date === '7days' ? 7 : 30;
    const today = istDay(now);
    from = new Date(today - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    to = new Date(today).toISOString().slice(0, 10);
  }
  if (filters.date !== 'all') {
    if (from) params.set('dateFrom', dateAtIstMidnight(from));
    if (to) {
      const next = new Date(`${to}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      params.set('dateTo', dateAtIstMidnight(next.toISOString().slice(0, 10)));
    }
  }
  return params.toString();
}
