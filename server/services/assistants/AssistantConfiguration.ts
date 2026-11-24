import { z } from "zod";
import {
  ASSISTANT_CHANNELS,
  assistantBindingKey,
  assistantFollowUpSaveIssues,
  assistantAiFollowUpAvailable,
  type AssistantCatalog,
  type AssistantDraft,
  type AssistantAvailability,
  type AssistantReadiness,
  type AssistantModel,
  type AssistantBindingInput,
} from "../../../shared/outreachAssistants.js";
import { validatePolicyRules } from "../agents/pipeline/PolicyRuleSchema.js";
import { canonicalizeTemplateVariable } from "../../utils/contentTemplateRendering.js";

const id = z.number().int().positive().safe();
const mode = z.enum(["unconfigured", "none", "selected"]);
const selection = z.object({ mode, ids: z.array(id).max(500) }).strict();
const model = z
  .object({
    provider: z.string().min(1).max(50),
    model: z.string().min(1).max(250),
  })
  .strict();
const channel = z.enum(ASSISTANT_CHANNELS);
const surface = z.enum(["private", "public_comment"]);
export const assistantDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    agentType: z.string().min(1).max(50),
    bindings: z
      .array(
        z
          .object({ channel, surface, accountId: z.string().min(1).max(255) })
          .strict(),
      )
      .max(100),
    instructions: z.string().max(30000),
    demonstrations: z
      .array(
        z
          .object({
            customer: z.string().max(4000),
            assistant: z.string().max(4000),
          })
          .strict(),
      )
      .max(30),
    replyModel: model.nullable(),
    fallbackModels: z.array(model).max(8),
    response: z
      .object({
        maxReplyTokens: z.number().int().min(64).max(8192),
        temperature: z.number().min(0).max(2).optional(),
        topP: z.number().min(0.01).max(1).optional(),
      })
      .strict(),
    knowledge: selection,
    documents: selection,
    galleries: selection,
    playbooks: z
      .object({
        mode,
        assignments: z
          .array(
            z
              .object({
                playbookId: id,
                channel,
                surface,
                intent: z.string().trim().min(1).max(80).nullable(),
                priority: z.number().int().min(0).max(10000),
              })
              .strict(),
          )
          .max(200),
      })
      .strict(),
    followUps: z
      .object({
        mode,
        sequences: z
          .array(
            z
              .object({
                channel: z.enum(["whatsapp", "instagram", "facebook", "email"]),
                steps: z
                  .array(
                    z
                      .object({
                        delayMinutes: z.number().int().min(1).max(43200),
                        templateId: z.number().int().nonnegative().safe(),
                        messageMode: z.enum(['template', 'ai']).optional(),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(3),
              })
              .strict(),
          )
          .max(4),
      })
      .strict(),
    tools: z
      .object({
        mode,
        names: z.array(z.string().min(1).max(120)).max(100),
        approvalRequired: z.array(z.string().min(1).max(120)).max(100),
      })
      .strict(),
    privacy: z
      .object({
        permittedCollectionFields: z.array(z.string().min(1).max(100)).max(100),
        minimumConfidence: z.number().min(0.5).max(1),
        uncertaintyMessage: z.string().trim().min(10).max(500),
        handoff: z.enum(["offer", "customer_request"]),
      })
      .strict(),
    policies: z.record(z.string(), z.unknown()),
    availability: z
      .object({
        enabled: z.boolean(),
        timezone: z.string().min(1).max(100),
        weekly: z
          .array(
            z
              .object({
                day: z.number().int().min(1).max(7),
                ranges: z
                  .array(
                    z
                      .object({
                        start: z.string().regex(/^\d{2}:\d{2}$/),
                        end: z.string().regex(/^\d{2}:\d{2}$/),
                      })
                      .strict(),
                  )
                  .max(8),
              })
              .strict(),
          )
          .max(7),
        awayMessage: z.string().trim().min(1).max(1000).nullable(),
      })
      .strict(),
  })
  .strict();

export const modelKey = (value: AssistantModel) =>
  `${value.provider}:${value.model}`;
export function parseAssistantDraft(input: unknown): AssistantDraft {
  const parsed = assistantDraftSchema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.')))];
    throw new Error(`Check the assistant configuration fields: ${fields.join(', ')}. Use the required values and supported limits before saving.`);
  }
  const draft = parsed.data as AssistantDraft;
  const errors = availabilityErrors(draft.availability);
  errors.push(...assistantFollowUpSaveIssues(draft.followUps));
  const bindings = draft.bindings.map(assistantBindingKey);
  if (new Set(bindings).size !== bindings.length)
    errors.push("An account/surface may be selected only once.");
  if (
    draft.bindings.some(
      (b) =>
        b.surface === "public_comment" &&
        !["instagram", "facebook"].includes(b.channel),
    )
  ) {
    errors.push(
      "Public comments are supported only for Instagram and Facebook.",
    );
  }
  const models = [draft.replyModel, ...draft.fallbackModels]
    .filter((m): m is AssistantModel => Boolean(m))
    .map(modelKey);
  if (new Set(models).size !== models.length)
    errors.push("Primary and fallback models must be distinct.");
  if (
    new Set(draft.followUps.sequences.map((s) => s.channel)).size !==
    draft.followUps.sequences.length
  ) {
    errors.push(
      "Only one support follow-up sequence per channel is permitted.",
    );
  }
  for (const key of ["knowledge", "documents", "galleries"] as const) {
    const choice = draft[key];
    if (choice.mode !== "selected" && choice.ids.length)
      errors.push(`${key}: None/unconfigured cannot contain selections.`);
    if (new Set(choice.ids).size !== choice.ids.length)
      errors.push(`${key}: duplicate selections.`);
    if (choice.mode === "selected" && !choice.ids.length)
      errors.push(`${key}: select a resource or choose None.`);
  }
  for (const [key, choice, items] of [
    ["playbooks", draft.playbooks, draft.playbooks.assignments],
    ["followUps", draft.followUps, draft.followUps.sequences],
    ["tools", draft.tools, draft.tools.names],
  ] as const) {
    if (choice.mode !== "selected" && items.length)
      errors.push(`${key}: None/unconfigured cannot contain selections.`);
    if (choice.mode === "selected" && !items.length)
      errors.push(`${key}: select a resource or choose None.`);
  }
  errors.push(...validatePolicyRules(draft.policies));
  if (errors.length) throw new Error(errors.join(" "));
  return draft;
}

