import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readJson = (path: string) => JSON.parse(
  readFileSync(resolve(process.cwd(), path), 'utf8'),
);

describe('JustDial workflow provider contract', () => {
  it('uses the maintained anti-blocking actor with a hard result cap', () => {
    const workflow = readJson('data/workflows/justdial.json');
    const actorNode = workflow.nodes.find((node: any) => node.id === 'justdial_search');

    expect(actorNode.data.actorId).toBe('memo23/justdial-business-scraper');
    expect(actorNode.data.inputMapping).toEqual({
      city: '{{location}}',
      search: '{{search}}',
      maxItems: '{{maxItems}}',
    });
    expect(actorNode.data.finalValues).toEqual(expect.objectContaining({
      scrapeDetails: true,
      enrichEmails: false,
      useMobileApi: true,
      maxConcurrency: 3,
      maxRequestRetries: 12,
    }));
    expect(actorNode.data.finalValues).not.toHaveProperty('proxyConfiguration');
  });

  it('maps replacement actor records into durable lead fields', () => {
    const workflow = readJson('data/workflows/justdial.json');
    const saveNode = workflow.nodes.find((node: any) => node.id === 'node-justdial-save-leads');

    expect(saveNode.data.field_mapping).toEqual(expect.objectContaining({
      fullName: 'name',
      companyName: 'name',
      phone: 'phone',
      whatsapp: 'whatsapp',
      website: 'website',
      address: 'address',
      profileUrl: 'businessUrl',
      rating: 'rating',
      reviewCount: 'ratingCount',
      industry: 'category',
      latitude: 'latitude',
      longitude: 'longitude',
    }));
  });

  it('ships matching local schema metadata for parameter review', () => {
    const actor = readJson('data/actors/memo23-justdial-business-scraper.json');

    expect(actor.id).toBe('memo23/justdial-business-scraper');
    expect(actor.inputSchema.required).toEqual(['maxItems']);
    expect(actor.inputSchema.properties.startUrls.items.type).toBe('string');
    expect(actor.inputSchema.properties.maxItems.minimum).toBe(1);
    expect(actor.inputSchema.properties.enrichEmails.default).toBe(false);
  });
});
