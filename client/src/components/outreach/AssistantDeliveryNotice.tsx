import Link from 'next/link';
import type { CustomerDeliveryReadiness } from '../../../../shared/customerDeliveryReadiness';

/**
 * `compact` is for the conversation view, where every line taken here is a line of
 * message history lost: a ready assistant is one line, and the sending account is
 * already shown in the thread header. A blocked assistant always shows in full.
 */
export function AssistantDeliveryNotice({ readiness, compact = false }: { readiness?: CustomerDeliveryReadiness; compact?: boolean }) {
  if (!readiness) return null;
  if (compact && readiness.ready)
    return <p className="truncate text-xs text-muted-foreground">
      Assistant: <span className="font-medium text-foreground">{readiness.assistantName || readiness.assistantId || 'Assigned'}</span>
      {' · '}
      <Link href={readiness.setupUrl} className="font-medium text-primary hover:underline">View</Link>
    </p>;
  return <div className="space-y-1 break-words text-xs" role={readiness.ready ? undefined : 'alert'}>
    <p>{readiness.ready ? readiness.assistantName || readiness.assistantId ? `Assigned assistant: ${readiness.assistantName || readiness.assistantId}.` : 'The assigned assistant is ready for this account.' : readiness.error || 'A published, active assistant must be assigned before customer delivery.'}</p>
    {(readiness.channel || readiness.accountId) && <p className="break-words text-muted-foreground">{[readiness.channel, readiness.accountId].filter(Boolean).join(' · ')}</p>}
    <Link href={readiness.setupUrl} className="inline-block font-medium text-primary underline">{readiness.ready ? 'View assigned assistant' : readiness.reason === 'unsupported_channel' ? 'View supported channels' : readiness.assistantId ? 'Review assigned assistant' : 'Set up required assistant'}</Link>
    {!readiness.ready && <Link href="/documentation/assistants#delivery-block" className="ml-3 inline-block text-primary underline">Documentation</Link>}
  </div>;
}
