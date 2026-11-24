import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { WorkflowExecutorService } from '../services/WorkflowExecutorService.js';
import { buildLeadIdentityKeys, findDuplicateLead } from '../services/lead-generation/LeadGenerationQualityService.js';

const mapping = JSON.parse(readFileSync(new URL('../data/workflows/google_maps.json', import.meta.url), 'utf8'))
  .nodes.find((node: any) => node.type === 'saveToLeads').data.field_mapping;
const place = (id: string, name: string) => ({
  title: name, placeId: id, city: 'Coimbatore', state: 'Tamil Nadu', countryCode: 'IN',
  location: { lat: 11.01, lng: 76.96 },
  address: '10 Example Street, Coimbatore, Tamil Nadu 641012, India',
  url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${id}`,
});

describe('Google Maps live-result regressions', () => {
  it('keeps provider profile URL separate from an absent business website', () => {
    const raw = place('place-one', 'Example Cafe');
    const mapped = (WorkflowExecutorService as any).mapActorResultToLead(raw, mapping, { platform: 'google_maps' });
    expect(mapped.website ?? null).toBeNull();
    expect(mapped.profileUrl).toBe(raw.url);
    expect(mapped.location.city).toBe('Coimbatore');
    expect(mapped.location.state).toBe('Tamil Nadu');
  });

  it('does not merge distinct places even when historical website fields contain Maps URLs', () => {
    const rawA = place('place-one', 'Example Cafe');
    const rawB = place('place-two', 'Second Cafe');
    const a = { ...rawA, fullName: rawA.title, website: rawA.url, profileUrl: rawA.url };
    const b = { ...rawB, fullName: rawB.title, website: rawB.url, profileUrl: rawB.url };
    expect(buildLeadIdentityKeys(a)).not.toContain('domain:google.com');
    expect(findDuplicateLead(b, [a])).toBeUndefined();
    expect(findDuplicateLead({ ...b, placeId: a.placeId }, [a])).toBe(a);
  });

  it('retains real business website mapping and domain deduplication', () => {
    const raw = { ...place('place-one', 'Example Cafe'), website: 'https://example-cafe.test/menu' };
    const mapped = (WorkflowExecutorService as any).mapActorResultToLead(raw, mapping, { platform: 'google_maps' });
    expect(mapped.website).toBe(raw.website);
    expect(buildLeadIdentityKeys(mapped)).toContain('domain:example-cafe.test');
  });
});
