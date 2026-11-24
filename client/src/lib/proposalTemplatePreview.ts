import {
  fillProposalFields,
  materializeProposalTemplate,
  type ProposalDocument,
  type ProposalSection,
} from "../../../shared/proposals";
import type { ProposalTemplateDraft } from "../../../shared/proposalTemplateRules";

export const TEMPLATE_PREVIEW_FIELDS: Record<string, string> = {
  client_name: "Alex Morgan · Acme Co",
  customer_name: "Alex Morgan · Acme Co",
  client_email: "alex@example.test",
  recipient_email: "alex@example.test",
  company_name: "Northstar Studio",
  proposal_title: "A clear plan for your next stage",
  proposal_number: "PREVIEW-001",
  currency: "USD",
  valid_until: "2026-10-15",
  today: "2026-09-15",
};

function sampleSection(section: ProposalSection): string {
  if (section.kind === "cover")
    return "Northstar Studio will help Acme Co. turn the agreed objectives into a practical delivery plan. This engagement combines a discovery workshop, a defined implementation scope, and a documented handover.";
  if (section.kind === "terms")
    return "A 50% deposit confirms the engagement. The balance is due within 14 days of handover. Both teams approve changes to scope, fees, or timing in writing before work begins.";
  if (section.kind === "closing")
    return "Once the scope and investment are approved, we will schedule the kickoff and confirm the primary contacts for delivery.";
  if (/timeline|milestone|investment|launch/i.test(section.title))
    return "| Milestone | Target |\n| --- | --- |\n| Discovery and scope confirmation | Week 1 |\n| Implementation and customer review | Weeks 2–3 |\n| Final review and handover | Week 4 |";
  if (
    /deliver|scope|service|design|development|content|configuration/i.test(
      section.title,
    )
  )
    return "- One discovery workshop with the customer team\n- A documented delivery plan and agreed implementation\n- Two review rounds with a single decision maker\n- Final handover, supporting files, and a training session\n\nAcme Co. supplies the required access and approved materials before implementation begins.";
  if (/report|measure|success|quality|governance/i.test(section.title))
    return "We will review progress together each week. The final review checks the agreed deliverables against the acceptance criteria, records open actions, and assigns an owner to each follow-up.";
  return "The team will confirm the current requirements in a discovery workshop, document the agreed decisions, and share the plan for approval. Acme Co. will nominate one contact to provide consolidated feedback within two working days.";
}

/** Sample content is confined to previews; the template body and saved proposal are never changed. */
export function buildProposalTemplatePreview(
  template: ProposalTemplateDraft,
  fields = TEMPLATE_PREVIEW_FIELDS,
): ProposalDocument {
  const materialized = materializeProposalTemplate(
    template.templateContent?.sections || [],
    fields,
  );
  return {
    title: fillProposalFields(template.name || "Proposal preview", fields),
    proposalNumber: fields.proposal_number || "PREVIEW-001",
    recipientName: fields.client_name,
    recipientEmail: fields.client_email,
    coverNote: template.coverNote ? fillProposalFields(template.coverNote, fields) : undefined,
    termsAndConditions: template.termsAndConditions ? fillProposalFields(template.termsAndConditions, fields) : undefined,
    currency: "USD",
    validUntil: fields.valid_until,
    lineItems: template.lineItems?.length ? template.lineItems.map(item => ({ ...item, name: fillProposalFields(item.name, fields), description: item.description ? fillProposalFields(item.description, fields) : undefined })) : [
      {
        name: "Discovery and delivery plan",
        description: "Workshop, agreed scope and success measures",
        quantity: 1,
        unitPrice: 750,
        unit: "engagement",
      },
      {
        name: "Implementation and handover",
        description: "Delivery, two review rounds and team handover",
        quantity: 1,
        unitPrice: 2250,
        unit: "engagement",
      },
    ],
    discountType: "fixed",
    discountValue: template.lineItems?.length ? 0 : 150,
    taxRate: template.lineItems?.length ? 0 : 10,
    metadata: {
      generatedSections: materialized.sections.map((section) => ({
        ...section,
        body: section.body.trim() ? section.body : sampleSection(section),
      })),
    },
  };
}
