import crypto from 'node:crypto';

const TEMPLATE_KEY = 'hospitality-sales-enquiries-v2';
const AVAILABILITY_NODES = new Set([
  'check-availability',
  'recheck-selected-room',
  'check-alternative-dates',
  'check-alternative-room',
]);

const OPTIONAL_SEARCH_FIELDS = [
  {
    key: 'stay.stayType', type: 'single_select', required: false, pii: 'none',
    prompt: 'Is this an overnight stay or day use?',
    options: [
      { value: 'overnight', label: 'Overnight stay', aliases: ['overnight', 'night stay'] },
      { value: 'dayuse', label: 'Day use', aliases: ['day use', 'day stay', 'dayuse'] },
    ],
    validation: { entityKeys: ['stayType', 'stay_type'] },
  },
  {
    key: 'stay.promoCode', type: 'text', required: false, pii: 'none',
    prompt: 'Do you have a promo code?', validation: { entityKeys: ['promoCode', 'promo_code', 'promo'] },
  },
  {
    key: 'stay.currency', type: 'text', required: false, pii: 'none',
    prompt: 'Which currency should the booking page display?', validation: { entityKeys: ['currency'] },
  },
];

function updateGraph(source, templateVersion) {
  const fields = [...(source.fields || [])];
  for (const field of OPTIONAL_SEARCH_FIELDS) {
    if (!fields.some((candidate) => candidate.key === field.key)) fields.push(field);
  }

  const nodes = (source.nodes || []).map((node) => {
    if (!AVAILABILITY_NODES.has(node.id)) return node;
    return {
      ...node,
      data: {
        ...(node.data || {}),
        args: {
          ...(node.data?.args || {}),
          adults: { source: 'field', key: 'stay.adults' },
          children: { source: 'field', key: 'stay.children' },
          stay_type: { source: 'field', key: 'stay.stayType' },
          promo_code: { source: 'field', key: 'stay.promoCode' },
          currency: { source: 'field', key: 'stay.currency' },
        },
      },
    };
  });
  if (!nodes.some((node) => node.id === 'external-search-complete')) {
    nodes.push({
      id: 'external-search-complete', type: 'complete',
      data: { instruction: 'The owner-approved live booking search was delivered. Do not claim that the hotel is sold out, that a room is selected, or that a booking, hold, price, or payment is confirmed.' },
      position: { x: 1040, y: -320 },
    });
  }

  const edges = [...(source.edges || [])];
  for (const sourceId of AVAILABILITY_NODES) {
    if (!edges.some((edge) => edge.source === sourceId && edge.target === 'external-search-complete')) {
      edges.push({
        source: sourceId,
        target: 'external-search-complete',
        priority: 15,
        condition: { operator: 'capability_status_is', capability: 'availability.check', value: 'redirected' },
      });
    }
  }

  return {
    ...source,
    fields,
    nodes,
    edges,
    metadata: { ...(source.metadata || {}), templateVersion },
  };
}

/** Publish the safe live-search fallback only to still-managed hospitality journeys. */
export async function up(client) {
  const templateResult = await client.query(
    'SELECT * FROM support_playbook_templates WHERE template_key = $1 FOR UPDATE',
    [TEMPLATE_KEY],
  );
  const template = templateResult.rows[0];
  if (!template || template.graph?.nodes?.some((node) => node.id === 'external-search-complete')) return;

  const version = Number(template.version || 1) + 1;
  const graph = updateGraph(template.graph, version);
  const graphJson = JSON.stringify(graph);
  await client.query(`
    UPDATE support_playbook_templates
    SET graph = $2::jsonb, version = $3, updated_at = NOW()
    WHERE template_key = $1
  `, [TEMPLATE_KEY, graphJson, version]);

  const managed = await client.query(`
    SELECT * FROM support_playbooks
    WHERE template_key = $1 AND template_mode = 'managed'
    ORDER BY id
    FOR UPDATE
  `, [TEMPLATE_KEY]);
  for (const playbook of managed.rows) {
    const nextResult = await client.query(
      'SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version FROM support_playbook_versions WHERE playbook_id = $1',
      [playbook.id],
    );
    const nextVersion = Number(nextResult.rows[0].next_version);
    const checksum = crypto.createHash('sha256').update(graphJson).digest('hex');
    await client.query(`
      INSERT INTO support_playbook_versions(
        playbook_id, version, graph, checksum, published_by, published_at
      ) VALUES ($1, $2, $3::jsonb, $4, NULL, NOW())
    `, [playbook.id, nextVersion, graphJson, checksum]);
    const updated = await client.query(`
      UPDATE support_playbooks
      SET draft_graph = $2::jsonb,
          active_version = $3,
          template_version = $4,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [playbook.id, graphJson, nextVersion, version]);
    await client.query(`
      INSERT INTO support_admin_audit_logs(
        user_id, actor_type, action, entity_type, entity_id,
        before_state, after_state, metadata
      ) VALUES ($1, 'system', 'playbook.live_booking_fallback_published',
                'support_playbook', $2, $3::jsonb, $4::jsonb, $5::jsonb)
    `, [
      playbook.user_id,
      String(playbook.id),
      JSON.stringify(playbook),
      JSON.stringify(updated.rows[0]),
      JSON.stringify({ templateKey: TEMPLATE_KEY, templateVersion: version, migration: '277_redirect_missing_hotel_inventory_to_live_booking' }),
    ]);
  }
}

export async function down() {
  // Published playbook versions and their audit history are intentionally retained.
}

export { updateGraph as updateHotelBookingFallbackGraph };
