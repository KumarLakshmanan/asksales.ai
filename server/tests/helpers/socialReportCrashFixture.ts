/** Child-process crash fixture: pauses before dispatch and never calls a provider. */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { createBusinessScopedPool } from '../../tenancy/scopedPool.js';
import { withBusinessScope } from '../../tenancy/businessContext.js';
import { processDueSocialReports } from '../../controllers/socialAnalyticsController.js';

const connectionString=process.env.SOCIAL_INSIGHTS_QA_DATABASE_URL;
const schema=process.env.SOCIAL_INSIGHTS_QA_SCHEMA;
const target=new URL(connectionString || 'http://invalid');
if(process.env.NODE_ENV!=='test' || !['127.0.0.1','localhost'].includes(target.hostname)
  || target.pathname!=='/social_insights_audit' || !schema || !/^social_insights_[a-f0-9]{16}$/.test(schema))
  throw new Error('Explicit isolated Social Insights crash fixture required');
const pool=new Pool({connectionString,max:1,options:`-c search_path=${schema},pg_catalog`});
const database=drizzle(createBusinessScopedPool(pool));
type Executor={execute:(query:SQL)=>Promise<unknown>};
async function execute(executor:Executor,query:SQL,atomic:boolean):Promise<unknown> {
  const statement=new PgDialect().sqlToQuery(query).sql;
  const afterExport=process.env.SOCIAL_INSIGHTS_QA_CRASH_AFTER_EXPORT==='1';
  if(afterExport ? statement.includes('UPDATE social_report_deliveries SET export_id=') : statement.includes('SELECT * FROM social_metric_snapshots')) {
    const result=await executor.execute(sql`SELECT pg_backend_pid() AS pid`) as {rows:Array<{pid:number}>};
    process.stdout.write(JSON.stringify({phase:'preparing',atomic,backendPid:result.rows[0].pid})+'\n');
    // Parent terminates this process to verify actual PostgreSQL rollback.
    await new Promise<void>(()=>{});
  }
  return executor.execute(query);
}
db.execute=(query:SQL)=>execute(database,query,false);
db.transaction=(work:(tx:Executor)=>Promise<unknown>)=>database.transaction(tx=>work({execute:(query:SQL)=>execute(tx,query,true)}));
globalThis.fetch=async()=>{throw new Error('External requests are disabled in the crash fixture');};
try {
  await withBusinessScope({userId:17,businessProfileId:1701},()=>processDueSocialReports(new Date('2026-10-23T09:00:15Z')));
  throw new Error('Crash fixture unexpectedly passed its preparation barrier');
} finally {await pool.end();}