function timeMinutes(value: string, allowDayEnd = false): number {
  if (allowDayEnd && value === "24:00") return 1440;
  const [hour, minute] = value.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute < 60
    ? hour * 60 + minute
    : NaN;
}
export function availabilityErrors(value: AssistantAvailability): string[] {
  const errors: string[] = [];
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.timezone }).format();
  } catch {
    errors.push("Select a valid IANA timezone.");
  }
  if (new Set(value.weekly.map((d) => d.day)).size !== value.weekly.length)
    errors.push("Weekly days must be unique.");
  for (const day of value.weekly) {
    let previous = -1;
    for (const range of [...day.ranges].sort((a, b) =>
      a.start.localeCompare(b.start),
    )) {
      const start = timeMinutes(range.start),
        end = timeMinutes(range.end, true);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        start < previous
      ) {
        errors.push(
          "Weekly hours must be valid, non-overlapping ranges within the same day.",
        );
        break;
      }
      previous = end;
    }
  }
  if (value.enabled && !value.weekly.some((d) => d.ranges.length))
    errors.push("Enabled availability requires at least one open range.");
  return errors;
}
const weekdays: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};
const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();
export function withinAssistantHours(
  value: AssistantAvailability,
  now = new Date(),
): boolean {
  if (!value.enabled) return true;
  let formatter = timezoneFormatters.get(value.timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: value.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    if (timezoneFormatters.size > 100) timezoneFormatters.clear();
    timezoneFormatters.set(value.timezone, formatter);
  }
  const parts = formatter.formatToParts(now);
  const part = (type: string) =>
    parts.find((p) => p.type === type)?.value || "";
  const day = weekdays[part("weekday")];
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  return (
    value.weekly
      .find((d) => d.day === day)
      ?.ranges.some(
        (r) =>
          minute >= timeMinutes(r.start) && minute < timeMinutes(r.end, true),
      ) || false
  );
}
/** Iterate UTC minutes, preserving timezone/DST transitions rather than adding local-day milliseconds. */
export function nextAssistantOpen(
  value: AssistantAvailability,
  now = new Date(),
): Date | null {
  if (withinAssistantHours(value, now)) return now;
  if (availabilityErrors(value).length) return null;
  for (let offset = 1; offset <= 8 * 24 * 60; offset++) {
    const candidate = new Date(
      Math.floor(now.getTime() / 60000) * 60000 + offset * 60000,
    );
    if (withinAssistantHours(value, candidate)) return candidate;
  }
  return null;
}

