import { getSuppressedRecipients, normalizeOutreachDestination } from './RecipientSuppressionService.js';
import { assertCustomerDeliveryRuntime, customerDeliveryReadiness, deliverySetupFailure } from '../assistants/CustomerDeliveryGate.js';
import { and, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { businessCacheKey, requireBusinessScope } from "../../tenancy/businessContext.js";
import { creationImportPredicate, type ImportSourceFilter } from './CreationImportSources.js';
import { leadsTable, type LeadRecord } from "../../models/leads/schema.js";
import { channelCredentialsTable } from "../../models/channelCredentials/schema.js";
import { crmContactsTable } from "../../models/crmContacts/schema.js";
import {
  getById,
  getDefault,
  listByUser,
} from "../../models/emailSenders/functions.js";
import {
  resolveOfficialProviderBinding,
  type ProviderBinding,
} from "./ProviderBindingService.js";
import { activeWhatsAppWindows } from "../whatsappServiceWindow.js";
import { parseUtcDatabaseTimestamp } from "../socialFollowUpService.js";
import type { InboxChannel } from "../../../shared/outreachInbox.js";
import { normalizeMSG91Phone } from "../../../shared/msg91.js";
import { WHATSAPP_NUMBER_HELP, firstWhatsAppNumberSource, normalizeWhatsAppNumber } from "../../../shared/whatsappPhone.js";
import {
  outreachTemplateFields,
  type OutreachCreationOptions,
  type OutreachRecipient,
  type OutreachSendingAccount,
  type OutreachTemplate,
} from "../../../shared/outreachCompose.js";
import { isEmailAddress } from "../../../shared/emailAddress.js";
import { trackingChannelLabel } from "../../../shared/outreachTracking.js";
import { sha256Json as creationTemplateHash } from "../../utils/sha256.js";
export { creationTemplateHash };

export interface AccountSelection {
  providerAccountId?: string;
  senderId?: number;
}

/** A deliberate CRM send can prepare a phone-only contact; native social sessions keep their existing lead identity. */
export async function prepareCreationContact(
  userId: number,
  contactId: number,
  channel: InboxChannel,
  selection: AccountSelection,
): Promise<{ leadId?: number; error?: string }> {
  const { account } = await resolveCreationAccount(userId, channel, selection);
  if (!account.ready)
    return { error: account.reason || "Choose a ready sending account." };
  return db.transaction(async (tx: typeof db) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${businessCacheKey(`outreach-contact:${userId}:${contactId}`)}))`,
    );
    const [contact] = await tx
      .select({
        id: crmContactsTable.id,
        leadId: crmContactsTable.leadId,
        firstName: crmContactsTable.firstName,
        lastName: crmContactsTable.lastName,
        email: crmContactsTable.email,
        phone: crmContactsTable.phone,
        company: crmContactsTable.company,
        role: crmContactsTable.role,
      })
      .from(crmContactsTable)
      .where(
        and(
          eq(crmContactsTable.id, contactId),
          eq(crmContactsTable.userId, userId),
          isNull(crmContactsTable.deletedAt),
        ),
      )
      .limit(1);
    if (!contact) return { error: "This CRM contact is unavailable." };
    if (channel !== "email") {
      const existing = await tx.execute(sql`
        SELECT c.lead_id FROM outreach_conversations c JOIN leads l ON l.id=c.lead_id
        WHERE c.user_id=${userId} AND l.user_id=${userId} AND l.deleted_at IS NULL
          AND c.crm_contact_id=${contactId} AND c.channel=${channel} AND c.provider_account_id=${account.providerAccountId}
        ORDER BY c.last_message_at DESC NULLS LAST,c.id DESC LIMIT 1
      `);
      if (existing.rows[0]?.lead_id)
        return { leadId: Number(existing.rows[0].lead_id) };
    }
    if (contact.leadId) {
      const [linked] = await tx
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.id, contact.leadId),
            eq(leadsTable.userId, userId),
            isNull(leadsTable.deletedAt),
          ),
        )
        .limit(1);
      return linked
        ? { leadId: linked.id }
        : {
            error:
              "The contact’s linked lead is unavailable. Update the link in CRM.",
          };
    }
    if (channel === "instagram" || channel === "facebook")
      return {
        error:
          "This contact has no conversation with the selected account. The customer must message your account first.",
      };
    const email = String(contact.email || "")
      .trim()
      .toLowerCase();
    const phone = normalizeWhatsAppNumber(contact.phone) || "";
    const validEmail = isEmailAddress(email);
    const validPhone = Boolean(phone);
    if (
      (channel === "email" && !validEmail) ||
      (channel === "whatsapp" && !validPhone) ||
      (channel === "sms" && !normalizeMSG91Phone(String(contact.phone || '')))
    )
      return {
        error:
          channel === "email"
            ? "Add a valid email address to this contact in CRM."
            : channel === "sms" ? "Add a valid SMS phone number in CRM." : WHATSAPP_NUMBER_HELP,
      };
    const matches = await tx
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.userId, userId),
          isNull(leadsTable.deletedAt),
          or(
            ...(validEmail ? [sql`lower(${leadsTable.email})=${email}`] : []),
            ...(validPhone
              ? [
                  sql`regexp_replace(normalize(${leadsTable.phone},NFKC),'[^0-9]','','g')=${phone}`,
                  sql`regexp_replace(normalize(${leadsTable.whatsapp},NFKC),'[^0-9]','','g')=${phone}`,
                ]
              : []),
          ),
        ),
      )
      .limit(2);
    if (matches.length > 1)
      return {
        error:
          "Several outreach contacts match these details. Link the correct lead in CRM before sending.",
      };
    let leadId = matches[0]?.id;
    if (!leadId) {
      const [created] = await tx
        .insert(leadsTable)
        .values({
          userId,
          source: "crm_sync",
          firstName: contact.firstName,
          lastName: contact.lastName,
          fullName:
            [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
            null,
          email: validEmail ? email : null,
          phone: validPhone ? phone : null,
          company: contact.company,
          companyName: contact.company,
          role: contact.role,
          status: "new",
        })
        .returning({ id: leadsTable.id });
      leadId = created.id;
    }
    await tx
      .update(crmContactsTable)
      .set({ leadId, updatedAt: new Date() })
      .where(
        and(
          eq(crmContactsTable.id, contactId),
          eq(crmContactsTable.userId, userId),
        ),
      );
    return { leadId };
  });
}

/** This is the same account binding used by the worker; never silently swap a selected sender. */
export async function resolveCreationAccount(
  userId: number,
  channel: InboxChannel,
  selection: AccountSelection,
): Promise<{
  account: OutreachSendingAccount;
  binding: ProviderBinding | null;
}> {
  if (channel === "email") {
    const sender = selection.senderId
      ? await getById(userId, selection.senderId)
      : await getDefault(userId);
    const account: OutreachSendingAccount = {
      id: String(sender?.id || ""),
      senderId: sender?.id,
      label: sender?.email || "Choose an email sender",
      providerAccountId: "",
      ready: false,
      reason: sender
        ? sender.type === 'gmail'
          ? 'Reconnect this Gmail account in Email integrations to enable sending.'
          : 'Verify this sending domain in Email integrations before sending.'
        : 'Choose a verified email sender in Email integrations.',
      provider: sender?.type === "resend" ? "resend" : "gmail",
      isDefault: sender?.isDefault,
    };
    if (!sender?.isVerified || !["gmail", "resend"].includes(sender.type))
      return { account, binding: null };
    const providerVariant = sender.type as "gmail" | "resend";
    if (providerVariant === "gmail" && !sender.credentialId)
      return { account, binding: null };
    const binding = await resolveOfficialProviderBinding(userId, "email", {
      providerVariant,
      ...(providerVariant === "gmail"
        ? { credentialId: sender.credentialId! }
        : { providerAccountId: sender.email.split("@")[1]?.toLowerCase() }),
    });
    account.providerAccountId = binding?.providerAccountId || "";
    account.ready = Boolean(binding);
    account.reason = binding
      ? null
      : providerVariant === 'gmail'
        ? 'Open Email integrations and reconnect this Gmail account with sending permission.'
        : 'Open Email integrations and verify this sending domain.';
    account.assistant = await customerDeliveryReadiness({ userId, channel, accountId: sender.email });
    account.ready = account.ready && account.assistant.ready;
    if (!account.assistant.ready) account.reason = account.assistant.error || 'Configure the assigned assistant before sending.';
    return { account, binding };
  }
  const [binding, assistant] = await Promise.all([
    selection.providerAccountId
    ? resolveOfficialProviderBinding(userId, channel, {
        providerAccountId: selection.providerAccountId,
      })
    : Promise.resolve(null),
    // WhatsApp outreach opens with a Meta-approved template, which does not use
    // the assistant's AI model. A free-form message is still checked when sent.
    customerDeliveryReadiness({ userId, channel, accountId: selection.providerAccountId || '', approvedTemplate: channel === 'whatsapp' }),
  ]);
  return {
    binding,
    account: {
      id: selection.providerAccountId || "",
      providerAccountId: selection.providerAccountId || "",
      label:
        binding?.accountName ||
        selection.providerAccountId ||
        "Choose a sending account",
      assistant,
      ready: Boolean(binding) && assistant.ready,
      // Connection comes first: an assistant can't be assigned to an account that isn't connected.
      reason: !selection.providerAccountId
        ? `Connect your ${trackingChannelLabel(channel)} account to send.`
        : !binding
          ? "Choose a connected sending account with messaging access."
          : !assistant.ready ? assistant.error || 'Configure the assigned assistant before sending.' : null,
    },
  };
}

export async function getCreationOptions(
  userId: number,
  channel: InboxChannel,
): Promise<OutreachCreationOptions> {
  let deliveryBlock: OutreachCreationOptions['deliveryBlock'];
  try {
    assertCustomerDeliveryRuntime(channel);
  } catch (error) {
    const failure = deliverySetupFailure(error);
    if (!failure) throw error;
    deliveryBlock = { ready: false, ...failure, code: 'ASSISTANT_SETUP_REQUIRED', accountId: '', channel };
  }
  if (channel === "email") {
    const senders = await listByUser(userId);
    const resolved = await Promise.all(senders.map(sender =>
      resolveCreationAccount(userId, channel, { senderId: sender.id })));
    // Assistant setup can block delivery on a connected account. Connection
    // availability comes from the provider binding, independently of readiness.
    const accounts = resolved.filter(result => result.binding).map(result => result.account);
    return { channel, accounts, ...(deliveryBlock ? { deliveryBlock } : {}) };
  }
  const platform = channel === "whatsapp" ? "whatsapp" : channel === "sms" ? "msg91_sms" : `${channel}_api`;
  // Select only non-secret identity columns. Credential material stays inside the provider service.
  const rows: Array<{
    id: string | null;
    name: string | null;
    selected: boolean;
  }> = await db
    .select({
      id: channelCredentialsTable.accountIdentifier,
      name: channelCredentialsTable.accountName,
      selected: channelCredentialsTable.isSelected,
    })
    .from(channelCredentialsTable)
    .where(
      and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, platform),
        eq(channelCredentialsTable.isActive, true),
      ),
    );
  const unique = [
    ...new Map(
      rows.filter((row) => row.id).map((row) => [row.id!, row]),
    ).values(),
  ];
  const resolved = await Promise.all(unique.map(async row => {
    const result = await resolveCreationAccount(userId, channel, { providerAccountId: row.id! });
    return { ...result, account: { ...result.account, label: row.name || row.id!, isDefault: row.selected } };
  }));
  const accounts = resolved.filter(result => result.binding).map(result => result.account);
  return { channel, accounts, ...(deliveryBlock ? { deliveryBlock } : {}) };
}

export async function getCreationTemplates(
  userId: number,
  providerAccountId: string,
  options: { forSelection?: boolean } = {},
): Promise<OutreachTemplate[]> {
  const binding = await resolveOfficialProviderBinding(userId, "whatsapp", {
    providerAccountId,
  });
  if (!binding)
    throw new Error("Connect this WhatsApp number before choosing a template.");
  const { whatsappApiService } = await import("../whatsappApiService.js");
  if (!options.forSelection) return whatsappApiService.listApprovedTemplates(userId, providerAccountId);
  const [templates, reserved] = await Promise.all([
    whatsappApiService.listTemplatesForSelection(userId, providerAccountId),
    supportNotificationTemplateIds(userId),
  ]);
  return templates.filter((template) => !reserved.has(template.id));
}

/**
 * Templates bound to support-team notifications (for example a ticket
 * assignment alert) are for staff, not customers, so the outreach chooser
 * leaves them out. A failed lookup keeps the full list rather than hiding all.
 */
async function supportNotificationTemplateIds(userId: number): Promise<Set<string>> {
  try {
    const { withSupportNotificationTenant } = await import("../SupportMemberNotificationService.js");
    const result = await withSupportNotificationTenant(userId, (tx) => tx.execute(sql`
      SELECT DISTINCT wt.waba_template_id AS id
        FROM support_notification_provider_bindings b
        JOIN whatsapp_templates wt ON wt.id=b.whatsapp_template_id AND wt.user_id=b.user_id
       WHERE b.user_id=${userId} AND b.channel='whatsapp' AND b.enabled IS TRUE
         AND wt.waba_template_id IS NOT NULL`));
    return new Set(((result as { rows: Array<{ id: string }> }).rows).map((row) => String(row.id)));
  } catch {
    return new Set();
  }
}

export async function getCreationRecipients(
  userId: number,
  channel: InboxChannel,
  selection: AccountSelection,
  query: {
    ids?: number[];
    search?: string;
    after?: number;
    threadId?: number;
    importFilter?: ImportSourceFilter;
    limit?: number;
    /** Destinations already taken by an earlier chunk of the same review, so a number is sent to once across chunks. */
    sentTo?: Map<string, string>;
  } = {},
) {
  const { account } = await resolveCreationAccount(userId, channel, selection);
  const conditions = [
    eq(leadsTable.userId, userId),
    eq(leadsTable.businessProfileId, requireBusinessScope().businessProfileId),
    isNull(leadsTable.deletedAt),
  ];
  if (query.importFilter) conditions.push(creationImportPredicate(userId, query.importFilter));
  if (query.ids) conditions.push(inArray(leadsTable.id, query.ids));
  if (query.after) conditions.push(gt(leadsTable.id, query.after));
  if (query.threadId)
    conditions.push(
      // Migration 587's stored, indexed copy of campaignData.threadId.
      sql`${leadsTable}.legacy_campaign_thread_key = ${String(query.threadId)}`,
    );
  if (query.search?.trim()) {
    const pattern = `%${query.search.trim().replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(
      or(
        ilike(leadsTable.fullName, pattern),
        ilike(leadsTable.name, pattern),
        ilike(leadsTable.email, pattern),
        ilike(leadsTable.phone, pattern),
        ilike(leadsTable.company, pattern),
      )!,
    );
  }
  const limit = query.ids ? query.ids.length : Math.min(query.limit || 50, 100);
  if (limit === 0) return { recipients: [], nextCursor: null };
  const leads: Array<
    Pick<
      LeadRecord,
      | "id"
      | "name"
      | "fullName"
      | "firstName"
      | "lastName"
      | "company"
      | "companyName"
      | "email"
      | "phone"
      | "whatsapp"
      | "blacklisted"
      | "doNotContact"
      | "emailUnsubscribed"
    >
  > = await db
    .select({
      id: leadsTable.id,
      name: leadsTable.name,
      fullName: leadsTable.fullName,
      firstName: leadsTable.firstName,
      lastName: leadsTable.lastName,
      company: leadsTable.company,
      companyName: leadsTable.companyName,
      email: leadsTable.email,
      phone: leadsTable.phone,
      whatsapp: leadsTable.whatsapp,
      blacklisted: leadsTable.blacklisted,
      doNotContact: leadsTable.doNotContact,
      emailUnsubscribed: leadsTable.emailUnsubscribed,
    })
    .from(leadsTable)
    .where(and(...conditions))
    .orderBy(leadsTable.id)
    .limit(limit + (query.ids ? 0 : 1));
  const page = leads.slice(0, limit);
  const social = channel === "instagram" || channel === "facebook";
  const conversations: Array<{
    lead_id: number;
    id: number;
    external_thread_id: string;
    last_inbound_at: string | Date | null;
  }> =
    social && page.length && account.ready
      ? (
          await db.execute(sql`
    SELECT DISTINCT ON (c.lead_id) c.lead_id, c.id, c.external_thread_id,
      (SELECT MAX(COALESCE(m.sent_at,m.created_at)) FROM outreach_messages m WHERE m.conversation_id=c.id AND m.direction='inbound') AS last_inbound_at
    FROM outreach_conversations c WHERE c.user_id=${userId} AND c.channel=${channel}
      AND c.provider_account_id=${account.providerAccountId} AND c.lead_id IN (${sql.join(
        page.map((lead) => sql`${lead.id}`),
        sql`,`,
      )})
      AND c.external_thread_id ~ '^[0-9]+$'
      AND c.status NOT IN ('unsubscribed','opted_out','bounced')
      AND c.automation_mode NOT IN ('closed','opted_out')
    ORDER BY c.lead_id,c.last_message_at DESC NULLS LAST,c.id DESC
  `)
        ).rows
      : [];
  const byLead = new Map(
    conversations.map((row) => [Number(row.lead_id), row]),
  );
  const [suppressed, whatsappWindows] = await Promise.all([
    getSuppressedRecipients(userId,channel,page.map(lead => channel === "email" ? lead.email || "" : channel === "whatsapp" ? normalizeWhatsAppNumber(firstWhatsAppNumberSource(lead.whatsapp, lead.phone)) || "" : lead.phone || "")),
    channel === 'whatsapp' && account.ready
      ? activeWhatsAppWindows(userId, page.map(lead => lead.id), account.providerAccountId)
      : Promise.resolve(new Set<number>()),
  ]);
  const recipients: OutreachRecipient[] = [];
  const sentTo = query.sentTo ?? new Map<string, string>();
  for (const lead of page) {
    const contactName =
      lead.fullName ||
      lead.name ||
      [lead.firstName, lead.lastName].filter(Boolean).join(" ");
    const recipient: OutreachRecipient = {
      id: lead.id,
      name: contactName || lead.email || lead.phone || "Contact",
      fullName: contactName || "",
      firstName: lead.firstName || contactName?.split(" ")[0] || "",
      lastName: lead.lastName || "",
      company: lead.company || lead.companyName || "",
      email: lead.email || "",
      phone: channel === "sms" ? lead.phone || "" : firstWhatsAppNumberSource(lead.whatsapp, lead.phone),
      recipient: "",
      eligible: false,
      reason: null,
    };
    if (lead.blacklisted)
      recipient.reason = "This contact is blacklisted for outreach.";
    else if (lead.doNotContact)
      recipient.reason = "This contact has opted out (Do Not Contact).";
    else if (channel === "email" && lead.emailUnsubscribed)
      recipient.reason = "This contact has unsubscribed from email.";
    // A missing number is the contact's own problem, so say that even before an account is connected.
    else if (channel === "whatsapp" && !recipient.phone)
      recipient.reason = "This contact has no WhatsApp number. Add one in CRM.";
    else if (!account.ready) recipient.reason = account.reason;
    else if (channel === "email") {
      recipient.recipient = recipient.email;
      recipient.reason = isEmailAddress(recipient.email)
        ? null
        : "Add a valid email address to this contact.";
    } else if (channel === "whatsapp") {
      recipient.recipient = normalizeWhatsAppNumber(recipient.phone) || "";
      recipient.reason = recipient.recipient
        ? null
        : recipient.phone ? WHATSAPP_NUMBER_HELP : "This contact has no WhatsApp number. Add one in CRM.";
      recipient.requiresTemplate = !whatsappWindows.has(lead.id);
    } else if (channel === "sms") {
      recipient.recipient = normalizeMSG91Phone(recipient.phone) || '';
      recipient.reason = recipient.recipient ? null : 'Add a valid SMS phone number with its country code.';
    } else {
      const conversation = byLead.get(lead.id);
      recipient.recipient = String(conversation?.external_thread_id || "");
      recipient.conversationId = conversation
        ? Number(conversation.id)
        : undefined;
      recipient.reason = !conversation?.last_inbound_at
        ? "This contact needs to message the connected account first."
        : parseUtcDatabaseTimestamp(conversation.last_inbound_at).getTime() <
            Date.now() - 24 * 60 * 60_000
          ? "The 24-hour reply window has closed. Wait for a new message from this contact."
          : null;
    }
    if (suppressed.has(normalizeOutreachDestination(channel,recipient.recipient))) recipient.reason = "This destination is suppressed for outreach.";
    // Several CRM contacts can share one number or address. Send to it once, so one person never gets the same message twice.
    const destination = recipient.reason === null && ["whatsapp", "sms", "email"].includes(channel)
      ? normalizeOutreachDestination(channel, recipient.recipient) : "";
    if (destination) {
      const first = sentTo.get(destination);
      const what = channel === "email" ? "email address" : "number";
      if (first) recipient.reason = first === recipient.name
        ? `Duplicate contact: another ${first} has the same ${what}, so this is sent once.`
        : `${first} has the same ${what}, so this is sent once, to ${first}.`;
      else sentTo.set(destination, recipient.name);
    }
    recipient.eligible = recipient.reason === null;
    recipients.push(recipient);
  }
  return {
    recipients,
    nextCursor: leads.length > limit ? page.at(-1)!.id : null,
  };
}

