import { describe, expect, it } from '@jest/globals';
import { buildCompetitorSuggestions } from '../services/aiVisibility/CompetitorSuggestionService.js';

describe('AI Visibility verified competitor suggestions', () => {
  it('parses Business Profile references and never invents an official domain for social handles', () => {
    const suggestions = buildCompetitorSuggestions({
      referenceAccounts: JSON.stringify([
        { name: 'Verified Rival', url: 'https://verified-rival.example/pricing' },
        'https://instagram.com/social_rival',
      ]),
      observations: [],
      projectDomain: 'https://brand.example',
      projectNames: ['Brand'],
      existingCompetitors: [],
    });

    expect(suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Verified Rival', domain: 'https://verified-rival.example', confidence: 'high' }),
      expect.objectContaining({ name: 'Social Rival', domain: null, confidence: 'high' }),
    ]));
    expect(suggestions.every((item) => item.sources.every((source) => source.type === 'business_profile_reference'))).toBe(true);
  });

  it('uses only explicit provider competitor names and attaches a uniquely matching cited domain', () => {
    const suggestions = buildCompetitorSuggestions({
      referenceAccounts: null,
      observations: [{
        id: 11,
        provider: 'gemini',
        competitors: ['Acme Cloud', 'Northstar'],
        citations: [
          { url: 'https://acmecloud.example/features', title: 'Acme Cloud features' },
          { url: 'https://independent.example/report', title: 'Independent market report' },
        ],
        capturedAt: '2026-08-15T00:00:00.000Z',
      }],
      projectDomain: 'https://brand.example',
      projectNames: ['Brand'],
      existingCompetitors: [],
    });

    expect(suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Acme Cloud', domain: 'https://acmecloud.example', confidence: 'medium' }),
      expect.objectContaining({ name: 'Northstar', domain: null, confidence: 'medium' }),
    ]));
    expect(suggestions.find((item) => item.name === 'Acme Cloud')?.sources).toEqual([
      expect.objectContaining({ type: 'provider_observation', label: 'Named in Gemini answers', evidenceCount: 1 }),
    ]);
  });

  it('excludes the audited brand and every already tracked competitor while merging verified evidence', () => {
    const suggestions = buildCompetitorSuggestions({
      referenceAccounts: 'Acme Cloud: https://acmecloud.example, Existing: https://existing.example',
      observations: [{
        id: 12,
        provider: 'openai',
        competitors: ['Brand Alias', 'Acme Cloud', 'Existing'],
        citations: [],
        capturedAt: new Date('2026-08-15T01:00:00.000Z'),
      }],
      projectDomain: 'https://brand.example',
      projectNames: ['Brand', 'Brand Alias'],
      existingCompetitors: [{ name: 'Existing', domain: 'https://existing.example' }],
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toEqual(expect.objectContaining({ name: 'Acme Cloud', domain: 'https://acmecloud.example', confidence: 'high' }));
    expect(suggestions[0].sources.map((source) => source.type).sort()).toEqual(['business_profile_reference', 'provider_observation']);
  });

  it('filters generic extraction noise, caps the list, and never treats a matching citation title as an official domain', () => {
    const suggestions = buildCompetitorSuggestions({
      referenceAccounts: null,
      observations: [{
        id: 13,
        provider: 'gemini',
        competitors: ['365', 'Cloud', 'CRM', 'Aimplify Labs', 'Kore.ai', ...Array.from({ length: 15 }, (_, index) => `Rival ${index + 1}`)],
        citations: [{ url: 'https://vertexaisearch.cloud.google.com', title: 'Kore.ai alternatives' }],
        capturedAt: '2026-08-15T02:00:00.000Z',
      }],
      projectDomain: 'https://aimplifylabs.example',
      projectNames: ['Aimplify AI'],
      existingCompetitors: [],
    });

    expect(suggestions).toHaveLength(10);
    expect(suggestions.map((item) => item.name)).not.toEqual(expect.arrayContaining(['365', 'Cloud', 'CRM', 'Aimplify Labs']));
    expect(suggestions.find((item) => item.name === 'Kore.ai')?.domain).toBeNull();
  });
});