export function assistantReadiness(
  draft: AssistantDraft,
  catalog: AssistantCatalog,
  platform: { classifier: boolean; privacyVault: boolean },
  enabledBindings: AssistantBindingInput[] = draft.bindings,
): AssistantReadiness {
  const checks: AssistantReadiness["checks"] = [];
  const check = (key: string, label: string, ok: boolean, detail: string) =>
    checks.push({ key, label, ok, detail });
  check(
    "identity",
    "Identity and preset",
    Boolean(draft.name.trim()) &&
      catalog.presets.some((p) => p.agentType === draft.agentType),
    "A name and supported specialist preset are required.",
  );
  check(
    "accounts",
    "Connected accounts",
    enabledBindings.length > 0 &&
      enabledBindings.every((b) =>
        catalog.accounts.some(
          (a) =>
            a.connected && assistantBindingKey(a) === assistantBindingKey(b),
        ),
      ),
    "Each enabled account identity must still be connected in this business.",
  );
  check(
    "model",
    "Reply and fallback models",
    Boolean(draft.replyModel) &&
      [draft.replyModel, ...draft.fallbackModels].every(
        (m) => m && catalog.models.some((c) => modelKey(c) === modelKey(m)),
      ),
    catalog.modelAvailabilityNotice || "Only currently configured server models may be used, including fallbacks.",
  );
  const reply =
    draft.replyModel &&
    catalog.models.find((m) => modelKey(m) === modelKey(draft.replyModel!));
  check(
    "response",
    "Supported response controls",
    (!("temperature" in draft.response) ||
      Boolean(reply?.controls.includes("temperature"))) &&
      (!("topP" in draft.response) ||
        Boolean(reply?.controls.includes("topP"))),
    "Unsupported model controls must be removed. The reply limit is not the internal processing budget.",
  );
  check(
    "classifier",
    "Intent classifier",
    platform.classifier,
    "A validated active classifier integration is required.",
  );
  check(
    "privacy",
    "Mandatory privacy vault",
    platform.privacyVault,
    "Redaction and encrypted PII storage are mandatory.",
  );
  for (const key of ["knowledge", "documents", "galleries"] as const) {
    const choice = draft[key];
    check(
      key,
      `${key[0].toUpperCase()}${key.slice(1)} selections`,
      choice.mode !== "unconfigured" &&
        (choice.mode === "none" ||
          choice.ids.every((id) => catalog[key].some((r) => r.id === id))),
      "Choose published, permitted resources or explicitly choose None. Withdrawn resources block publishing.",
    );
  }
  check(
    "playbooks",
    "Playbook assignments",
    draft.playbooks.mode !== "unconfigured" &&
      draft.playbooks.assignments.every((a) => {
        const resource = catalog.playbooks.find(
          (p) => p.id === a.playbookId && p.agentType === draft.agentType,
        );
        return (
          resource &&
          (!resource.channels.length ||
            resource.channels.includes(a.channel)) &&
          draft.bindings.some(
            (b) => b.channel === a.channel && b.surface === a.surface,
          )
        );
      }),
    "Assign compatible published playbooks to connected channels/intents, or choose None.",
  );
  const permitted = new Set(
    draft.playbooks.assignments.flatMap(
      (a) =>
        catalog.playbooks.find((p) => p.id === a.playbookId)
          ?.collectionFields || [],
    ),
  );
  check(
    "collection",
    "Permitted PII collection",
    draft.privacy.permittedCollectionFields.every((f) => permitted.has(f)),
    "Collection fields must come from selected published playbooks. This never grants access to raw customer data.",
  );
  check(
    "followUps",
    "Approved support follow-ups",
    draft.followUps.mode !== "unconfigured" &&
      draft.followUps.sequences.every(
        (s) =>
          draft.bindings.some(
            (b) => b.channel === s.channel && b.surface === "private",
          ) &&
          s.steps.every((step) => step.messageMode === 'ai'
            ? assistantAiFollowUpAvailable(s.channel, step.delayMinutes) && step.templateId === 0
            : catalog.templates.some(
              (t) =>
                t.id === step.templateId &&
                t.channels.includes(s.channel) &&
                (t.variables || []).every((v) =>
                  assistantTemplateVariableAllowed(
                    v,
                    draft.privacy.permittedCollectionFields,
                  ),
                ),
            ),
          ),
      ),
    "Select an approved, compatible template or an available AI reply for every step, or choose None. Web chat has no proactive follow-up transport.",
  );
  check(
    "tools",
    "Tools and approvals",
    draft.tools.mode !== "unconfigured" &&
      draft.tools.names.every((n) => catalog.tools.some((t) => t.name === n)) &&
      draft.tools.approvalRequired.every((n) =>
        draft.tools.names.includes(n),
      ) &&
      catalog.tools
        .filter((t) => t.approvalRequired && draft.tools.names.includes(t.name))
        .every((t) => draft.tools.approvalRequired.includes(t.name)),
    "High-risk tools retain mandatory approval requirements.",
  );
  check(
    "availability",
    "Availability",
    availabilityErrors(draft.availability).length === 0,
    "24/7 by default; weekly hours must use a valid timezone.",
  );
  return { ready: checks.every((c) => c.ok), checks };
}

