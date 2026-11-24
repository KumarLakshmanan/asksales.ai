import * as cheerio from 'cheerio';

import { canonicalizeTemplateVariable, findUnresolvedTemplateVariables, findUnknownTemplateVariables, normalizeTemplateVariables, TEMPLATE_TOKEN_PATTERN } from '../../shared/templateVariables.js';
export { CANONICAL_TEMPLATE_VARIABLES, canonicalizeTemplateVariable, extractTemplateVariables, findUnresolvedTemplateVariables, findUnknownTemplateVariables } from '../../shared/templateVariables.js';
export type { CanonicalTemplateVariable } from '../../shared/templateVariables.js';
import type { CanonicalTemplateVariable } from '../../shared/templateVariables.js';
import { escapeHtml } from '../../shared/html.js';


export interface RenderTemplateResult {
  rendered: string;
  unresolved: string[];
  unknown: string[];
}

export function renderContentTemplate(
  content: string,
  values: Record<string, string | number | null | undefined>,
  options: { escapeHtml?: boolean; now?: Date; timeZone?: string } = {},
): RenderTemplateResult {
  content = normalizeTemplateVariables(content);
  const canonicalValues = new Map<CanonicalTemplateVariable, string>();
  for (const [key, value] of Object.entries(values)) {
    if (value == null) continue;
    const canonical = canonicalizeTemplateVariable(key.replace(/^\{\{|\}\}$/g, ''));
    if (canonical) canonicalValues.set(canonical, String(value));
  }

  const now = options.now ?? new Date();
  // A deterministic default also keeps callers outside an approved business
  // context independent of the worker host. Business callers pass its zone.
  const timeZone = options.timeZone ?? 'UTC';
  canonicalValues.set('current_date', now.toLocaleDateString('en-US', { timeZone }));
  canonicalValues.set('current_year', now.toLocaleString('en-US', { timeZone, year: 'numeric' }));
  canonicalValues.set('current_month', now.toLocaleString('en-US', { timeZone, month: 'long' }));

  const unknown = new Set<string>(findUnknownTemplateVariables(content));
  const rendered = content.replace(TEMPLATE_TOKEN_PATTERN, (token, rawVariable: string) => {
    const canonical = canonicalizeTemplateVariable(rawVariable);
    if (!canonical) {
      unknown.add(token);
      return token;
    }
    const replacement = canonicalValues.get(canonical);
    if (replacement == null || replacement === '') return token;
    return options.escapeHtml ? escapeHtml(replacement) : replacement;
  });

  return {
    rendered,
    unresolved: [...new Set([...findUnresolvedTemplateVariables(rendered), ...unknown])],
    unknown: [...unknown],
  };
}

function isSafeUrl(value: string, allowedProtocols: string[], allowRelative = false): boolean {
  const trimmed = value.trim();
  if (trimmed.includes('{{') && trimmed.includes('}}')) return true;
  if (allowRelative && trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  try {
    const parsed = new URL(trimmed);
    return allowedProtocols.includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Sanitize generated/stored email HTML before it is returned for preview or
 * passed to a delivery provider. This intentionally keeps email layout tags
 * and inline styles while stripping executable/embedded content and dangerous
 * URL/CSS schemes.
 */
export function sanitizeEmailHtml(html: string): string {
  const isDocument = /<!doctype|<html[\s>]/i.test(html);
  const $ = cheerio.load(html, { xmlMode: false });

  $('script, iframe, frame, frameset, object, embed, form, input, button, textarea, select, option, base, link, svg, math').remove();
  $('meta[http-equiv]').remove();

  $('*').each((_index, element) => {
    const attributes = { ...(element.type === 'tag' ? element.attribs : {}) };
    for (const [name, value] of Object.entries(attributes)) {
      const lowerName = name.toLowerCase();
      const lowerValue = String(value || '').trim().toLowerCase();
      if (
        lowerName.startsWith('on')
        || lowerName === 'srcdoc'
        || lowerName === 'formaction'
        || lowerName === 'xmlns'
      ) {
        $(element).removeAttr(name);
        continue;
      }
      if (lowerName === 'style') {
        if (
          /(?:expression|javascript\s*:|vbscript\s*:|@import|-moz-binding|behavior\s*:)/i.test(lowerValue)
          || /url\s*\(\s*['"]?\s*(?!https?:|cid:|\/|\{\{)/i.test(lowerValue)
        ) {
          $(element).removeAttr(name);
        }
        continue;
      }
      if (lowerName === 'href' && !isSafeUrl(String(value), ['http:', 'https:', 'mailto:', 'tel:'], true)) {
        $(element).removeAttr(name);
        continue;
      }
      if (lowerName === 'src' && !isSafeUrl(String(value), ['http:', 'https:', 'cid:'], true)) {
        $(element).removeAttr(name);
        continue;
      }
      if (lowerName === 'background' && !isSafeUrl(String(value), ['http:', 'https:', 'cid:'], true)) {
        $(element).removeAttr(name);
      }
    }
  });

  $('style').each((_index, element) => {
    const css = $(element).text();
    if (/(?:expression|javascript\s*:|vbscript\s*:|@import|-moz-binding|behavior\s*:)/i.test(css)) {
      $(element).remove();
    }
  });

  $('a[href]').attr('rel', 'noopener noreferrer nofollow');
  return isDocument ? $.html() : ($('body').html() || '');
}
