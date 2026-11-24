/** Deliberate global CRM automation cutover. Status is read-only; changes require --apply. */
import '../env.js';
import {Pool} from 'pg';

const command=process.argv[2] || 'status';
const apply=process.argv.includes('--apply');
if (!['status','enable','disable'].includes(command) || (command!=='status' && !apply)) {
  throw new Error('Usage: tsx scripts/crm-automation-cutover.ts status | enable --apply | disable --apply');
}
const pool=new Pool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT || 5432),user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,database:process.env.DB_NAME || process.env.DB_DATABASE,
  ssl:process.env.DB_SSL==='true' ? {rejectUnauthorized:true} : undefined});
const client=await pool.connect();
try {
  await client.query(command==='status' ? 'BEGIN READ ONLY' : 'BEGIN');
  const schema=await client.query("SELECT to_regclass('crm_automation_runtime') AS runtime,to_regclass('crm_automation_events') AS events,to_regclass('crm_automation_run_steps') AS steps");
  if (!schema.rows[0]?.runtime || !schema.rows[0]?.events || !schema.rows[0]?.steps) throw new Error('Apply migration 314 before using the CRM automation cutover.');
  if (command!=='status') {
    await client.query('SELECT id FROM crm_automation_runtime WHERE id=1 FOR UPDATE');
    if (command==='enable') {
      const changed=await client.query(`UPDATE crm_automation_runtime SET enabled=true,cutover_at=COALESCE(cutover_at,now()),updated_at=now()
        WHERE id=1 RETURNING cutover_at`);
      // Activity captured before the first cutover is never replayed into the new engine.
      await client.query(`UPDATE crm_automation_events SET status='cancelled',lease_token=NULL
        WHERE status IN ('pending','queued') AND occurred_at < $1`,[changed.rows[0].cutover_at]);
    } else await client.query('UPDATE crm_automation_runtime SET enabled=false,updated_at=now() WHERE id=1');
  }
  const state=(await client.query('SELECT enabled,cutover_at,updated_at FROM crm_automation_runtime WHERE id=1')).rows[0];
  const events=(await client.query(`SELECT status,count(*)::int AS count FROM crm_automation_events GROUP BY status ORDER BY status`)).rows;
  const runs=(await client.query(`SELECT status,count(*)::int AS count FROM crm_automation_runs GROUP BY status ORDER BY status`)).rows;
  const steps=(await client.query(`SELECT status,count(*)::int AS count FROM crm_automation_run_steps GROUP BY status ORDER BY status`)).rows;
  const pending=(await client.query(`SELECT EXTRACT(EPOCH FROM now()-MIN(created_at))::int AS oldest_seconds
    FROM crm_automation_events WHERE status IN ('pending','queued','processing')`)).rows[0]?.oldest_seconds;
  await client.query(command==='status' ? 'ROLLBACK' : 'COMMIT');
  console.log(JSON.stringify({command,enabled:state.enabled,cutoverAt:state.cutover_at,updatedAt:state.updated_at,
    oldestPendingSeconds:pending,events,runs,steps},null,2));
} catch(error) {await client.query('ROLLBACK');throw error;}
finally {client.release();await pool.end();}
