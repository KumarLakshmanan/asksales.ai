/** Shared by question-mode tool filtering and its output-evidence check. */
export const readOnlyCampaignTools = new Set([
  'get_outreach_preparation_options','get_prepared_outreach',
  'preview_outreach_retries','get_outreach_retry_preview','query_campaign_customers','query_campaign_history','create_campaign_export','get_campaign_export',
  'list_contact_workbooks','analyze_contact_files','get_dashboard_operation','review_contact_import','query_assistant_diagnostics',
  'list_proposal_templates', 'list_proposal_catalog', 'list_proposals', 'list_available_workflows', 'estimate_lead_search_cost', 'get_brandtoolkits', 'get_brandtoolkit',
  'get_businessprofiles', 'get_businessprofile', 'analytics_query',
  'query_ad_campaigns', 'query_leads', 'query_icp_profiles',
  'query_content_assets', 'query_outreach_campaigns', 'check_integration_status',
  'query_scheduled_posts', 'get_lead_shortlist',
]);
