import {
  appendLeadSourceReceipt,
  appendLeadSourceRecord,
  buildLeadIdentityKeys,
  evaluateLeadRelevance,
  findDuplicateLead,
  shouldApplyPostProviderRelevanceValidation,
} from '../services/lead-generation/LeadGenerationQualityService.js';

describe('lead generation quality gate', () => {
  it.each(['Hotel Management Institute', 'Luxury Hotel Consultants', 'Hotel Equipment Supplier', 'Hotel Booking Agency'])('excludes non-property business %s from hotel prospecting', companyName => {
    expect(evaluateLeadRelevance({ companyName, address: 'Hyderabad', categories: ['Hospitality'] }, {
      regions: ['Hyderabad'], industry: 'Hospitality', subIndustry: 'Luxury hotels',
    }, 'google_maps')).toEqual(expect.objectContaining({
      accepted: false, reasons: expect.arrayContaining(['requested_business_type_mismatch']),
    }));
  });

  it('requires luxury evidence rather than treating a five-point review rating as hotel stars', () => {
    const lead = { companyName: 'City Hotel', address: 'Hyderabad', categories: ['Hotel'], rating: 5 };
    const constraints = { regions: ['Hyderabad'], subIndustry: 'Luxury hotels' };
    expect(evaluateLeadRelevance(lead, constraints, 'google_maps').reasons).toContain('requested_luxury_tier_unverified');
    expect(evaluateLeadRelevance({ ...lead, rawData: { hotelStars: 5 } }, constraints, 'google_maps').accepted).toBe(true);
  });

  it('accepts actual luxury resorts without requiring decision-maker roles on business listings', () => {
    expect(evaluateLeadRelevance({ companyName: 'Lake Luxury Resort', address: 'Hyderabad', categories: ['Resort'] }, {
      regions: ['Hyderabad'], industry: 'Hospitality', targetAudience: 'General managers and sales directors of luxury resorts',
    }, 'justdial').accepted).toBe(true);
  });

  it('rejects an explicitly affiliated property from an independent boutique brief', () => {
    expect(evaluateLeadRelevance({
      companyName: 'Rio Boutique',
      bio: 'A Resort Rio Hotel — a luxurious retreat in Goa',
      categories: ['Hotel'],
      address: 'Verem, Goa',
    }, {
      regions: ['Goa'],
      industry: 'Hospitality',
      targetAudience: 'Independent boutique hotel business profiles',
    }, 'instagram')).toEqual(expect.objectContaining({
      accepted: false,
      industry: 'mismatched',
      reasons: expect.arrayContaining(['requested_independent_property_mismatch']),
    }));
  });

  it('does not require the word independent in every valid boutique property bio', () => {
    expect(evaluateLeadRelevance({
      companyName: 'Seabreeze Boutique Hotel',
      bio: 'A quiet 12-room stay near the beach in Goa',
      categories: ['Boutique hotel'],
      address: 'Candolim, Goa',
    }, {
      regions: ['Goa'],
      industry: 'Hospitality',
      targetAudience: 'Independent boutique hotel business profiles',
    }, 'instagram').accepted).toBe(true);
  });

  it('rejects a local provider result from the wrong reviewed city', () => {
    expect(evaluateLeadRelevance({
      companyName: 'Cloud Nine Boutique Hotel',
      categories: ['Boutique hotel'],
      address: 'Panaji, Goa, India',
    }, {
      regions: ['Nandi Hills, Bangalore'],
      subIndustry: 'Boutique hotels',
    }, 'google_maps')).toEqual(expect.objectContaining({
      accepted: false,
      geography: 'mismatched',
      reasons: expect.arrayContaining(['geography_mismatch']),
    }));
  });

  it('accepts Bengaluru and Bangalore as the same reviewed geography', () => {
    expect(evaluateLeadRelevance({
      companyName: 'Nandi Retreat Hotel',
      categories: ['Hotels'],
      address: 'Nandi Hills Road, Bengaluru, Karnataka',
    }, {
      regions: ['Nandi Hills, Bangalore'],
      subIndustry: 'Boutique hotels',
    }, 'justdial')).toEqual(expect.objectContaining({
      accepted: true,
      geography: 'matched',
      industry: 'matched',
    }));
  });

  it('accepts a tour operator as a travel-industry match', () => {
    expect(evaluateLeadRelevance({
      companyName: 'Trip Cabinet',
      categories: ['Tour operator'],
      address: 'Dickenson Road, Bengaluru, Karnataka',
    }, {
      regions: ['Bangalore, Karnataka'],
      industry: 'Hospitality & Travel',
      targetAudience: 'Boutique travel agencies and corporate travel planners',
    }, 'google_maps')).toEqual(expect.objectContaining({
      accepted: true,
      geography: 'matched',
      industry: 'matched',
    }));
  });

  it('does not accept a wrong industry from one generic audience-word overlap', () => {
    expect(evaluateLeadRelevance({
      companyName: 'High Tech Solutions',
      categories: ['Software company'],
      address: 'Koramangala, Bengaluru, Karnataka',
    }, {
      regions: ['Bengaluru, Karnataka'],
      industry: 'Hospitality & Travel',
      targetAudience: 'High-end boutique travel agencies and corporate travel planners',
    }, 'justdial')).toEqual(expect.objectContaining({
      accepted: false,
      geography: 'matched',
      industry: 'mismatched',
      reasons: expect.arrayContaining(['industry_mismatch']),
    }));
  });

  it('rejects a local-provider record with no verifiable industry data', () => {
    expect(evaluateLeadRelevance({
      address: 'Indiranagar, Bengaluru, Karnataka',
    }, {
      regions: ['Bengaluru, Karnataka'],
      industry: 'Hospitality & Travel',
    }, 'google_maps')).toEqual(expect.objectContaining({
      accepted: false,
      industry: 'unknown',
      reasons: expect.arrayContaining(['industry_missing']),
    }));
  });

  it('rejects a LinkedIn profile outside the reviewed decision-maker roles', () => {
    expect(evaluateLeadRelevance({
      role: 'Chief Business Officer - Food Services',
      headline: 'CEO · COO · President · CXO',
      companyName: 'Bluspring Food & Hospitality Services',
      industry: 'Hospitality',
      location: 'Bengaluru, India',
    }, {
      regions: ['Bengaluru, Karnataka, India'],
      industry: 'Hospitality',
      targetAudience: 'Owners, Founders, and General Managers of boutique hotels',
    }, 'linkedin')).toEqual(expect.objectContaining({
      accepted: false,
      geography: 'matched',
      industry: 'matched',
      audience: 'mismatched',
      reasons: expect.arrayContaining(['audience_role_mismatch']),
    }));
  });

  it('accepts a LinkedIn profile whose role matches the reviewed audience', () => {
    expect(evaluateLeadRelevance({
      role: 'General Manager',
      companyName: 'Nandi Boutique Hotel',
      industry: 'Hospitality',
      location: 'Bangalore, Karnataka',
    }, {
      regions: ['Bengaluru, Karnataka, India'],
      industry: 'Hospitality',
      targetAudience: 'Owners, Founders, and General Managers of boutique hotels',
    }, 'linkedin')).toEqual(expect.objectContaining({
      accepted: true,
      audience: 'matched',
    }));
  });

  it('does not broaden a requested general-manager role to any manager', () => {
    expect(evaluateLeadRelevance({
      role: 'Restaurant Manager',
      companyName: 'Nandi Boutique Hotel',
      industry: 'Hospitality',
      location: 'Bengaluru, Karnataka',
    }, {
      regions: ['Bengaluru, Karnataka, India'],
      industry: 'Hospitality',
      targetAudience: 'General Managers of boutique hotels',
    }, 'linkedin')).toEqual(expect.objectContaining({
      accepted: false,
      audience: 'mismatched',
    }));
  });

  it('does not treat historical hotel mentions as the current LinkedIn industry', () => {
    expect(evaluateLeadRelevance({
      role: 'Founder',
      companyName: 'Epinoyah Design | Build',
      industry: null,
      location: 'Bengaluru, India',
      bio: 'Delivered luxury hotel projects earlier in her architecture career.',
      rawData: {
        currentPosition: [{ position: 'Founder', companyName: 'Epinoyah Design | Build' }],
      },
    }, {
      regions: ['Bengaluru, Karnataka, India'],
      industry: 'Hospitality',
      targetAudience: 'Owners, Founders, and General Managers of boutique hotels',
    }, 'linkedin')).toEqual(expect.objectContaining({
      accepted: false,
      audience: 'matched',
      industry: 'mismatched',
      reasons: expect.arrayContaining(['industry_mismatch']),
    }));
  });

  it('trusts LinkedIn search-schema targeting instead of applying a second ICP filter', () => {
    expect(shouldApplyPostProviderRelevanceValidation(
      'LinkedIn',
      'harvestapi/linkedin-profile-search',
    )).toBe(false);
    expect(shouldApplyPostProviderRelevanceValidation(
      'lead_generation',
      'harvestapi/linkedin-profile-search',
    )).toBe(false);
  });

  it('trusts an exact reviewed Instagram username instead of applying a second ICP filter', () => {
    expect(shouldApplyPostProviderRelevanceValidation(
      'instagram_competitor_profiles',
      'apify/instagram-profile-scraper',
    )).toBe(false);
  });

  it('trusts an exact reviewed Facebook page follower relation instead of reclassifying the follower name', () => {
    expect(shouldApplyPostProviderRelevanceValidation(
      'facebook_competitor_pages',
      'apify/facebook-followers-following-scraper',
    )).toBe(false);
  });

  it('uses the originating post text as relevance evidence for a sparse Facebook page profile', () => {
    expect(evaluateLeadRelevance({
      companyName: 'Talkdesk',
      categories: ['Page', 'Software Company'],
      bio: 'Customer Experience. Automated.',
      rawData: {
        sourcePostText: 'Accelerate AI automation for enterprise contact centers worldwide.',
      },
    }, {
      industry: 'Technology',
      subIndustry: 'Enterprise AI Automation',
      targetAudience: 'Enterprise-level decision makers interested in autonomous AI agents',
    }, 'facebook_post_authors')).toEqual(expect.objectContaining({
      accepted: true,
      industry: 'matched',
    }));
  });

  it('retains post-provider relevance validation for local-directory providers', () => {
    expect(shouldApplyPostProviderRelevanceValidation(
      'Google Maps',
      'compass/crawler-google-places',
    )).toBe(true);
    expect(shouldApplyPostProviderRelevanceValidation(
      'JustDial',
      'apify/justdial-search',
    )).toBe(true);
  });

  it('deduplicates the same business across provider-specific IDs', () => {
    const google = {
      id: 41,
      companyName: 'Nandi Hills Retreat',
      phone: '+91 98765 43210',
      address: 'Nandi Hills, Bengaluru',
      placeId: 'google-place-1',
    };
    const justdial = {
      companyName: 'Nandi Hills Retreat',
      companyPhone: '09876543210',
      location: { address: 'Nandi Hills, Bangalore' },
    };
    expect(findDuplicateLead(justdial, [google])).toBe(google);
    expect(buildLeadIdentityKeys(justdial)).toContain('phone:9876543210');
  });

  it('recognizes JustDial Coffee Shops as the reviewed cafe business category', () => {
    const constraints = { regions: ['Coimbatore'], industry: 'Hospitality', subIndustry: 'Cafes', targetAudience: 'Cafe owners and managers in Coimbatore' };
    expect(evaluateLeadRelevance({
      companyName: 'Kumbakonam Degree Coffee', industry: 'Coffee Shops', categories: ['Coffee Shops'],
      address: 'Saravanampatti, Coimbatore, Tamil Nadu',
    }, constraints, 'justdial').accepted).toBe(true);
    expect(evaluateLeadRelevance({
      companyName: 'Industrial Machines Supplier', industry: 'Coffee machine suppliers',
      address: 'Coimbatore, Tamil Nadu',
    }, constraints, 'justdial').accepted).toBe(false);
  });

  it('retains each exact provider payload once when sources merge', () => {
    const payload = { provider: 'justdial', actorRunId: 'run-2', raw: { title: 'Nandi Hills Retreat' } };
    const once = appendLeadSourceRecord({ title: 'Nandi Hills Retreat' }, payload);
    const twice = appendLeadSourceRecord(once, payload);
    expect(twice._sourceRecords).toEqual([payload]);
  });

  it('does not duplicate a jsonb source receipt whose object keys were reordered', () => {
    const persisted = {
      _sourceRecords: [{
        raw: { title: 'Nandi Hills Retreat', placeId: 'place-1' },
        actorRunId: 'run-2',
        platform: 'google_maps',
      }],
    };
    const replayed = {
      platform: 'google_maps',
      actorRunId: 'run-2',
      raw: { placeId: 'place-1', title: 'Nandi Hills Retreat' },
    };

    expect(appendLeadSourceRecord(persisted, replayed)._sourceRecords).toHaveLength(1);
  });

  it('deduplicates persisted source receipts even when jsonb reordered their keys', () => {
    const receipt = {
      platform: 'facebook_post_search',
      actorRunId: 'run-2',
      datasetId: 'dataset-2',
      executionId: 'lead:179:185:facebook_post_search',
    };
    const persisted = [{
      executionId: 'lead:179:185:facebook_post_search',
      datasetId: 'dataset-2',
      actorRunId: 'run-2',
      platform: 'facebook_post_search',
    }, receipt];

    expect(appendLeadSourceReceipt(persisted, receipt)).toEqual([persisted[0]]);
  });
});
