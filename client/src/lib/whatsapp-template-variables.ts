export type WhatsAppTemplateComponent = "header" | "body";
export type WhatsAppTemplateExamples = Record<string, string>;

const numberedVariablePattern = /{{\s*(\d+)\s*}}/g;

export function whatsappVariableIndexes(value: string): string[] {
  return [...new Set(Array.from(value.matchAll(numberedVariablePattern), (match) => String(Number(match[1]))))]
    .sort((left, right) => Number(left) - Number(right));
}

export function whatsappVariableError(value: string, label: string): string | null {
  const withoutNumberedVariables = value.replace(numberedVariablePattern, "");
  if (/{{|}}/.test(withoutNumberedVariables)) {
    return `${label} variables must use Meta's numbered format, such as {{1}}.`;
  }

  const indexes = whatsappVariableIndexes(value).map(Number);
  if (indexes.some((index, position) => index !== position + 1)) {
    return `${label} variables must start at {{1}} and continue without gaps.`;
  }
  return null;
}

export function whatsappExampleKey(component: WhatsAppTemplateComponent, index: string): string {
  return `${component}:${Number(index)}`;
}

export function readWhatsAppExample(
  examples: WhatsAppTemplateExamples | null | undefined,
  component: WhatsAppTemplateComponent,
  index: string,
): string {
  if (!examples) return "";
  return examples[whatsappExampleKey(component, index)] || examples[String(Number(index))] || "";
}

export function normalizeWhatsAppExamples(
  examples: WhatsAppTemplateExamples | null | undefined,
  header: string,
  body: string,
): WhatsAppTemplateExamples {
  const normalized: WhatsAppTemplateExamples = {};
  ([
    ["header", header],
    ["body", body],
  ] as const).forEach(([component, value]) => {
    whatsappVariableIndexes(value).forEach((index) => {
      normalized[whatsappExampleKey(component, index)] = readWhatsAppExample(examples, component, index) || `Example ${index}`;
    });
  });
  return normalized;
}

export function applyWhatsAppExamples(
  value: string,
  examples: WhatsAppTemplateExamples | null | undefined,
  component: WhatsAppTemplateComponent,
): string {
  return value.replace(numberedVariablePattern, (placeholder, rawIndex: string) =>
    readWhatsAppExample(examples, component, rawIndex).trim() || placeholder);
}

