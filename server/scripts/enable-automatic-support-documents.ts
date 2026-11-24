/** Tenant-scoped rollout; read-only by default. No global template propagation. */
import '../env.js';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { automaticHospitalityDocuments } from '../services/agents/orchestration/AutomaticDocumentPlaybook.js';
import { validatePlaybookGraph } from '../services/agents/orchestration/PlaybookEngine.js';
import { PROPOSAL_SUPPORT_TOOLS } from '../services/agents/orchestration/ProposalSupportConfiguration.js';
const [userId, playbookId, expectedVersion] = process.argv.slice(2,5).map(Number);
if (![userId,playbookId,expectedVersion].every(value => Number.isSafeInteger(value) && value > 0)) {
  throw new Error('Usage: enable-automatic-support-documents OWNER PLAYBOOK EXPECTED_VERSION [--apply]');
}
const apply = process.argv.includes('--apply');
const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME || process.env.DB_DATABASE,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
const client = await pool.connect();
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  if (apply) { await client.query('SELECT pg_advisory_xact_lock(20260813,$1)',[userId]); await client.query('SELECT pg_advisory_xact_lock($1)',[playbookId]); }
  const { rows: [row] } = await client.query(`SELECT p.*,v.graph FROM support_playbooks p
    JOIN support_playbook_versions v ON v.playbook_id=p.id AND v.version=p.active_version
    WHERE p.user_id=$1 AND p.id=$2 ${apply ? 'FOR UPDATE OF p' : ''}`,[userId,playbookId]);
  if (!row || row.agent_type !== 'hotel_sales' || row.status !== 'published' || !row.enabled
    || row.template_key !== 'hospitality-sales-enquiries-v2' || row.active_version !== expectedVersion
    || JSON.stringify(row.graph) !== JSON.stringify(row.draft_graph)) throw new Error('Ownership, version or unchanged-draft guard failed.');
  const { rows: agents } = await client.query('SELECT id,agent_type,tools_enabled FROM ai_agent_configs WHERE user_id=$1 AND enabled',[userId]);
  if (agents.length !== 1 || agents[0].agent_type !== 'hotel_sales' || !Array.isArray(agents[0].tools_enabled)) throw new Error('Unexpected active support specialist.');
  const { rows: proposals } = await client.query(`SELECT p.id,p.enabled,p.active_version,p.draft_graph,v.graph,a.intent,a.enabled AS assigned
    FROM support_playbooks p JOIN support_playbook_versions v ON v.playbook_id=p.id AND v.version=p.active_version
    JOIN support_playbook_assignments a ON a.playbook_id=p.id AND a.user_id=p.user_id
    WHERE p.user_id=$1 AND p.agent_type='hotel_sales' AND p.status='published'
      AND a.agent_type='hotel_sales' AND a.channel IS NULL
      AND a.intent IN ('proposal_request','proposal_status','proposal_revision')`,[userId]);
  if (proposals.length !== 3 || new Set(proposals.map(row => row.intent)).size !== 3
    || proposals.some(row => !row.assigned || JSON.stringify(row.graph) !== JSON.stringify(row.draft_graph)
      || validatePlaybookGraph(row.graph).length)) throw new Error('Proposal journey ownership, assignments or unchanged-draft guard failed.');
  const graph = automaticHospitalityDocuments(row.graph);
  graph.metadata = { ...graph.metadata, systemDefault: false };
  const errors = validatePlaybookGraph(graph);
  if (errors.length) throw new Error(`Invalid upgraded graph: ${errors.join('; ')}`);
  const version = Number((await client.query('SELECT COALESCE(MAX(version),0)+1 AS version FROM support_playbook_versions WHERE playbook_id=$1',[playbookId])).rows[0].version);
  const checksum = createHash('sha256').update(JSON.stringify(graph)).digest('hex');
  const tools = [...new Set([...agents[0].tools_enabled,...PROPOSAL_SUPPORT_TOOLS])];
  const summary = { userId,playbookId,previousVersion:expectedVersion,version,checksum,
    documentNodes:['answer-resort-details','answer-day-outing'],proposalPlaybooks:proposals.map(row => row.id),
    addedTools:tools.filter(tool => !agents[0].tools_enabled.includes(tool)),sellerReviewRequired:true };
  if (apply) {
    await client.query(`INSERT INTO support_playbook_versions(playbook_id,version,graph,checksum,published_by,published_at)
      VALUES($1,$2,$3::jsonb,$4,$5,NOW())`,[playbookId,version,JSON.stringify(graph),checksum,userId]);
    await client.query(`UPDATE support_playbooks SET draft_graph=$3::jsonb,active_version=$4,template_mode='customized',updated_at=NOW()
      WHERE user_id=$1 AND id=$2`,[userId,playbookId,JSON.stringify(graph),version]);
    await client.query('UPDATE support_playbooks SET enabled=true,updated_at=NOW() WHERE user_id=$1 AND id=ANY($2::integer[])',[userId,proposals.map(row=>row.id)]);
    await client.query('UPDATE ai_agent_configs SET tools_enabled=$3::jsonb,updated_at=NOW() WHERE user_id=$1 AND id=$2',[userId,agents[0].id,JSON.stringify(tools)]);
    await client.query(`INSERT INTO support_admin_audit_logs(user_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,metadata)
      VALUES($1,'owner',$1,'playbook.publish','support_playbook',$2,$3::jsonb,$4::jsonb,$5::jsonb)`,
    [userId,String(playbookId),JSON.stringify({ activeVersion:expectedVersion,tools:agents[0].tools_enabled,
      proposalPlaybooks:proposals.map(row=>({id:row.id,enabled:row.enabled})) }),JSON.stringify(summary),
      JSON.stringify({ reason:'User requested automatic document discovery and proposal-agent drafts; sender approval remains required.' })]);
  }
  await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ applied:apply,...summary }));
} catch(error) { await client.query('ROLLBACK'); throw error; }
finally { client.release(); await pool.end(); }
process.exit(0);