export function validateOutreachTiming(
  scheduledAt: unknown,
  followUps: unknown,
) {
  let sendAt: Date | undefined;
  if (scheduledAt !== undefined && scheduledAt !== null) {
    if (
      typeof scheduledAt !== "string" ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(scheduledAt)
    )
      throw new Error("Choose a valid send date and time.");
    sendAt = new Date(scheduledAt);
    if (
      !Number.isFinite(sendAt.getTime()) ||
      sendAt.getTime() < Date.now() + 60_000 ||
      sendAt.getTime() > Date.now() + 90 * 24 * 60 * 60_000
    )
      throw new Error(
        "Schedule outreach between one minute and 90 days from now.",
      );
  }
  if (followUps !== undefined) {
    if (!Array.isArray(followUps) || followUps.length > 10)
      throw new Error("Choose up to ten follow-ups.");
    let previous = 0;
    for (const step of followUps) {
      if (
        !step ||
        !Number.isInteger(step.delayMinutes) ||
        step.delayMinutes <= previous ||
        step.delayMinutes > 90 * 24 * 60
      )
        throw new Error(
          "Follow-up times must increase and fall within 90 days of sending.",
        );
      if (
        typeof step.message !== "string" ||
        !step.message.trim() ||
        step.message.length > 50_000 ||
        /{{\s*[^}]+\s*}}/.test(step.message)
      )
        throw new Error(
          "Complete the message and personalization for every follow-up.",
        );
      if (
        step.subject !== undefined &&
        (typeof step.subject !== "string" ||
          step.subject.length > 500 ||
          /{{.*?}}/.test(step.subject))
      )
        throw new Error(
          "Complete the follow-up subject personalization and keep it under 500 characters.",
        );
      if (
        step.htmlContent !== undefined &&
        (typeof step.htmlContent !== "string" ||
          step.htmlContent.length > 250_000 ||
          /{{.*?}}/.test(step.htmlContent))
      )
        throw new Error(
          "Complete the follow-up HTML personalization and keep it under 250,000 characters.",
        );
      previous = step.delayMinutes;
    }
  }
  return sendAt;
}

