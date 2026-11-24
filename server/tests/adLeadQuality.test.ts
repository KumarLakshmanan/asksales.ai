import { afterEach, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../models/db.js';
import { adLeadQuality } from '../services/ads/AdLeadQualityService.js';

afterEach(()=>{jest.restoreAllMocks();});

it('reports only exact tenant-scoped campaign-to-lead matches',async()=>{
  const execute=jest.spyOn(db,'execute').mockResolvedValue({rows:[{matched_leads:10,qualified_leads:4,opportunities:2,bookings:1,booked_revenue_by_currency:{INR:2500},won_pipeline_value_by_currency:{INR:9000}}]} as never);
  await expect(adLeadQuality(17,{managedCampaignId:42,providerCampaignId:'9988',start:'2026-09-01',end:'2026-09-14'})).resolves.toMatchObject({state:'available',matchedLeads:10,qualifiedLeads:4,qualificationRate:40,opportunities:2,bookings:1,bookedRevenue:2500});
  const compiled=new PgDialect().sqlToQuery(execute.mock.calls[0][0] as never);
  const query=compiled.sql;
  expect(query).toContain('pixel_events');
  expect(query).toContain('crm_contacts');
  expect(query).toContain('bookings');
  expect(compiled.params).toEqual(expect.arrayContaining([17,42,'9988','2026-09-01','2026-09-14']));
});

it('returns an actionable unavailable state when first-party attribution storage is absent',async()=>{
  jest.spyOn(db,'execute').mockRejectedValue(new Error('relation pixel_events does not exist'));
  await expect(adLeadQuality(17,{providerCampaignId:'9988',start:'2026-09-01',end:'2026-09-14'})).resolves.toMatchObject({state:'unavailable',matchedLeads:0,qualificationRate:null});
});
