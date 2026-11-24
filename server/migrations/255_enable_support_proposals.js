import { createHash } from 'node:crypto';

const TOOLS = ['get_conversation_proposals', 'create_conversation_proposal_draft', 'request_proposal_revision'];
const AGENTS = {
  hotel_sales: 'Hotel sales', tech_support: 'Technical support', lead_qualifier: 'Lead qualification',
  customer_success: 'Customer success', general_service: 'General service',
};
const PROMPT = '\n\nFor a customer requesting a written proposal, capture their stated objective and requirements and use the enabled proposal draft tool. For an existing proposal, use only the current conversation’s proposal records. Capture revision requests without treating requested prices, timelines, or terms as agreed. All drafts and revisions need seller review; never claim a draft was approved, sent, accepted, or signed, and never invent a proposal link. Do not disclose internal drafts, approval notes, AI assumptions, or other customers’ proposals. These tools are for private customer conversations, not public social comments.';

// Immutable migration snapshot. A parity test ties these initial publications to
// the shipped definitions without importing the application (or providers) here.
const JOURNEYS = [
  {
    kind: 'request', name: 'Proposal request', description: 'Captures the customer’s requirements and prepares a linked draft for seller review.',
    fields: [
      { key: 'proposal.title', type: 'text', required: true, pii: 'none', prompt: 'What service or outcome should the proposal cover?', validation: { minLength: 2, maxLength: 500, entityKeys: ['proposalTitle'] } },
      { key: 'proposal.context', type: 'text', required: true, pii: 'none', prompt: 'What deliverables, timeline, or other requirements should the seller consider?', validation: { minLength: 2, maxLength: 8000, entityKeys: ['proposalContext'] } },
    ],
    nodes: [
      { id: 'collect-request', type: 'collect', data: { fieldKeys: ['proposal.title', 'proposal.context'], instruction: 'Ask only for missing proposal requirements. Do not request contact details already linked to this conversation or promise a price.' } },
      { id: 'record-request', type: 'capability', data: { capabilityName: 'proposal.request', args: { title: { source: 'field', key: 'proposal.title' }, context: { source: 'field', key: 'proposal.context' } }, instruction: 'Record the customer’s stated proposal request through the authorized draft tool once. Explain only the confirmed result and that a seller must complete and review the offer before sending.' } },
    ],
  },
  {
    kind: 'status', name: 'Proposal status', description: 'Looks up customer-safe proposal status and sent pricing in the current conversation.', fields: [],
    nodes: [{ id: 'read-proposals', type: 'capability', data: { capabilityName: 'proposal.list', args: {}, instruction: 'Look up this conversation’s proposals. Answer the customer’s question using only returned customer-safe status and sent pricing. If there are several, identify each by proposal number. Do not expose draft content or invent a public link.' } }],
  },
  {
    kind: 'revision', name: 'Proposal change request', description: 'Records requested changes, pauses customer follow-ups, and prepares a separate draft for seller review.',
    fields: [
      { key: 'proposal.number', type: 'text', required: true, pii: 'none', prompt: 'Which proposal would you like to change? Please use the proposal number shown on the offer.', validation: { minLength: 1, maxLength: 50, entityKeys: ['proposalNumber', 'proposal_number'], pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$' } },
      { key: 'proposal.changes', type: 'text', required: true, pii: 'none', prompt: 'What would you like the seller to change in that proposal?', validation: { minLength: 1, maxLength: 8000, entityKeys: ['requestedChanges', 'requested_changes'] } },
    ],
    nodes: [
      { id: 'collect-changes', type: 'collect', data: { fieldKeys: ['proposal.number', 'proposal.changes'], instruction: 'Ask only for the missing proposal reference or requested changes. Record the customer’s preference without promising new prices or terms.' } },
      { id: 'record-changes', type: 'capability', data: { capabilityName: 'proposal.revision_request', args: { proposal_number: { source: 'field', key: 'proposal.number' }, requested_changes: { source: 'field', key: 'proposal.changes' } }, instruction: 'Record the requested changes through the authorized tool once. Explain whether the request and separate draft were actually saved. The existing offer remains unchanged until the seller reviews and sends a replacement.' } },
    ],
  },
];

export function proposalSupportMigrationDefinitions() {
  return Object.entries(AGENTS).flatMap(([agentType, label]) => JOURNEYS.map(journey => {
    const key = `proposal-${journey.kind}-${agentType}-v1`;
    const nodes = [{ id: 'start', type: 'trigger', data: {} }, ...journey.nodes, { id: 'complete', type: 'complete', data: {} }];
    return {
      key, name: `Default · ${journey.name} · ${label}`, description: journey.description, agentType,
      assignments: [{ channel: null, intent: `proposal_${journey.kind}`, agentType, priority: 90, trafficPercent: 100 }],
      graph: {
        schemaVersion: 2, entryNodeId: 'start', fields: journey.fields, nodes,
        edges: nodes.slice(0, -1).map((node, index) => ({ id: `${node.id}-${nodes[index + 1].id}`, source: node.id, target: nodes[index + 1].id, condition: { operator: node.type === 'collect' ? 'all_required_fields_present' : 'always' } })),
        metadata: { templateKey: key, templateVersion: 1, systemDefault: true, agentType, controls: { privacy: 'enforced', piiRedaction: 'enforced', safety: 'enforced', humanHandoff: 'enabled', toolApproval: 'required' } },
      },
    };
  }));
}

export async function up(client) {
  await client.query(`ALTER TABLE proposal_feedback ADD COLUMN IF NOT EXISTS source_key VARCHAR(100)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS proposal_feedback_source_key
    ON proposal_feedback(user_id, source_key) WHERE source_key IS NOT NULL`);

  // Only untouched platform templates and matching managed tenant copies opt
  // into these tools. Customized allowlists, prompts, approval rules, active
  // specialist selection and channel scope remain authoritative.
  await client.query(`
    WITH candidates AS (
      SELECT template.*, to_jsonb(template) AS before_state
      FROM support_agent_templates template
      WHERE template.updated_by_admin IS NULL
        AND template.agent_type = ANY($3::text[])
        AND jsonb_typeof(template.tools_enabled) = 'array'
        AND COALESCE(template.metadata->>'proposalToolsVersion','') <> '1'
    ), templates AS (
      UPDATE support_agent_templates template
      SET tools_enabled = candidates.tools_enabled || (
          SELECT COALESCE(jsonb_agg(tool), '[]'::jsonb) FROM jsonb_array_elements($1::jsonb) tool
          WHERE NOT candidates.tools_enabled @> jsonb_build_array(tool)),
          system_prompt = candidates.system_prompt || $2,
          metadata = COALESCE(candidates.metadata,'{}'::jsonb) || jsonb_build_object('proposalToolsVersion',1,'defaultProfileVersion',candidates.version+1),
          version = candidates.version+1, updated_at=NOW()
      FROM candidates WHERE template.id=candidates.id
      RETURNING template.*, candidates.before_state
    ), copies AS (
      SELECT config.id, to_jsonb(config) AS before_state, template.tools_enabled,
        template.version, template.system_prompt,
        template.before_state->>'system_prompt' AS previous_prompt
      FROM ai_agent_configs config JOIN templates template ON template.agent_type=config.agent_type
      WHERE config.template_mode='managed'
        AND config.tools_enabled IS NOT DISTINCT FROM template.before_state->'tools_enabled'
    ), updated_copies AS (
      UPDATE ai_agent_configs config SET tools_enabled=copies.tools_enabled,
        system_prompt=CASE WHEN config.system_prompt IS NOT DISTINCT FROM copies.previous_prompt
          THEN copies.system_prompt ELSE config.system_prompt END,
        metadata=COALESCE(config.metadata,'{}'::jsonb)||jsonb_build_object('proposalToolsVersion',1),
        template_version=copies.version,updated_at=NOW()
      FROM copies WHERE config.id=copies.id RETURNING config.*,copies.before_state
    )
    INSERT INTO support_admin_audit_logs (user_id,actor_type,action,entity_type,entity_id,before_state,after_state,metadata)
    SELECT user_id,'system','agent_config.proposal_tools_enabled','ai_agent_config',id::text,before_state,
      to_jsonb(updated_copies)-'before_state',jsonb_build_object('migration','255_enable_support_proposals') FROM updated_copies
  `, [JSON.stringify(TOOLS), PROMPT, Object.keys(AGENTS)]);

  for (const definition of proposalSupportMigrationDefinitions()) {
    const inserted = await client.query(`INSERT INTO support_playbook_templates
      (template_key,name,description,agent_type,status,graph,assignments,version)
      VALUES ($1,$2,$3,$4,'published',$5::jsonb,$6::jsonb,1)
      ON CONFLICT (template_key) DO NOTHING RETURNING *`, [definition.key, definition.name,
      definition.description, definition.agentType, JSON.stringify(definition.graph),
      JSON.stringify(definition.assignments.map(assignment => ({ ...assignment, enabled: true })))]);
    const template = inserted.rows[0] || (await client.query(
      `SELECT * FROM support_playbook_templates WHERE template_key=$1 AND status='published'`, [definition.key])).rows[0];
    if (!template || template.status !== 'published') continue;
    const graph = typeof template.graph === 'string' ? JSON.parse(template.graph) : template.graph;
    const graphJson = JSON.stringify(graph);
    const assignment = definition.assignments[0];
    // Never attach a new default over an existing owner-authored assignment for
    // this intent, or to an agent whose configured tool set cannot run it.
    const playbooks = await client.query(`INSERT INTO support_playbooks
      (user_id,agent_type,name,description,status,draft_graph,active_version,template_key,template_version,template_mode,created_by)
      SELECT config.user_id,$2::varchar(50),$3::varchar(160),$4::text,'published',$5::jsonb,1,$1::varchar(120),$6::integer,'managed',config.user_id
      FROM ai_agent_configs config WHERE config.agent_type=$2::varchar(50) AND config.template_mode='managed'
        AND config.tools_enabled @> $7::jsonb
        AND NOT EXISTS (SELECT 1 FROM support_playbooks p WHERE p.user_id=config.user_id AND (p.template_key=$1::varchar(120) OR p.name=$3::varchar(160)))
        AND NOT EXISTS (SELECT 1 FROM support_playbook_assignments a WHERE a.user_id=config.user_id AND a.agent_type=config.agent_type AND a.intent=$8::varchar(80))
      ON CONFLICT DO NOTHING RETURNING id,user_id`, [definition.key, definition.agentType, template.name,
      template.description, graphJson, template.version, JSON.stringify(TOOLS), assignment.intent]);
    for (const playbook of playbooks.rows) {
      await client.query(`INSERT INTO support_playbook_versions (playbook_id,version,graph,checksum,published_by,published_at)
        VALUES ($1,1,$2::jsonb,$3,$4,NOW())`, [playbook.id, graphJson, createHash('sha256').update(graphJson).digest('hex'), playbook.user_id]);
      await client.query(`INSERT INTO support_playbook_assignments
        (user_id,playbook_id,channel,intent,agent_type,priority,traffic_percent,enabled)
        VALUES ($1,$2,NULL,$3,$4,90,100,TRUE)`, [playbook.user_id, playbook.id, assignment.intent, definition.agentType]);
      await client.query(`INSERT INTO support_admin_audit_logs
        (user_id,actor_type,action,entity_type,entity_id,after_state,metadata)
        VALUES ($1,'system','playbook.proposal_default_provisioned','support_playbook',$2,$3::jsonb,$4::jsonb)`,
      [playbook.user_id, String(playbook.id), JSON.stringify({ templateKey: definition.key, graph }), JSON.stringify({ migration: '255_enable_support_proposals' })]);
    }
  }
}

export async function down(client) {
  // Preserve customer feedback, publication history, and owner changes on an
  // application rollback. These additions grant no approval or sending tool.
  await client.query('SELECT 1');
}
