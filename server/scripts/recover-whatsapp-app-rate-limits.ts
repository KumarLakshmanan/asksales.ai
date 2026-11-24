/** Explicit IDs only. Defaults to a rolled-back dry run; --apply plans recovery
 * on the original records. The normal business poll dispatches deterministic jobs.
 */
import { db, pgPool } from '../models/db.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { planWhatsAppAppRateLimitRecovery } from '../services/outreach/WhatsAppProviderRetry.js';

const args=process.argv.slice(2);
const value=(name:string)=>args[args.indexOf(name)+1];
const userId=Number(value('--user-id')),businessProfileId=Number(value('--business-profile-id'));
const messageIds=String(value('--message-ids')||'').split(',').map(Number);
if(!args.includes('--user-id')||!args.includes('--business-profile-id')||!args.includes('--message-ids')
  ||![userId,businessProfileId,...messageIds].every(id=>Number.isSafeInteger(id)&&id>0))
  throw new Error('Use --user-id N --business-profile-id N --message-ids ID,ID [--apply]');
const apply=args.includes('--apply');
const rollback=new Error('dry-run rollback');
let recovered:unknown[]=[];
try {
  await withBusinessScope({userId,businessProfileId},()=>db.transaction(async(tx:typeof db)=>{
    recovered=await planWhatsAppAppRateLimitRecovery(tx,userId,messageIds);
    if(!apply)throw rollback;
  }));
} catch(error) {
  if(error!==rollback)throw error;
} finally {
  await pgPool?.end();
}
console.log(JSON.stringify({dryRun:!apply,eligible:recovered.length,recovered}));
