import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';

const messages: Record<string,string> = {
  BILLING_CREDENTIAL_ENFORCED: 'Disable subscription enforcement before changing or disabling its Razorpay credential.',
  BILLING_CREDENTIAL_IDENTITY: 'This credential has provider plans, subscriptions or recharge orders. Create a new Razorpay credential before switching accounts or modes.',
  BILLING_CREDENTIAL_HISTORY: 'Retain this credential because subscription or recharge history references it. Disable it after switching billing safely.',
};
export class BillingCredentialError extends Error {
  readonly status=409;
  constructor(readonly code:string) { super(messages[code]); }
}
/** pg errors may be wrapped by Drizzle. Never surface SQL, values or secrets. */
export function normalizeBillingCredentialError(error:unknown):BillingCredentialError|null {
  let current=error;
  for(let depth=0;depth<5 && current && typeof current==='object';depth++) {
    if(current instanceof BillingCredentialError) return current;
    const value=current as {detail?:string;cause?:unknown};
    try {
      const code=JSON.parse(value.detail || '{}').code;
      if(Object.hasOwn(messages,code)) return new BillingCredentialError(code);
    } catch { /* Unrelated database error. */ }
    current=value.cause;
  }
  return null;
}
/** Friendly preflight; the database trigger is the authoritative race guard. */
export async function assertBillingCredentialMutation(credential:{id:number;platform:string;apiKey:string}, change:{apiKey?:string;apiSecret?:unknown;config?:unknown;isActive?:boolean;delete?:boolean}) {
  if(credential.platform!=='razorpay') return;
  const result=await db.execute(sql`SELECT enforced,credential_id,
    EXISTS(SELECT 1 FROM subscription_provider_plans WHERE credential_id=${credential.id})
      OR EXISTS(SELECT 1 FROM billing_subscriptions WHERE credential_id=${credential.id})
      OR EXISTS(SELECT 1 FROM wallet_recharge_order_origins WHERE credential_id=${credential.id}) AS referenced
    FROM subscription_settings WHERE id=1`);
  const state=result.rows[0];
  if(!state) throw new Error('Subscription settings unavailable');
  const sensitive=change.delete || change.apiKey!==undefined && change.apiKey!==credential.apiKey
    || change.apiSecret!==undefined || change.config!==undefined || change.isActive!==undefined;
  if(sensitive && state.enforced && Number(state.credential_id)===credential.id) throw new BillingCredentialError('BILLING_CREDENTIAL_ENFORCED');
  if(state.referenced && change.delete) throw new BillingCredentialError('BILLING_CREDENTIAL_HISTORY');
  if(state.referenced && change.apiKey!==undefined && change.apiKey!==credential.apiKey) throw new BillingCredentialError('BILLING_CREDENTIAL_IDENTITY');
}
