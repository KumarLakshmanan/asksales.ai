import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';

export interface AdLeadQuality {
  state: 'available' | 'no_matches' | 'unavailable';
  matchedLeads: number;
  qualifiedLeads: number;
  opportunities: number;
  bookings: number;
  bookedRevenue: number | null;
  wonPipelineValue: number | null;
  bookedRevenueByCurrency: Record<string, number>;
  wonPipelineValueByCurrency: Record<string, number>;
  currency: string | null;
  qualificationRate: number | null;
  attribution: string;
  limitation: string;
}

/** Exact first-party event attribution only; no inferred email/name joins. */
export async function adLeadQuality(userId:number,input:{managedCampaignId?:number|null;providerCampaignId:string;start:string;end:string}):Promise<AdLeadQuality> {
  try {
    const result=await db.execute(sql`
      WITH matched_events AS (
        SELECT DISTINCT event.lead_id
        FROM pixel_events event
        WHERE event.user_id=${userId}
          AND event.timestamp>=${input.start}::timestamp AND event.timestamp<(${input.end}::date + INTERVAL '1 day')
          AND event.lead_id IS NOT NULL
          AND (
            (${input.managedCampaignId || null}::int IS NOT NULL AND event.campaign_id=${input.managedCampaignId || null})
            OR (event.campaign_id IS NULL AND (
            event.utm_campaign=${input.providerCampaignId}
            OR event.properties->>'platformCampaignId'=${input.providerCampaignId}
            OR event.properties->>'campaign_id'=${input.providerCampaignId}))
          )
      ), matched AS (
        SELECT DISTINCT ON (lead.id) lead.id,
          LOWER(COALESCE(contact.pipeline_status,contact.status,lead.lead_status,lead.status,'new')) AS stage,
          COALESCE(contact.deal_value,0)::numeric AS deal_value,
          COALESCE(contact.currency,'') AS currency
        FROM matched_events event JOIN leads lead ON lead.id=event.lead_id AND lead.user_id=${userId} AND lead.deleted_at IS NULL
        LEFT JOIN crm_contacts contact ON contact.user_id=${userId} AND contact.lead_id=lead.id AND contact.deleted_at IS NULL
        ORDER BY lead.id, contact.updated_at DESC NULLS LAST, contact.id DESC
      ), booking_rows AS (
        SELECT booking.* FROM bookings booking JOIN matched ON matched.id=booking.lead_id WHERE booking.user_id=${userId}
      ), booking_totals AS (
        SELECT COUNT(DISTINCT booking.id)::int AS bookings
        FROM booking_rows booking
      ), booking_values AS (
        SELECT COALESCE(NULLIF(UPPER(TRIM(currency)),''),'UNKNOWN') AS currency, SUM(total_price)::numeric AS value
        FROM booking_rows WHERE status IN ('confirmed','checked_in','checked_out','completed') OR payment_status='paid'
        GROUP BY 1
      ), won_values AS (
        SELECT COALESCE(NULLIF(UPPER(TRIM(currency)),''),'UNKNOWN') AS currency, SUM(deal_value)::numeric AS value
        FROM matched WHERE stage IN ('won','converted') GROUP BY 1
      )
      SELECT COUNT(DISTINCT matched.id)::int AS matched_leads,
        COUNT(DISTINCT matched.id) FILTER(WHERE matched.stage IN ('qualified','opportunity','proposal','negotiation','won','converted'))::int AS qualified_leads,
        COUNT(DISTINCT matched.id) FILTER(WHERE matched.stage IN ('opportunity','proposal','negotiation','won','converted'))::int AS opportunities,
        COALESCE(MAX(booking_totals.bookings),0)::int AS bookings,
        COALESCE((SELECT jsonb_object_agg(currency,value) FROM booking_values),'{}'::jsonb) AS booked_revenue_by_currency,
        COALESCE((SELECT jsonb_object_agg(currency,value) FROM won_values),'{}'::jsonb) AS won_pipeline_value_by_currency
      FROM matched LEFT JOIN booking_totals ON TRUE`);
    const row=result.rows[0] as Record<string,unknown>|undefined; const matchedLeads=Number(row?.matched_leads||0); const qualifiedLeads=Number(row?.qualified_leads||0);
    const bookedRevenueByCurrency = (row?.booked_revenue_by_currency || {}) as Record<string, number>;
    const wonPipelineValueByCurrency = (row?.won_pipeline_value_by_currency || {}) as Record<string, number>;
    const currencies = [...new Set([...Object.keys(bookedRevenueByCurrency), ...Object.keys(wonPipelineValueByCurrency)])];
    const currency = currencies.length === 1 && /^[A-Z]{3}$/.test(currencies[0]) ? currencies[0] : null;
    return {state:matchedLeads?'available':'no_matches',matchedLeads,qualifiedLeads,opportunities:Number(row?.opportunities||0),bookings:Number(row?.bookings||0),
      bookedRevenue:currency ? Number(bookedRevenueByCurrency[currency] || 0) : null,
      wonPipelineValue:currency ? Number(wonPipelineValueByCurrency[currency] || 0) : null,
      bookedRevenueByCurrency,wonPipelineValueByCurrency,currency,qualificationRate:matchedLeads?100*qualifiedLeads/matchedLeads:null,
      attribution:'Leads with exact first-party campaign events in the selected UTC window.',
      limitation:'Downstream bookings and current won pipeline values are lifetime outcomes for this matched lead cohort, grouped by their own currency. They are not time-window revenue or an allocated multi-touch attribution model. Unlinked records are excluded; identity is not inferred from names or email addresses.'};
  } catch {
    return {state:'unavailable',matchedLeads:0,qualifiedLeads:0,opportunities:0,bookings:0,bookedRevenue:null,wonPipelineValue:null,bookedRevenueByCurrency:{},wonPipelineValueByCurrency:{},currency:null,qualificationRate:null,attribution:'No exact first-party campaign-to-lead evidence is queryable.',limitation:'Connect first-party event tracking with campaign and lead IDs to compare provider leads with CRM qualification, opportunities, bookings, and revenue.'};
  }
}
