import { normalizeTemplateVariables } from './templateVariables.js';

export interface EmailTemplateSections {
  greeting?: string;
  signature?: string;
  body?: string;
  cta?: string;
}

const FIRST_NAME_TOKEN_PATTERN = /\{\{\s*first_name\s*\}\}/gi;

function containsFirstNameToken(value: string | undefined): boolean {
  if (!value) return false;
  FIRST_NAME_TOKEN_PATTERN.lastIndex = 0;
  return FIRST_NAME_TOKEN_PATTERN.test(value);
}

function removeFirstNameToken(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(FIRST_NAME_TOKEN_PATTERN, "").trimEnd())
    .filter((line) => !/^\s*(?:hi|hello|hey|dear)\s*[-,!:]?\s*$/i.test(line))
    .join("\n")
    .replace(/[ \t]+([,;:!?])/g, "$1")
    .trim();
}

/**
 * Keeps recipient personalization in the greeting instead of allowing an
 * invalid model response to render it below the sender's signature.
 */
export function normalizeEmailTemplateSections<T extends EmailTemplateSections>(template: T): T {
  for (const key of ['greeting', 'signature', 'body', 'cta'] as const) {
    const value = template[key];
    if (typeof value === 'string') {
      const normalized = normalizeTemplateVariables(value);
      if (normalized !== value) template = { ...template, [key]: normalized };
    }
  }
  if (template.cta && template.body?.includes(template.cta)) {
    template = { ...template, cta: undefined };
  }
  if (!containsFirstNameToken(template.signature)) return template;

  const signature = removeFirstNameToken(template.signature || "");
  const greeting = containsFirstNameToken(template.greeting)
    ? template.greeting
    : "Hi {{first_name}},";

  return {
    ...template,
    greeting,
    signature: signature || undefined,
  };
}

export interface EmailDraft {
  subject: string;
  preheader: string;
  /** Complete plain-text message, including separately stored sections. */
  body: string;
  html: string;
  sections: Record<string, unknown> & EmailTemplateSections;
}

/** One adapter for provider responses, saved assets, previews and campaign copies. */
export function readEmailDraft(content: unknown): EmailDraft {
  let value = content;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { /* Plain-text emails are supported. */ }
  }
  const fields = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const string = (key: string) => typeof fields[key] === 'string' ? fields[key] as string : '';
  const sections = normalizeEmailTemplateSections({ ...fields, greeting: string('greeting'), signature: string('signature') });
  const main = string('body') || string('emailBody') || string('text') || string('message') || string('content') || (typeof value === 'string' ? value : '');
  const cta = string('cta');
  const body = [sections.greeting, main, cta && !main.includes(cta) ? cta : '', string('closing'), sections.signature].filter(Boolean).join('\n\n');
  return {
    subject: string('subject') || string('emailSubject'),
    preheader: string('preheader'),
    body,
    html: string('htmlContent') || string('html'),
    sections: { ...sections, body: main },
  };
}
