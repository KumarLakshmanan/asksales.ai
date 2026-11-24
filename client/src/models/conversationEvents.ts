/**
 * WebSocket event types used by the conversations page.
 * Extracted from the conversations page for reusability.
 */

/** ICP Profile shape used in the conversations page */
export interface ICPProfile {
  campaign_name?: string;
  campaign_objective?: string;
  target_audience?: string;
  industry_vertical?: string;
  business_type?: string;
  geography_locations?: string[];
  target_roles_titles?: string[];
  interests?: string[];
  sources?: string[];
  company_size?: string;
  revenue_range?: string;
  technologies?: string[];
  pain_points?: string[];
  buying_triggers?: string[];
  decision_makers?: string[];
  summary?: string;
  keywords?: string[];
  messaging_themes?: string[];
  company_name?: string;
  company_website?: string;
  company_address?: string;
  primary_value_proposition?: string;
  primary_regions?: string[];
  primary_job_titles?: string[];
  primary_channels?: string[];
}
