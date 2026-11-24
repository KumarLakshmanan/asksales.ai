/**
 * Template Variable Utilities for Client
 * Handles template variables that can be replaced with ICP/Lead data
 */
import { escapeOutreachHtml } from "../../../shared/outreachCompose";

// Variable categories for UI
export { VARIABLE_CATEGORIES, ALL_VARIABLES } from '../../../shared/templateVariables';
import { canonicalizeTemplateVariable, normalizeTemplateVariables, scanTemplateTokens, TEMPLATE_TOKEN_PATTERN } from '../../../shared/templateVariables';

/**
 * Interface for replacement data
 */
export interface TemplateReplacementData {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  companyIndustry?: string;
  companySize?: string;
  companyWebsite?: string;
  companyLocation?: string;
  jobTitle?: string;
  department?: string;
  yourCompanyName?: string;
  yourIndustry?: string;
  valueProposition?: string;
  yourWebsite?: string;
  targetAudience?: string;
  painPoint?: string;
  budgetRange?: string;
}

export type TemplateVariableMap = Record<string, string | number | null | undefined>;

function canonicalVariableName(name: string): string {
  const normalized = name.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s-]+/g, '_');
  return canonicalizeTemplateVariable(normalized) || normalized;
}

export function renderTemplateVariableMap(
  content: string,
  values: TemplateVariableMap,
): { content: string; unresolved: string[] } {
  const canonicalValues = new Map<string, string>();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      canonicalValues.set(canonicalVariableName(key), String(value));
    }
  });

  const rendered = normalizeTemplateVariables(content).replace(TEMPLATE_TOKEN_PATTERN, (token, rawName: string) => (
    canonicalValues.get(canonicalVariableName(rawName)) ?? token
  ));

  return { content: rendered, unresolved: findUnresolvedTemplateTokens(rendered) };
}

export function findUnresolvedTemplateTokens(...values: Array<string | undefined | null>): string[] {
  const tokens = new Set<string>();
  values.forEach((value) => {
    for (const token of scanTemplateTokens(value ?? '')) {
      tokens.add(token.valid ? canonicalVariableName(token.name) : token.token);
    }
  });
  return [...tokens];
}

/**
 * Replace template variables in content with actual values
 */
export function replaceTemplateVariables(content: string, data: TemplateReplacementData, options: { now?: Date; timeZone?: string } = {}): string {
  if (!content) return content;

  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? 'UTC';
  return renderTemplateVariableMap(content, {
    ...data,
    current_date: now.toLocaleDateString('en-US', { timeZone }),
    current_year: now.toLocaleString('en-US', { timeZone, year: 'numeric' }),
    current_month: now.toLocaleString('en-US', { timeZone, month: 'long' }),
  }).content;
}

/**
 * Replace exact template tokens with caller-provided values. This is useful
 * when each recipient has campaign-specific overrides that should take
 * precedence over their saved lead data.
 */
export function replaceTemplateVariableValues(
  content: string,
  values: Record<string, string | undefined>,
  options?: { escapeHtml?: boolean },
): string {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([variable, value]) => [variable.replace(/^\{\{|\}\}$/g, ''), options?.escapeHtml && value !== undefined ? escapeOutreachHtml(value) : value]),
  );
  return renderTemplateVariableMap(content, normalized).content;
}

/**
 * Extract template variables from content
 */
export function extractVariables(content: string): string[] {
  return findUnresolvedTemplateTokens(content).map((token) => `{{${token}}}`);
}

/**
 * Check if content has unreplaced variables
 */
export function hasUnreplacedVariables(content: string): boolean {
  return findUnresolvedTemplateTokens(content).length > 0;
}

/**
 * Highlight variables in text for preview
 */
export function highlightVariables(content: string): string {
  if (!content) return content;
  
  return content.replace(
    /\{\{([a-z_]+)\}\}/gi,
    '<span class="bg-purple-100 text-purple-700 px-1 rounded font-mono text-sm">{{$1}}</span>'
  );
}
