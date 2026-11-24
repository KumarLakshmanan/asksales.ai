import type { InboxChannel } from "./outreachInbox.js";
import type { CustomerDeliveryReadiness } from './customerDeliveryReadiness.js';
import { canonicalizeTemplateVariable, normalizeTemplateVariables, TEMPLATE_TOKEN_PATTERN } from './templateVariables.js';

export interface OutreachSendingAccount {
  id: string;
  label: string;
  providerAccountId: string;
  senderId?: number;
  provider?: "gmail" | "resend";
  isDefault?: boolean;
  ready: boolean;
  reason: string | null;
  assistant?: CustomerDeliveryReadiness;
}

export interface OutreachRecipient {
  id: number;
  name: string;
  fullName?: string;
  firstName: string;
  lastName: string;
  company: string;
  email: string;
  phone: string;
  eligible: boolean;
  reason: string | null;
  recipient: string;
  conversationId?: number;
  requiresTemplate?: boolean;
}

export interface OutreachTemplate {
  id: string;
  name: string;
  language: string;
  body: string;
  header?: string;
  headerType?: string;
  headerMediaUrl?: string;
  footer?: string;
  buttons?: Array<{ type: string; text: string; url?: string }>;
}

export interface OutreachFollowUp {
  delayMinutes: number;
  message: string;
  subject?: string;
  htmlContent?: string;
  templateName?: string;
  templateLanguage?: string;
  templateComponents?: Record<string, unknown>[];
  templateDefinitionHash?: string;
}

export interface OutreachCreationOptions {
  channel: InboxChannel;
  accounts: OutreachSendingAccount[];
  /** Channel-wide block, available even when no sending account is connected. */
  deliveryBlock?: CustomerDeliveryReadiness;
}

export const OUTREACH_VARIABLES = [
  { token: "first_name", label: "First name" },
  { token: "full_name", label: "Full name" },
  { token: "company_name", label: "Company" },
  { token: "email", label: "Email" },
  { token: "phone", label: "Phone" },
] as const;

export function escapeOutreachHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

export function personalizeOutreach(
  text: string,
  recipient: OutreachRecipient,
  html = false,
): string {
  const values: Record<string, string> = {
    first_name: recipient.firstName || (recipient.fullName || recipient.name).trim().split(/\s+/)[0],
    last_name: recipient.lastName,
    full_name: recipient.fullName ?? recipient.name,
    name: recipient.fullName ?? recipient.name,
    company: recipient.company,
    company_name: recipient.company,
    email: recipient.email,
    phone: recipient.phone,
  };
  return normalizeTemplateVariables(text).replace(TEMPLATE_TOKEN_PATTERN, (original, token: string) => {
    const value = values[canonicalizeTemplateVariable(token) || token.trim().toLowerCase()];
    return value ? (html ? escapeOutreachHtml(value) : value) : original;
  });
}

export interface TemplateField {
  key: string;
  section: "header" | "body" | "button";
  token: string;
  buttonIndex?: number;
}

export function outreachTemplateFields(
  template: OutreachTemplate,
): TemplateField[] {
  const fields: TemplateField[] = [];
  for (const section of ["header", "body"] as const) {
    if (
      section === "header" &&
      template.headerType &&
      template.headerType.toUpperCase() !== "TEXT"
    )
      continue;
    const tokens = [
      ...new Set(
        Array.from(
          (template[section] || "").matchAll(/{{\s*([^}]+?)\s*}}/g),
          (match) => match[1],
        ),
      ),
    ];
    tokens.sort((a, b) =>
      /^\d+$/.test(a) && /^\d+$/.test(b)
        ? Number(a) - Number(b)
        : a.localeCompare(b),
    );
    tokens.forEach((token) =>
      fields.push({ key: `${section}:${token}`, section, token }),
    );
  }
  template.buttons?.forEach((button, index) => {
    if (button.type.toUpperCase() === "URL" && button.url?.includes("{{")) {
      fields.push({
        key: `button:${index}`,
        section: "button",
        token: button.text,
        buttonIndex: index,
      });
    }
  });
  return fields;
}

export function buildOutreachTemplate(
  template: OutreachTemplate,
  values: Record<string, string>,
  recipient: OutreachRecipient,
) {
  const fields = outreachTemplateFields(template);
  const rendered = Object.fromEntries(
    fields.map((field) => [
      field.key,
      personalizeOutreach(values[field.key] || "", recipient).trim(),
    ]),
  );
  const missing = fields
    .filter(
      (field) => !rendered[field.key] || /{{.*?}}/.test(rendered[field.key]),
    )
    .map((field) => field.key);
  const components: Record<string, unknown>[] = [];
  for (const section of ["header", "body"] as const) {
    const parameters = fields
      .filter((field) => field.section === section)
      .map((field) => ({
        type: "text",
        text: rendered[field.key],
        ...(!/^\d+$/.test(field.token) ? { parameter_name: field.token } : {}),
      }));
    if (parameters.length) components.push({ type: section, parameters });
  }
  const mediaType = template.headerType?.toLowerCase();
  if (mediaType && ["image", "video", "document"].includes(mediaType)) {
    const media = personalizeOutreach(
      values.media || template.headerMediaUrl || "",
      recipient,
    ).trim();
    const mediaId = values.mediaId?.trim();
    if (!mediaId && (!/^https:\/\/\S+$/i.test(media) || /{{.*?}}/.test(media)))
      missing.push("media");
    components.push({
      type: "header",
      parameters: [{ type: mediaType, [mediaType]: mediaId ? { id: mediaId } : { link: media } }],
    });
  }
  fields
    .filter((field) => field.section === "button")
    .forEach((field) =>
      components.push({
        type: "button",
        sub_type: "url",
        index: String(field.buttonIndex),
        parameters: [{ type: "text", text: rendered[field.key] }],
      }),
    );
  const render = (section: "header" | "body") =>
    (template[section] || "").replace(
      /{{\s*([^}]+?)\s*}}/g,
      (_, token: string) => rendered[`${section}:${token}`] || `{{${token}}}`,
    );
  const content = [
    mediaType === "text" ? render("header") : "",
    render("body"),
    template.footer,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    content,
    templateName: template.name,
    templateLanguage: template.language,
    templateComponents: components,
    missing,
  };
}
