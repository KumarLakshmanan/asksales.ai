import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import { toolMetadata } from '../mastra/tools/toolRegistry.js';
import { scrubTechnicalTerms } from '../mastra/utils/technicalTerms.js';
import { sanitizeAssistantContent } from '../../shared/userFacingError.js';

const workflowDir = new URL('../data/workflows/', import.meta.url);
const workflows = readdirSync(workflowDir).filter(name => name.endsWith('.json'))
  .map(name => ({ id: name.slice(0, -5), ...JSON.parse(readFileSync(new URL(name, workflowDir), 'utf8')) }));

describe('internal names never reach the chat', () => {
  it('replaces every registered tool name', () => {
    for (const toolName of Object.keys(toolMetadata)) {
      const text = scrubTechnicalTerms(`I ran ${toolName} and \`${toolName}\` failed.`);
      expect(text).not.toContain(toolName);
    }
  });

  it('replaces every lead workflow and data provider actor ID with the workflow title', () => {
    for (const workflow of workflows) {
      const actorIds = workflow.nodes.filter((node: any) => node.type === 'actor').map((node: any) => node.data.actorId as string);
      for (const id of [workflow.id, ...actorIds, ...actorIds.map((id: string) => id.replace('/', '~'))].filter(id => /[_/~]/.test(id))) {
        expect(scrubTechnicalTerms(`Step ${id}: failed`)).not.toContain(id);
      }
    }
    expect(scrubTechnicalTerms('linkedin_company_search failed')).toBe('LinkedIn Company Search failed');
    expect(scrubTechnicalTerms('harvestapi~linkedin-company-search: no key')).toBe('LinkedIn Company Search: no key');
  });

  it('uses plain words for the data provider', () => {
    expect(scrubTechnicalTerms('Missing Apify API key.')).toBe('Missing lead data provider key.');
    expect(scrubTechnicalTerms('The Apify account is out of credits.')).toBe('The lead data provider account is out of credits.');
    expect(scrubTechnicalTerms('Results from Apify arrived.')).toBe('Results from the lead data provider arrived.');
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
