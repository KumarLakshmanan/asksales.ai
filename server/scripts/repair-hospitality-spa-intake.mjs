/** Scoped immutable publication; defaults to a read-only preview. */
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
const [userId, playbookId, expectedVersion] = process.argv.slice(2, 5).map(Number);
if (![userId, playbookId, expectedVersion].every(value => Number.isSafeInteger(value) && value > 0)) {
  throw new Error('Usage: repair-hospitality-spa-intake OWNER PLAYBOOK EXPECTED_VERSION [--apply]');
}
const apply = process.argv.includes('--apply');
const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || process.env.DB_DATABASE, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  if (apply) {
    await client.query('SELECT pg_advisory_xact_lock(20260813,$1)', [userId]);
    await client.query('SELECT pg_advisory_xact_lock($1)', [playbookId]);
  }
  const { rows: [row] } = await client.query(`SELECT p.*,v.graph FROM support_playbooks p
    JOIN support_playbook_versions v ON v.playbook_id=p.id AND v.version=p.active_version
    WHERE p.user_id=$1 AND p.id=$2 ${apply ? 'FOR UPDATE OF p' : ''}`, [userId, playbookId]);
  if (!row || row.agent_type !== 'hotel_sales' || row.status !== 'published' || !row.enabled
    || row.template_key !== 'hospitality-sales-enquiries-v2' || row.active_version !== expectedVersion
    || JSON.stringify(row.graph) !== JSON.stringify(row.draft_graph)) throw new Error('Version, ownership, or unchanged-draft guard failed.');
  const active = await client.query('SELECT agent_type FROM ai_agent_configs WHERE user_id=$1 AND enabled', [userId]);
  if (active.rowCount !== 1 || active.rows[0].agent_type !== 'hotel_sales') throw new Error('Hospitality must remain the active specialist.');
  const graph = structuredClone(row.graph);
  const fieldKeys = ['service.dateTime', 'contact.fullName', 'callback.preferredTime', 'callback.consent'];
  const branch = graph.edges.filter(edge => edge.source === 'collect-spa-next'
    && edge.condition?.operator === 'field_equals' && edge.condition.field === 'spa.nextStep' && edge.condition.value === 'book');
  const original = graph.nodes.find(node => node.id === 'collect-service-request');
  const inquiry = graph.nodes.find(node => node.id === 'create-service-inquiry');
  const outgoing = graph.edges.filter(edge => edge.source === original?.id);
  if (graph.schemaVersion !== 2 || graph.metadata?.templateKey !== row.template_key
    || branch.length !== 1 || branch[0].target !== original?.id || original?.type !== 'collect'
    || inquiry?.data?.capabilityName !== 'inquiry.create'
    || outgoing.length !== 1 || outgoing[0].target !== inquiry.id
    || outgoing[0].condition?.operator !== 'all_required_fields_present'
    || graph.nodes.some(node => node.id === 'collect-spa-request')
    || !fieldKeys.every(key => original.data.fieldKeys.includes(key) && graph.fields.some(field => field.key === key && field.required))) {
    throw new Error('Unexpected spa intake graph; refusing publication.');
  }
  graph.nodes.push({ id: 'collect-spa-request', type: 'collect',
    data: { ...structuredClone(original.data), label: 'Spa slot request', fieldKeys }, position: { x: 1300, y: 540 } });
  branch[0].target = 'collect-spa-request';
  graph.edges.push({ ...structuredClone(outgoing[0]), source: 'collect-spa-request' });
  graph.metadata = { ...graph.metadata, systemDefault: false };
  const version = Number((await client.query('SELECT COALESCE(MAX(version),0)+1 AS version FROM support_playbook_versions WHERE playbook_id=$1', [playbookId])).rows[0].version);
  const checksum = createHash('sha256').update(JSON.stringify(graph)).digest('hex');
  const changes = { newNode: 'collect-spa-request', spaBookTarget: 'collect-spa-request', fieldKeys,
    preserved: 'All other branches, capabilities, controls and immutable running versions' };
  if (apply) {
    await client.query(`INSERT INTO support_playbook_versions(playbook_id,version,graph,checksum,published_by,published_at)
      VALUES($1,$2,$3::jsonb,$4,$5,NOW())`, [playbookId, version, JSON.stringify(graph), checksum, userId]);
    await client.query(`UPDATE support_playbooks SET draft_graph=$3::jsonb,active_version=$4,template_mode='customized',updated_at=NOW()
      WHERE user_id=$1 AND id=$2`, [userId, playbookId, JSON.stringify(graph), version]);
    await client.query(`INSERT INTO support_admin_audit_logs(user_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,metadata)
      VALUES($1,'owner',$1,'playbook.publish','support_playbook',$2,$3::jsonb,$4::jsonb,$5::jsonb)`,
    [userId, String(playbookId), JSON.stringify({ activeVersion: expectedVersion }),
      JSON.stringify({ activeVersion: version, templateMode: 'customized', checksum }),
      JSON.stringify({ reason: 'Oro Circle screenshot regression: dedicated spa intake excludes room/event and guest-count questions.', changes })]);
  }
  await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ applied: apply, userId, playbookId, previousVersion: expectedVersion, version, checksum, changes }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { client.release(); await pool.end(); }