/** Template personalization is separate from model access. No unknown variables or undeclared personal fields. */
export function assistantTemplateVariableAllowed(
  variable: string,
  fields: string[],
): boolean {
  const canonical = canonicalizeTemplateVariable(variable);
  if (!canonical) return false;
  if (
    [
      "your_company_name",
      "your_industry",
      "value_proposition",
      "your_website",
      "target_audience",
      "current_date",
      "current_year",
      "current_month",
    ].includes(canonical)
  )
    return true;
  const normalized = fields.map((f) =>
    f.replace(/[^a-z0-9]/gi, "").toLowerCase(),
  );
  const permitted: Record<string, string[]> = {
    first_name: [
      "name",
      "contactname",
      "guestname",
      "customername",
      "fullname",
      "firstname",
    ],
    last_name: [
      "name",
      "contactname",
      "guestname",
      "customername",
      "fullname",
      "lastname",
    ],
    full_name: ["name", "contactname", "guestname", "customername", "fullname"],
    email: [
      "email",
      "emailaddress",
      "contactemail",
      "customeremail",
      "guestemail",
    ],
    phone: [
      "phone",
      "phonenumber",
      "mobile",
      "contactphone",
      "customerphone",
      "guestphone",
    ],
    company_name: ["company", "companyname"],
  };
  return (permitted[canonical] || []).some((f) => normalized.includes(f));
}
