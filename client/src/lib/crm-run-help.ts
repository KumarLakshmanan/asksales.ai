export interface CrmRunHelp { title: string; description: string; action?: string; href?: string }

/** Give a safe next action without echoing credentials or raw provider payloads. */
export function crmRunHelp(message?: string | null, status?: string): CrmRunHelp {
  const text = (message || '').toLowerCase();
  if (status === 'uncertain' || /reconcil|unknown outcome|dispatch began|acceptance/.test(text)) return {
    title: 'Delivery needs review', description: 'Remaining actions are held because the provider may already have accepted the message. Check the conversation and provider delivery history before sending again.',
  };
  if (/balance|credit|wallet|subscription/.test(text)) return { title: 'Sending balance or subscription needs attention', description: 'Review your billing status before expecting another delivery.', action: 'Review billing', href: '/dashboard/billing' };
  if (/rate limit|throttl|too many|temporar|timeout/.test(text) || status === 'retry') return {
    title: 'Waiting to try again', description: status === 'retry' ? 'The system has scheduled another attempt. Completed actions are retained; allow this run to finish before starting another send.' : 'Check the sender limit and provider availability. Review the run status before sending again.',
  };
  if (/template|approved|language|variable/.test(text)) return { title: 'Message template needs attention', description: 'Review the selected template, its approval, language, and required values. Test the saved rule after correcting it.', action: 'Review connections', href: '/dashboard/integrations' };
  if (/account|connect|authoriz|token|credential|sender|permission/.test(text)) return { title: 'Sending connection needs attention', description: 'Check the connection and sender permissions, then test the rule before its next matching event.', action: 'Review connections', href: '/dashboard/integrations' };
  if (/recipient|email|phone|contact|lead/.test(text)) return { title: 'Contact details need attention', description: 'Review the linked contact, recipient address, and lead association before sending again.' };
  if (/stage|pipeline|member|assign/.test(text)) return { title: 'Rule references need attention', description: 'Review the selected stage or workspace member, then test the rule with a matching event.' };
  if (status === 'cancelled' || /paused|deleted/.test(text)) return { title: 'Run stopped', description: 'The rule was paused or removed. Previously completed actions remain recorded.' };
  if (status === 'skipped') return { title: 'No action required', description: 'This event did not match the saved rule conditions, or the rule was unavailable when the event was processed.' };
  return { title: 'Action needs review', description: 'Review the failed step and saved rule, check the related contact or connection, then use Test to preview the corrected rule.' };
}
