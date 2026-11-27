import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import { scrubTechnicalTerms } from '../mastra/utils/technicalTerms.js';
import { sanitizeAssistantContent } from '../../shared/userFacingError.js';

const workflowDir = new URL('../data/workflows/', import.meta.url);
const workflows = readdirSync(workflowDir).filter(name => name.endsWith('.json'))
  .map(name => ({ id: name.slice(0, -5), ...JSON.parse(readFileSync(new URL(name, workflowDir), 'utf8')) }));

// Read tool IDs from the tool source files, not from the list the scrubber uses,
// so a tool that was never registered is still caught.
const mastraDir = fileURLToPath(new URL('../mastra/', import.meta.url));
const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? sourceFiles(full) : name.endsWith('.ts') ? [full] : [];
});
const toolIds = [...new Set(sourceFiles(mastraDir).flatMap(file =>
  [...readFileSync(file, 'utf8').matchAll(/createTool\(\{\s*id:\s*['"]([a-z0-9_]+)['"]/g)].map(match => match[1])))];

describe('internal names never reach the chat', () => {
  it('replaces every tool the agents can call', () => {
    expect(toolIds.length).toBeGreaterThan(50);
    for (const toolName of toolIds) {
      const text = scrubTechnicalTerms(`I ran ${toolName} and \`${toolName}\` failed.`);
      expect(text).not.toContain(toolName);
    }
  });

  it('replaces every lead workflow and data provider actor ID with the workflow title', () => {
    for (const workflow of workflows) {
      const actorIds = workflow.nodes.filter((node: any) => node.type === 'actor').map((node: any) => node.data.actorId as string);
      const nodeIds = workflow.nodes.map((node: any) => String(node.id || ''));
      for (const id of [workflow.id, ...nodeIds, ...actorIds, ...actorIds.map((id: string) => id.replace('/', '~'))].filter(id => /[_/~]/.test(id))) {
        expect(scrubTechnicalTerms(`Step ${id}: failed`)).not.toContain(id);
      }
    }
    expect(scrubTechnicalTerms('linkedin_company_search failed')).toBe('LinkedIn Company Search failed');
    expect(scrubTechnicalTerms('harvestapi~linkedin-company-search: no key')).toBe('LinkedIn Company Search: no key');
  });

  it('uses plain words for the data provider', () => {
    expect(scrubTechnicalTerms('Missing Apify API key.')).toBe('Missing lead data provider key.');
    // Customers see the Apify name on billing pages, so normal sentences stay as written.
    expect(scrubTechnicalTerms('Credits are charged on the actual Apify usage.')).toBe('Credits are charged on the actual Apify usage.');
    expect(scrubTechnicalTerms('google_maps_search: Actor execution failed')).toBe('Google Maps Business Search: Actor execution failed');
  });

  it('leaves ordinary text, placeholders, links and file names alone', () => {
    const text = 'Hi {{first_name}}, see https://example.com/get_campaign_export?utm_source=mail and report_final.pdf. apify.com is fine.';
    expect(scrubTechnicalTerms(text)).toBe(text);
    expect(scrubTechnicalTerms('Your LinkedIn leads are ready.')).toBe('Your LinkedIn leads are ready.');
  });

  it('keeps tool call receipts intact because the app pairs them by name', () => {
    const receipt = '🔧 execute_lead_workflow';
    expect(sanitizeAssistantContent(receipt, { isToolCall: true })).toBe(receipt);
    expect(sanitizeAssistantContent(receipt, { isToolResult: true })).toBe(receipt);
    expect(sanitizeAssistantContent(receipt)).toBe('🔧 the lead search');
  });
});
