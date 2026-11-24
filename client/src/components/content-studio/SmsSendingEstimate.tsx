"use client";
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';

export function SmsSendingEstimate() {
  const query = useQuery({
    queryKey: ['content-generation-estimates', 8, '720p', '1K'],
    queryFn: () => api.get<{ sms?: { creditsPerMessage: number; basis: string } }>('/api/content/studio/estimates?duration=8&resolution=720p&imageSize=1K'),
    staleTime: 60_000, retry: false,
  });
  const fee = query.data?.sms?.creditsPerMessage;
  return <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground" aria-label="SMS sending estimate">
    <p className="font-medium text-foreground">Sending cost is separate from generation</p>
    <p className="mt-1">{typeof fee === 'number' ? `AskSales outreach fee: ${fee} ${fee === 1 ? 'credit' : 'credits'} per message.` : query.isPending ? 'Loading configured outreach fee…' : 'Configured outreach fee unavailable.'} Carrier/provider pricing is not quoted here. Check destination rates with your sending provider before launching a campaign. Encoding, opt-out text and resolved variables can increase billed segments.</p>
  </div>;
}
