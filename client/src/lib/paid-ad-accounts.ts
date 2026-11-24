export interface PaidAdAccountIdentity {
  id: number;
  platform: string;
  name: string;
  provider_account_id?: string;
}

/** Provider names are not unique; retain the account identity in each chooser. */
export function paidAdAccountNames(accounts: PaidAdAccountIdentity[]) {
  const nameKey = (account: PaidAdAccountIdentity) => `${account.platform}:${account.name.trim().toLowerCase()}`;
  const counts = new Map<string, number>();
  for (const account of accounts) counts.set(nameKey(account), (counts.get(nameKey(account)) || 0) + 1);
  return new Map(accounts.map(account => [account.id, (counts.get(nameKey(account)) || 0) > 1
    ? `${account.name} · ${account.provider_account_id ? `ID ${account.provider_account_id.replace(/^act_/, '')}` : `Account #${account.id}`}`
    : account.name]));
}