/** Validate the component contract against the current, account-scoped Meta template. */
export function validateCreationTemplate(
  template: OutreachTemplate,
  components: unknown,
): string {
  if (!Array.isArray(components) || JSON.stringify(components).length > 20_000)
    throw new Error("Complete the WhatsApp template parameters.");
  const fields = outreachTemplateFields(template);
  for (const section of ["header", "body", "button"] as const) {
    const expected = fields.filter((field) => field.section === section);
    if (section === "button") {
      for (const field of expected) {
        const component = components.find(
          (item) =>
            item?.type === "button" &&
            String(item.index) === String(field.buttonIndex) &&
            item.sub_type === "url",
        );
        if (
          component?.parameters?.length !== 1 ||
          component.parameters[0]?.type !== "text" ||
          typeof component.parameters[0].text !== "string" ||
          !component.parameters[0].text.trim() ||
          /{{.*?}}/.test(component.parameters[0].text)
        )
          throw new Error("Complete the template button values.");
      }
    } else if (expected.length) {
      const parameters = components.find(
        (item) => item?.type === section,
      )?.parameters;
      if (
        !Array.isArray(parameters) ||
        parameters.length !== expected.length ||
        expected.some((field, index) => {
          const parameter = parameters[index];
          return (
            parameter?.type !== "text" ||
            typeof parameter.text !== "string" ||
            !parameter.text.trim() ||
            /{{.*?}}/.test(parameter.text) ||
            (!/^\d+$/.test(field.token) &&
              parameter.parameter_name !== field.token)
          );
        })
      )
        throw new Error("Complete every WhatsApp template variable.");
    }
  }
  const mediaType = template.headerType?.toLowerCase();
  if (mediaType && ["image", "video", "document"].includes(mediaType)) {
    const parameter = components.find((item) => item?.type === "header")
      ?.parameters?.[0];
    const link = parameter?.[mediaType]?.link;
    const mediaId = parameter?.[mediaType]?.id;
    if (
      parameter?.type !== mediaType ||
      !(typeof mediaId === "string" && /^\d{1,100}$/.test(mediaId)) && (
        typeof link !== "string" || !/^https:\/\/\S+$/i.test(link) || /{{.*?}}/.test(link))
    )
      throw new Error("Upload media for this template or add a valid HTTPS link.");
  }
  const render = (section: "header" | "body") => {
    const sectionFields = fields.filter((field) => field.section === section);
    const parameters =
      components.find((item) => item?.type === section)?.parameters || [];
    return (template[section] || "").replace(
      /{{\s*([^}]+?)\s*}}/g,
      (_, token: string) =>
        parameters[sectionFields.findIndex((field) => field.token === token)]
          ?.text || "",
    );
  };
  return [
    mediaType === "text" ? render("header") : "",
    render("body"),
    template.footer,
  ]
    .filter(Boolean)
    .join("\n\n");
}
