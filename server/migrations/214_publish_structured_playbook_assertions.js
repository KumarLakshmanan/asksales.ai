import crypto from 'node:crypto';

const assertionsByTemplate = {
  'hotel-availability-booking-v1': {
    'present-verified-options': [{ type: 'has_supported_claims' }],
  },
  'hotel-reservation-payment-safety-v1': {
    'verified-reservation-next-step': [{ type: 'has_supported_claims' }],
  },
  'technical-troubleshooting-v1': {
    'provide-grounded-steps': [
      { type: 'grounding_is', value: 'grounded' },
      { type: 'has_supported_claims' },
    ],
  },
  'technical-ticket-status-v1': {
    'report-ticket-status': [
      { type: 'tool_succeeded', tool: 'get_ticket_status' },
      { type: 'has_supported_claims' },
    ],
  },
};

function updatedGraph(graph, version, assertions) {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => assertions[node.id]
      ? { ...node, data: { ...(node.data || {}), assertions: assertions[node.id] } }
      : node),
    metadata: { ...(graph.metadata || {}), templateVersion: version },
  };
}

/** Publish structured compliance assertions to every still-admin-managed copy.
 * Customized tenant playbooks are deliberately left untouched. */
export async function up(client) {
  for (const [templateKey, assertions] of Object.entries(assertionsByTemplate)) {
    const templateResult = await client.query(
      'SELECT * FROM support_playbook_templates WHERE template_key = $1 FOR UPDATE',
      [templateKey],
    );
    const template = templateResult.rows[0];
    if (!template) continue;
    const alreadyApplied = template.graph?.nodes?.every((node) =>
      !assertions[node.id] || JSON.stringify(node.data?.assertions) === JSON.stringify(assertions[node.id]));
    if (alreadyApplied) continue;
    const version = Number(template.version || 1) + 1;
    const graph = updatedGraph(template.graph, version, assertions);
    await client.query(`
      UPDATE support_playbook_templates
      SET graph = $2::jsonb, version = $3, updated_at = NOW()
      WHERE template_key = $1
    `, [templateKey, JSON.stringify(graph), version]);

    const managed = await client.query(`
      SELECT * FROM support_playbooks
      WHERE template_key = $1 AND template_mode = 'managed'
      ORDER BY id
      FOR UPDATE
    `, [templateKey]);
    for (const playbook of managed.rows) {
      const nextResult = await client.query(
        'SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version FROM support_playbook_versions WHERE playbook_id = $1',
        [playbook.id],
      );
      const nextVersion = Number(nextResult.rows[0].next_version);
      const checksum = crypto.createHash('sha256').update(JSON.stringify(graph)).digest('hex');
      await client.query(`
        INSERT INTO support_playbook_versions(
          playbook_id, version, graph, checksum, published_by, published_at
        ) VALUES ($1, $2, $3::jsonb, $4, NULL, NOW())
      `, [playbook.id, nextVersion, JSON.stringify(graph), checksum]);
      const updated = await client.query(`
        UPDATE support_playbooks
        SET draft_graph = $2::jsonb,
            active_version = $3,
            template_version = $4,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [playbook.id, JSON.stringify(graph), nextVersion, version]);
      await client.query(`
        INSERT INTO support_admin_audit_logs(
          user_id, actor_type, action, entity_type, entity_id,
          before_state, after_state, metadata
        ) VALUES ($1, 'system', 'playbook.structured_assertions_published',
                  'support_playbook', $2, $3::jsonb, $4::jsonb, $5::jsonb)
      `, [
        playbook.user_id,
        String(playbook.id),
        JSON.stringify(playbook),
        JSON.stringify(updated.rows[0]),
        JSON.stringify({ templateKey, templateVersion: version, migration: '214_publish_structured_playbook_assertions' }),
      ]);
    }
  }
}

export async function down() {
  // Safety assertions and their immutable published/audit history are retained.
  // Owners can explicitly reset or customize a managed playbook if required.
}
