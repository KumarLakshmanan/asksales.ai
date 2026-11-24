import { canonicalizeTemplateVariable, extractTemplateVariables } from '../../../shared/templateVariables.js';
import { applyTokens, buildLeadTokens } from '../../utils/personalization.js';
import { assertResolvedEmailTemplate } from '../../utils/emailTemplateVariables.js';

const businessVariables = new Set(['your_company_name', 'your_industry', 'your_website', 'value_proposition', 'target_audience']);

/** Resolve explicit human-authored templates only. Never expand raw model replies with private lead data. */
export async function resolveLeadEmailTokens(userId: number, lead: unknown, content: Array<string | null | undefined>) {
  const requested = extractTemplateVariables(content.filter(Boolean).join('\n')).map(canonicalizeTemplateVariable);
  const values = buildLeadTokens(lead);
  let timeZone = 'UTC';
  if (requested.some(name => name && businessVariables.has(name))) {
    const { resolveContentBrandContext } = await import('./ContentBrandContextService.js');
    const { businessProfile } = await resolveContentBrandContext(userId);
    const business = {
      your_company_name: businessProfile.companyName || businessProfile.businessName,
      your_industry: businessProfile.industry, your_website: businessProfile.website,
      value_proposition: businessProfile.valueProposition, target_audience: businessProfile.targetMarket,
    };
    for (const [key, value] of Object.entries(business)) if (value) values[`{{${key}}}`] = String(value);
    timeZone = businessProfile.timezone || 'UTC';
  }
  const now = new Date();
  values['{{current_date}}'] = now.toLocaleDateString('en-US', { timeZone });
  values['{{current_year}}'] = now.toLocaleString('en-US', { timeZone, year: 'numeric' });
  values['{{current_month}}'] = now.toLocaleString('en-US', { timeZone, month: 'long' });
  return values;
}

export function renderLeadEmailField(content: string, tokens: Record<string, string>, html = false): string {
  const result = applyTokens(content, tokens, { escapeHtml: html });
  assertResolvedEmailTemplate(html ? { html: result.text } : { text: result.text });
  return result.text;
}
