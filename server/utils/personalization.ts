import { canonicalizeTemplateVariable, normalizeTemplateVariables, scanTemplateTokens, TEMPLATE_TOKEN_PATTERN } from '../../shared/templateVariables.js';

/**
 * Personalization Utility
 *
 * Resolves outreach message templates ({{first_name}}, {{company}}, etc.) into
 * concrete text using lead data — with HTML escaping for HTML contexts to
 * prevent XSS through user-controlled lead data.
 *
 * SECURITY: Lead-supplied fields (first_name, company, headline, etc.) are NOT
 * trusted. They are scraped from public sources or user uploads and may contain
 * `<script>` tags or HTML attributes. When rendered into an HTML email body
 * they MUST be escaped before substitution.
 */

/**
 * Escape the five HTML-significant characters so user-supplied lead data
 * cannot break out of an attribute or text node when injected into HTML.
 */
export function escapeHtml(input: string): string {
  if (!input) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the canonical token map for a lead.
 * Returns RAW (unescaped) values; the caller decides whether to escape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildLeadTokens(lead: any | null | undefined): Record<string, string> {
  if (!lead) return {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const l: any = lead;

  const name = String(l.full_name || l.fullName || l.name || [l.first_name || l.firstName, l.last_name || l.lastName].filter(Boolean).join(' ')).trim();
  const firstFromName = name.split(/\s+/)[0];
  const lastFromName = name.split(/\s+/).slice(1).join(' ');
  const locationStr = typeof l.location === 'object' && l.location
    ? l.location.city || l.location.country || ''
    : (l.location || '');

  return {
    '{{first_name}}': l.first_name || l.firstName || firstFromName || '',
    '{{last_name}}': l.last_name || l.lastName || lastFromName || '',
    '{{full_name}}': name,
    '{{name}}': l.name || l.first_name || l.firstName || '',
    '{{email}}': l.email || '',
    '{{phone}}': l.phone || l.whatsapp_phone || l.whatsapp || '',
    '{{company_name}}': l.company || l.company_name || l.companyName || '',
    '{{company}}': l.company || l.company_name || l.companyName || '',
    '{{job_title}}': l.role || l.job_title || l.jobTitle || '',
    '{{role}}': l.role || l.jobTitle || '',
    '{{company_industry}}': l.company_industry || l.companyIndustry || l.industry || '',
    '{{company_size}}': l.company_size || l.companySize || '',
    '{{company_website}}': l.company_website || l.companyWebsite || l.company_domain || l.companyDomain || l.website || '',
    '{{company_location}}': l.company_location || l.companyLocation || String(locationStr || ''),
    '{{department}}': l.department || '',
    '{{pain_point}}': Array.isArray(l.pain_points || l.painPoints) ? (l.pain_points || l.painPoints).join(', ') : l.pain_point || l.painPoint || l.pain_points || l.painPoints || '',
    '{{budget_range}}': l.budget_range || l.budgetRange || '',
    '{{industry}}': l.industry || '',
    '{{headline}}': l.headline || '',
    '{{location}}': String(locationStr || ''),
  };
}

export interface ApplyTokensOptions {
  /**
   * When true, all token VALUES are HTML-escaped before substitution.
   * Always pass `true` when the target string is HTML (email body, html_content).
   * Pass `false` for plain-text contexts (sms, plaintext email, social DMs).
   */
  escapeHtml?: boolean;
}

export interface ApplyTokensResult {
  text: string;
  /** Token names that appeared in the source text but had no value (empty string). */
  unresolvedTokens: string[];
}

/**
 * Replace all known tokens in `text` with values from `tokens`.
 *
 * Behaviour:
 * - Substitutes every occurrence of every known token.
 * - Missing values leave the token visible and are reported in `unresolvedTokens`.
 * - Tokens not present in the map are LEFT IN PLACE so the caller can detect
 *   unknown names; known aliases such as `{{firstName}}` share one value.
 * - When `escapeHtml: true`, every token VALUE is HTML-escaped before being
 *   inserted, so `<script>` in lead.first_name becomes `&lt;script&gt;`.
 */
export function applyTokens(
  text: string,
  tokens: Record<string, string>,
  options: ApplyTokensOptions = {}
): ApplyTokensResult {
  if (!text) return { text: '', unresolvedTokens: [] };

  const escape = options.escapeHtml === true;
  const unresolved = new Set<string>();

  const values = new Map<string, string>();
  for (const [token, rawValue] of Object.entries(tokens)) {
    const value = rawValue == null ? '' : String(rawValue);
    const name = token.replace(/^\{\{|\}\}$/g, '').trim();
    const key = canonicalizeTemplateVariable(name) || name.toLowerCase();
    if (value.trim() || !values.has(key)) values.set(key, value);
  }
  // Single-pass replacement: recipient data must not expand further template tokens.
  const result = normalizeTemplateVariables(text).replace(TEMPLATE_TOKEN_PATTERN, (token, name: string) => {
    const value = values.get(canonicalizeTemplateVariable(name) || name.trim().toLowerCase());
    if (!value?.trim()) { unresolved.add(token); return token; }
    return escape ? escapeHtml(value) : value;
  });
  for (const { token } of scanTemplateTokens(result)) unresolved.add(token);

  return { text: result, unresolvedTokens: Array.from(unresolved) };
}

/** Shared boundary for older email entry points as well as reviewed sends. */
export function personalizeLeadEmail(content: string, lead: unknown, html = false): string {
  const result = applyTokens(content, buildLeadTokens(lead), { escapeHtml: html });
  if (result.unresolvedTokens.length) {
    throw new Error(`Missing email personalization values: ${result.unresolvedTokens.join(', ')}`);
  }
  return result.text;
}
