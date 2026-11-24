/**
 * Managed support journeys may legitimately exceed the old 15-message hourly
 * ceiling. Upgrade only the exact legacy managed rule; customized rate limits
 * remain untouched. Exceeding the managed default pauses AI instead of opening
 * a human handoff ticket.
 */

const LEGACY_MATCH = `
  rule->>'type' = 'rate_limit'
  AND (rule->'config'->>'limit')::int = 15
  AND (rule->'config'->>'windowSeconds')::int = 3600
  AND rule->'config'->>'action' = 'escalate'
`;

const CURRENT_MATCH = `
  rule->>'type' = 'rate_limit'
  AND (rule->'config'->>'limit')::int = 60
  AND (rule->'config'->>'windowSeconds')::int = 3600
  AND rule->'config'->>'action' = 'block'
`;

function transformedRules(match, limit, action) {
  return `(
    SELECT COALESCE(jsonb_agg(
      CASE WHEN ${match}
        THEN jsonb_set(
          jsonb_set(rule, '{config,limit}', '${limit}'::jsonb, true),
          '{config,action}', '"${action}"'::jsonb, true
        )
        ELSE rule
      END ORDER BY ordinal
    ), '[]'::jsonb)
    FROM jsonb_array_elements(rules) WITH ORDINALITY AS item(rule, ordinal)
  )`;
}

export async function up(client) {
  const upgraded = transformedRules(LEGACY_MATCH, 60, 'block');
  await client.query(`
    UPDATE ai_agent_configs config
    SET escalation_rules = CASE
          WHEN jsonb_typeof(config.escalation_rules) = 'array' THEN
            ${upgraded.replaceAll('rules', 'config.escalation_rules')}
          ELSE jsonb_set(
            config.escalation_rules,
            '{rules}',
            ${upgraded.replaceAll('rules', "COALESCE(config.escalation_rules->'rules', '[]'::jsonb)")},
            true
          )
        END,
        metadata = jsonb_set(COALESCE(config.metadata, '{}'::jsonb), '{rateLimitPolicyVersion}', '3'::jsonb, true),
        updated_at = NOW()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(config.escalation_rules) = 'array'
          THEN config.escalation_rules
          ELSE COALESCE(config.escalation_rules->'rules', '[]'::jsonb)
        END
      ) AS item(rule)
      WHERE ${LEGACY_MATCH}
    )
  `);
}

export async function down(client) {
  const reverted = transformedRules(CURRENT_MATCH, 15, 'escalate');
  await client.query(`
    UPDATE ai_agent_configs config
    SET escalation_rules = CASE
          WHEN jsonb_typeof(config.escalation_rules) = 'array' THEN
            ${reverted.replaceAll('rules', 'config.escalation_rules')}
          ELSE jsonb_set(
            config.escalation_rules,
            '{rules}',
            ${reverted.replaceAll('rules', "COALESCE(config.escalation_rules->'rules', '[]'::jsonb)")},
            true
          )
        END,
        metadata = jsonb_set(COALESCE(config.metadata, '{}'::jsonb), '{rateLimitPolicyVersion}', '2'::jsonb, true),
        updated_at = NOW()
    WHERE COALESCE((config.metadata->>'rateLimitPolicyVersion')::int, 0) = 3
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(config.escalation_rules) = 'array'
            THEN config.escalation_rules
            ELSE COALESCE(config.escalation_rules->'rules', '[]'::jsonb)
          END
        ) AS item(rule)
        WHERE ${CURRENT_MATCH}
      )
  `);
}
