import {
  isProposalAuthoringInstruction,
  unresolvedProposalFields,
  type ProposalSection,
  type ProposalLineItem,
} from "./proposals";

export type ProposalTemplateDraft = {
  name: string;
  category?: string | null;
  coverNote?: string | null;
  termsAndConditions?: string | null;
  lineItems?: ProposalLineItem[] | null;
  templateContent?: {
    sections: ProposalSection[];
    placeholders: string[];
    warnings: string[];
    requiredFields?: string[];
  } | null;
};

export const PROPOSAL_TEMPLATE_CATEGORIES = [
  "General",
  "Marketing",
  "Web and software",
  "Consulting",
  "Branding",
  "Customer operations",
  "Sales",
  "Retainers",
];
export const AUTOMATIC_PROPOSAL_FIELDS = [
  "client_name",
  "customer_name",
  "client_email",
  "recipient_email",
  "company_name",
  "proposal_title",
  "proposal_number",
  "currency",
  "valid_until",
  "today",
];

export function templateFieldName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, "_");
}

export function getProposalTemplateFields(
  template: ProposalTemplateDraft,
): string[] {
  return unresolvedProposalFields(
    [template.coverNote || '', template.termsAndConditions || '', ...(template.lineItems || []).map(item => `${item.name}\n${item.description || ''}`), (template.templateContent?.sections || [])
      .map(
        (section) =>
          `${section.title}\n${section.body}\n${section.instruction || ""}`,
      )
      .join("\n")].join('\n'),
  );
}

/** Publishing checks are shared by the editor and API. A template may intentionally contain guidance without customer copy. */
export function validateProposalTemplate(
  template: ProposalTemplateDraft,
  publishing = false,
): string[] {
  const errors: string[] = [];
  if (!template.name.trim()) errors.push("Enter a template name.");
  if (template.name.length > 255)
    errors.push("Keep the template name under 256 characters.");
  if (
    !(template.category || "General").trim() ||
    (template.category || "").length > 100
  )
    errors.push("Enter a category of 100 characters or fewer.");
  const sections = template.templateContent?.sections || [];
  if (!sections.length) errors.push("Add at least one document section.");
  if (sections.length > 200) errors.push("Use no more than 200 sections.");
  sections.forEach((section, index) => {
    if (!section.title.trim())
      errors.push(`Give section ${index + 1} a title.`);
    if (publishing && !section.body.trim() && !section.instruction?.trim())
      errors.push(
        `Add customer copy or writing guidance to “${section.title || `Section ${index + 1}`}”.`,
      );
    if (publishing && isProposalAuthoringInstruction(section.body))
      errors.push(
        `Move the writing prompt in “${section.title}” to writing guidance.`,
      );
  });
  const required = (template.templateContent?.requiredFields || []).map(
    templateFieldName,
  );
  if (required.some((field) => !/^[a-z][a-z0-9_]{0,199}$/.test(field)))
    errors.push(
      "Required fields must start with a letter and use letters, numbers, or underscores.",
    );
  if (new Set(required).size !== required.length)
    errors.push("List each required field once.");
  if (publishing) {
    const unlisted = getProposalTemplateFields(template).filter(
      (field) =>
        !AUTOMATIC_PROPOSAL_FIELDS.includes(field) && !required.includes(field),
    );
    if (unlisted.length)
      errors.push(
        `Add these placeholders to required fields: ${unlisted.join(", ")}.`,
      );
  }
  return errors;
}
