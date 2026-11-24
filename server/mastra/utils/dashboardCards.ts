import {dashboardResultCards} from '../../../shared/dashboardOperations.js';
import type {ToolCallResult} from './toolCallingLoop.js';
const cardTools=new Set(['analytics_query','list_contact_workbooks','analyze_contact_files','get_dashboard_operation','review_contact_import','query_assistant_diagnostics','get_outreach_preparation_options','prepare_outreach_campaign','get_prepared_outreach','preview_outreach_retries','get_outreach_retry_preview','query_campaign_customers','query_campaign_history','create_campaign_export','get_campaign_export']);
/** Cards come from successful application receipts, never model prose. */
export function operationCardsFromReceipts(results:ToolCallResult[],businessProfileId:number) {
  const cards=results.filter(receipt=>receipt.success && cardTools.has(receipt.toolName) && receipt.result?.success!==false)
    .flatMap(receipt=>dashboardResultCards([receipt.result?.output?.card])).map(card=>({...card,businessProfileId}));
  return [...new Map(cards.map(card=>[card.operation?.id || JSON.stringify(card),card])).values()].slice(0,6);
}
