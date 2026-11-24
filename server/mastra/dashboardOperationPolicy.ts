
/** These prepare derived data/reviews only. CRM imports and customer delivery
 * still require their existing explicit, bound dashboard confirmation. */
export const dashboardOperationKinds=['none','contact_analysis','contact_import_review','operation_status','assistant_diagnostics','campaign_report','campaign_prepare','queue_review','customer_engagement','report_export'] as const;
export type DashboardOperationIntent=typeof dashboardOperationKinds[number];
const tools:Record<Exclude<DashboardOperationIntent,'none'>,readonly string[]>={
  contact_analysis:['list_contact_workbooks','analyze_contact_files','get_dashboard_operation','review_contact_import'],
  contact_import_review:['get_dashboard_operation','review_contact_import'],
  operation_status:['get_dashboard_operation'],
  assistant_diagnostics:['query_assistant_diagnostics','check_integration_status'],
  campaign_report:['analytics_query','query_outreach_campaigns'],
  campaign_prepare:['get_outreach_preparation_options','get_dashboard_operation','prepare_outreach_campaign','get_prepared_outreach'],
  report_export:['create_campaign_export','get_campaign_export','analytics_query'],
  customer_engagement:['query_campaign_customers','query_campaign_history','analytics_query'],
  queue_review:['preview_outreach_retries','get_outreach_retry_preview','analytics_query'],
};
export function dashboardOperationTools(operation:DashboardOperationIntent|undefined):readonly string[]|null {
  return operation && operation!=='none' ? tools[operation] : null;
}
export function dashboardOperationAgent(operation:DashboardOperationIntent):'lead_generation'|'outreach'|null {
  return operation==='none' ? null : ['contact_analysis','contact_import_review','operation_status'].includes(operation) ? 'lead_generation' : 'outreach';
}
