import dotenv from 'dotenv';
dotenv.config();
import { db } from '../models/db.js';
import { sql } from 'drizzle-orm';

async function run() {
  const result = await db.execute(sql`
    SELECT id, conversation_id, direction, content, status, sent_at, metadata
    FROM outreach_messages
    ORDER BY id DESC
    LIMIT 20
  `);
  console.log("Recent outreach messages:");
  console.log(JSON.stringify(result.rows, null, 2));
  
  // Let's also check handoff_queue and agent_audit_logs to see if anything is there
  try {
    const queue = await db.execute(sql`
      SELECT id, conversation_id, status, priority, reason, trigger_type, created_at
      FROM handoff_queue
      ORDER BY id DESC
      LIMIT 10
    `);
    console.log("\nRecent handoff queue items:");
    console.log(JSON.stringify(queue.rows, null, 2));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    console.error("Handoff queue query failed:", e.message);
  }

  try {
    const logs = await db.execute(sql`
      SELECT id, conversation_id, intent, risk_level, outcome, reply_text, duration_ms, created_at
      FROM agent_audit_logs
      ORDER BY id DESC
      LIMIT 10
    `);
    console.log("\nRecent agent audit logs:");
    console.log(JSON.stringify(logs.rows, null, 2));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    console.error("Agent audit logs query failed:", e.message);
  }

  process.exit(0);
}

run().catch(console.error);
