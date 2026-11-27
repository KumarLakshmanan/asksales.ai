/**
 * Every sending account is linked to one outreach assistant that answers the
 * replies it receives. The agent used to read a linked assistant with another
 * name ("Hotel Sales Agent") as a reason not to use a ready account. These
 * notes say what the link means and where to change it, in plain words.
 */
interface AccountForNote {
  label?: string | null;
  email?: string | null;
  ready?: boolean;
  reason?: string | null;
  assistant?: { ready?: boolean; assistantName?: string | null; setupUrl?: string | null } | null;
}

const SETTINGS_URL = '/dashboard/settings/outreach';

export function sendingAccountNotes(accounts: AccountForNote[] | null | undefined): string[] {
  return (accounts || []).slice(0, 20).map((account) => {
    const name = account.label || account.email || 'This account';
    const assistant = account.assistant;
    const link = assistant?.setupUrl || SETTINGS_URL;
    if (account.ready && assistant?.assistantName) {
      return `${name} is ready to send. Replies to it are answered by the "${assistant.assistantName}" assistant; that does not stop it being used for this campaign. To change which assistant answers, open ${SETTINGS_URL}.`;
    }
    if (account.ready) return `${name} is ready to send.`;
    return `${name} can't send yet: ${account.reason || 'it needs setup'} Fix it at ${assistant?.assistantName ? link : SETTINGS_URL}.`;
  });
}
