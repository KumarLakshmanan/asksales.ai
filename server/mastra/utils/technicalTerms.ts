/**
 * Plain words for the app's own internal names, applied to every assistant
 * message before it is saved, sent or shown again.
 *
 * Only known names are replaced: registered tool names, lead search workflow
 * IDs and their data-provider actor IDs. Generic snake_case text such as
 * {{first_name}}, utm_source or file names is never touched.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
// A namespace import so tests that stub the registry still load this module.
import * as toolRegistry from '../tools/toolRegistry.js';
import { resolveActorSchemaDataDirectories } from '../../services/workflow/ActorSchemaRegistry.js';
import { registerTechnicalTermScrubber } from '../../../shared/userFacingError.js';

const TOOL_LABELS: Record<string, string> = {
  execute_lead_workflow: 'the lead search',
  generate_lead_inputs: 'the search settings',
  list_available_workflows: 'the lead strategies',
  estimate_lead_search_cost: 'the search cost estimate',
  send_outreach_messages: 'the outreach send',
  get_outreach_preparation_options: 'your sending accounts and contact lists',
  prepare_outreach_campaign: 'the outreach draft',
  get_prepared_outreach: 'the outreach draft',
  publish_ads: 'the ad publish',
  save_business_profile: 'the business profile update',
};

const LEADING_VERBS = /^(?:get|list|query|read|execute|run|create|generate|prepare|update|save|preview|analyze|analyse|estimate|search|find|fetch|check|load|show|start|submit|request)_/;

/** "query_campaign_customers" -> "campaign customers". */
export function humanizeToolName(toolName: string): string {
  return TOOL_LABELS[toolName] || toolName.replace(LEADING_VERBS, '').replace(/_/g, ' ').trim() || 'this step';
}

function workflowDirectory(): string | null {
  for (const dataDir of resolveActorSchemaDataDirectories()) {
    const dir = path.join(dataDir, 'workflows');
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** Workflow IDs and actor IDs mapped to the workflow's own title. */
function workflowLabels(): Map<string, string> {
  const labels = new Map<string, string>();
  const dir = workflowDirectory();
  if (!dir) return labels;
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    try {
      const workflow = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
      const title = String(workflow.title || '').trim();
      if (!title) continue;
      const ids = [file.slice(0, -5), workflow.workflow_id].filter((id): id is string => typeof id === 'string' && /[_/~]/.test(id));
      for (const id of ids) if (!labels.has(id)) labels.set(id, title);
      for (const node of Array.isArray(workflow.nodes) ? workflow.nodes : []) {
        const actorId = node?.type === 'actor' ? node?.data?.actorId : null;
        if (typeof actorId !== 'string' || !actorId.includes('/')) continue;
        for (const id of [actorId, actorId.replace('/', '~')]) if (!labels.has(id)) labels.set(id, title);
      }
    } catch {
      // A broken workflow file must not stop chat messages.
    }
  }
  return labels;
}

let compiled: { pattern: RegExp; labels: Map<string, string> } | null = null;

function compile() {
  if (compiled) return compiled;
  const labels = workflowLabels();
  for (const toolName of Object.keys(toolRegistry.toolMetadata ?? {})) labels.set(toolName, humanizeToolName(toolName));
  for (const toolName of Object.keys(TOOL_LABELS)) labels.set(toolName, TOOL_LABELS[toolName]);
  const terms = [...labels.keys()].sort((a, b) => b.length - a.length)
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Not part of a longer word, path, URL or {{placeholder}}.
  const pattern = new RegExp(`(?<![\\w./~{-])\`?(${terms.join('|')})\`?(?![\\w/~}-])`, 'g');
  compiled = { pattern, labels };
  return compiled;
}

const APIFY_KEY = /\bApify(?:'s)?(?: API)? (?:key|token|credential)(s?)\b/g;
const THE_APIFY = /\b(the|an?) Apify\b/gi;
const BARE_APIFY = /\bApify\b(?!\.[a-z])/g;

export function scrubTechnicalTerms(content: string): string {
  if (typeof content !== 'string' || !content) return content;
  const { pattern, labels } = compile();
  return content
    .replace(pattern, (_match, term: string) => labels.get(term) || term)
    .replace(APIFY_KEY, (_m, plural: string) => `lead data provider key${plural}`)
    .replace(THE_APIFY, (_m, article: string) => (
      /^the$/i.test(article) ? `${article} lead data provider` : `${article[0] === 'A' ? 'A' : 'a'} lead data provider`
    ))
    .replace(BARE_APIFY, 'the lead data provider');
}

registerTechnicalTermScrubber(scrubTechnicalTerms);
