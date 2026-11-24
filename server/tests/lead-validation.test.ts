import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { coerceActorInputTypes, validateActorInputsAgainstSchema } from '../mastra/tools/executors/leadExecutor';

describe('validateActorInputsAgainstSchema', () => {
  const dummySchema = {
    companies: { type: 'array' },
    profileScraperMode: { type: 'string', enum: ['Short', 'Full'] },
    maxItems: { type: 'integer' },
    isEnabled: { type: 'boolean' }
  };

  it('passes on perfectly valid input matching the schema', () => {
    const inputs = {
      companies: ['https://linkedin.com/company/abc'],
      profileScraperMode: 'Short',
      maxItems: 10,
      isEnabled: true
    };
    const required = ['companies', 'profileScraperMode'];
    const errors = validateActorInputsAgainstSchema('some-actor', inputs, dummySchema, required);
    expect(errors).toEqual([]);
  });

  it('fails if required field is missing or empty', () => {
    const inputs = {
      profileScraperMode: ''
    };
    const required = ['companies', 'profileScraperMode'];
    const errors = validateActorInputsAgainstSchema('some-actor', inputs, dummySchema, required);
    expect(errors).toContain('Missing required field: "companies"');
    expect(errors).toContain('Required string field "profileScraperMode" is empty');
  });

  it('fails if field type is incorrect', () => {
    const inputs = {
      companies: 'not-an-array',
      profileScraperMode: 123,
      maxItems: 'not-a-number',
      isEnabled: 'not-a-boolean'
    };
    const errors = validateActorInputsAgainstSchema('some-actor', inputs, dummySchema, []);
    expect(errors).toContain('Field "companies" should be an array, got string');
    expect(errors).toContain('Field "profileScraperMode" should be a string, got number');
    expect(errors).toContain('Field "maxItems" should be a number, got string');
    expect(errors).toContain('Field "isEnabled" should be a boolean, got string');
  });

  it('fails if value is not in enum', () => {
    const inputs = {
      profileScraperMode: 'Medium'
    };
    const errors = validateActorInputsAgainstSchema('some-actor', inputs, dummySchema, []);
    expect(errors).toContain('Field "profileScraperMode" value "Medium" not in allowed values: Short, Full');
  });

  describe('LinkedIn specific rules', () => {
    const linkedinSchema = {
      locations: { type: 'array' },
      searchQueries: { type: 'array' },
      searchQuery: { type: 'string' },
      currentJobTitles: { type: 'array' }
    };

    it('requires locations array to be non-empty if present', () => {
      const inputs = { locations: [] };
      const errors = validateActorInputsAgainstSchema('dev_fusion-linkedin-profile-scraper', inputs, linkedinSchema, []);
      expect(errors).toContain('LinkedIn filter error: "locations" array must not be empty');
    });

    it('requires searchQueries array to be non-empty if present', () => {
      const inputs = { searchQueries: [] };
      const errors = validateActorInputsAgainstSchema('harvestapi-linkedin-post-search', inputs, linkedinSchema, []);
      expect(errors).toContain('LinkedIn filter error: "searchQueries" must not be empty');
    });

    it('requires searchQuery to be non-empty if no other filters are present', () => {
      const inputs = { searchQuery: '' };
      const errors = validateActorInputsAgainstSchema('harvestapi-linkedin-company-search', inputs, linkedinSchema, []);
      expect(errors).toContain('LinkedIn filter error: "searchQuery" must not be empty unless currentJobTitles, locations, or seniorityLevelIds are provided');
    });

    it('allows searchQuery to be empty if other filters are present', () => {
      const inputs = { searchQuery: '', locations: ['New York'] };
      const errors = validateActorInputsAgainstSchema('harvestapi-linkedin-company-search', inputs, linkedinSchema, []);
      expect(errors).toEqual([]);
    });
  });

  describe('Google Maps specific rules', () => {
    it('validates provider department codes and leaves disabled enrichment empty', () => {
      const actor = JSON.parse(readFileSync(new URL('../data/actors/compass-crawler-google-places.json', import.meta.url), 'utf8'));
      const workflow = JSON.parse(readFileSync(new URL('../data/workflows/google_maps.json', import.meta.url), 'utf8'));
      const schema = actor.inputSchema.properties;
      expect(validateActorInputsAgainstSchema(actor.id, { leadsEnrichmentDepartments: ['Owner'] }, schema, []))
        .toEqual([expect.stringContaining('leadsEnrichmentDepartments.0')]);
      expect(validateActorInputsAgainstSchema(actor.id, { leadsEnrichmentDepartments: ['operations'] }, schema, [])).toEqual([]);
      expect(workflow.nodes[0].data.finalValues.leadsEnrichmentDepartments).toEqual([]);
      expect(workflow.nodes[0].data.finalValues.maximumLeadsEnrichmentRecords).toBe(0);
      expect(validateActorInputsAgainstSchema(actor.id, { countryCode: 'IN' }, schema, []))
        .toEqual([expect.stringContaining('countryCode')]);
      expect(validateActorInputsAgainstSchema(actor.id, { countryCode: 'in' }, schema, [])).toEqual([]);
    });
    const mapsSchema = {
      searchStringsArray: { type: 'array' },
      locationQuery: { type: 'string' }
    };

    it('requires searchStringsArray to be non-empty', () => {
      const inputs = { searchStringsArray: [] };
      const errors = validateActorInputsAgainstSchema('compass-crawler-google-places', inputs, mapsSchema, []);
      expect(errors).toContain('Google Maps filter error: "searchStringsArray" must not be empty');
    });

    it('requires locationQuery to be non-empty', () => {
      const inputs = { locationQuery: '' };
      const errors = validateActorInputsAgainstSchema('compass-crawler-google-places', inputs, mapsSchema, []);
      expect(errors).toContain('Google Maps filter error: "locationQuery" must not be empty');
    });
  });
});

describe('coerceActorInputTypes', () => {
  const schema = JSON.parse(readFileSync(new URL('../data/actors/harvestapi-linkedin-profile-search.json', import.meta.url), 'utf8'));
  const findProperties = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (record.properties && typeof record.properties === 'object') return record.properties as Record<string, unknown>;
    for (const child of Object.values(record)) {
      const found = findProperties(child);
      if (found) return found;
    }
    return null;
  };
  const properties = findProperties(schema)!;

  it('accepts numeric LinkedIn seniority IDs as the string enum the actor expects', () => {
    const coerced = coerceActorInputTypes({ seniorityLevelIds: [120, 220, 300, 310], searchQuery: 'HR' }, properties);
    expect(coerced.seniorityLevelIds).toEqual(['120', '220', '300', '310']);
    expect(validateActorInputsAgainstSchema('harvestapi/linkedin-profile-search', coerced, properties, [])
      .filter(error => error.includes('seniorityLevelIds'))).toEqual([]);
  });

  it('keeps existing scalar coercions and leaves non-numeric text alone', () => {
    const coerced = coerceActorInputTypes({ maxItems: '25 leads', currentJobTitles: 'CEO, CFO', profileScraperMode: 'Full' }, properties);
    expect(coerced.maxItems).toBe(25);
    expect(coerced.currentJobTitles).toEqual(['CEO', 'CFO']);
    expect(coerceActorInputTypes({ maxItems: 'many' }, properties).maxItems).toBe('many');
  });
});
