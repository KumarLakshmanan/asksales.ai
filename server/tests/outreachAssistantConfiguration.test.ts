import { describe, expect, it } from "@jest/globals";
import {
  emptyAssistantDraft,
  type AssistantCatalog,
} from "../../shared/outreachAssistants.js";
import {
  assistantReadiness,
  assistantTemplateVariableAllowed,
  availabilityErrors,
  nextAssistantOpen,
  parseAssistantDraft,
  withinAssistantHours,
} from "../services/assistants/AssistantConfiguration.js";
import { assistantPreviewSession } from "../services/assistants/AssistantPreviewSession.js";
import {
  assistantRolloutProfiles,
  assistantsRuntimeEnabled,
  assistantResourceIds,
  withAssistantContext,
  type ResolvedAssistant,
} from "../services/assistants/AssistantContext.js";
import { withBusinessScope } from "../tenancy/businessContext.js";

function fixture() {
  const draft = emptyAssistantDraft();
  draft.name = "Support";
  draft.agentType = "general_service";
  draft.bindings = [
    { channel: "whatsapp", surface: "private", accountId: "phone-a" },
  ];
  draft.replyModel = { provider: "openai", model: "gpt-4o-mini" };
  for (const key of ["knowledge", "documents", "galleries"] as const)
    draft[key].mode = "none";
  draft.playbooks.mode = "none";
  draft.followUps.mode = "none";
  draft.tools.mode = "none";
  const catalog: AssistantCatalog = {
    runtimeEnabled: true,
    accounts: [{ ...draft.bindings[0], label: "Test", connected: true }],
    presets: [
      {
        agentType: draft.agentType,
        name: "Support",
        description: "",
        instructions: "",
        tools: [],
        policies: {},
      },
    ],
    models: [
      {
        ...draft.replyModel,
        label: "Configured model",
        controls: ["temperature", "topP"],
      },
    ],
    knowledge: [],
    playbooks: [],
    templates: [],
    documents: [],
    galleries: [],
    tools: [],
    permissions: { canManage: true, description: "Existing permissions" },
  };
  return { draft, catalog };
}
describe("explicit assistant configuration and privacy", () => {
  it('supports AI WhatsApp check-ins below 24 hours without a template and retains all readiness gates', () => {
    const { draft, catalog } = fixture();
    draft.followUps = { mode: 'selected', sequences: [{ channel: 'whatsapp', steps: [{ delayMinutes: 1439, templateId: 0, messageMode: 'ai' }] }] };
    expect(parseAssistantDraft(draft)).toEqual(draft);
    expect(assistantReadiness(draft, catalog, { classifier: true, privacyVault: true }).ready).toBe(true);
    expect(assistantReadiness(draft, catalog, { classifier: true, privacyVault: false }).ready).toBe(false);
    draft.followUps.sequences[0].steps[0].delayMinutes = 1440;
    expect(() => parseAssistantDraft(draft)).toThrow('under 24 hours');
    expect(assistantReadiness(draft, catalog, { classifier: true, privacyVault: true }).checks.find(check => check.key === 'followUps')?.ok).toBe(false);
  });
  it('supports email AI follow-ups beyond the WhatsApp window while retaining account and privacy readiness checks', () => {
    const { draft, catalog } = fixture();
    draft.bindings.push({ channel: 'email', surface: 'private', accountId: 'support@example.com' });
    catalog.accounts.push({ ...draft.bindings[1], label: 'Support email', connected: true });
    draft.followUps = { mode: 'selected', sequences: [{ channel: 'email', steps: [{ delayMinutes: 2880, templateId: 0, messageMode: 'ai' }] }] };
    expect(parseAssistantDraft(draft)).toEqual(draft);
    expect(assistantReadiness(draft, catalog, { classifier: true, privacyVault: true }).ready).toBe(true);
    expect(assistantReadiness(draft, catalog, { classifier: true, privacyVault: false }).ready).toBe(false);
    draft.bindings = draft.bindings.filter(binding => binding.channel !== 'email');
    expect(assistantReadiness(draft, catalog, { classifier: true, privacyVault: true }).checks.find(check => check.key === 'followUps')?.ok).toBe(false);
  });
  it('rejects AI check-ins on unsupported channels, stale template IDs, and missing template selections with readable guidance', () => {
    const { draft } = fixture();
    draft.followUps = { mode: 'selected', sequences: [{ channel: 'instagram', steps: [{ delayMinutes: 60, templateId: 0, messageMode: 'ai' }] }] };
    expect(() => parseAssistantDraft(draft)).toThrow('AI replies require email, or WhatsApp');
    draft.followUps.sequences[0].channel = 'whatsapp';
    draft.followUps.sequences[0].steps[0].templateId = 9;
    expect(() => parseAssistantDraft(draft)).toThrow('no template selection');
    draft.followUps.sequences[0].steps[0] = { delayMinutes: 60, templateId: 0 };
    expect(() => parseAssistantDraft(draft)).toThrow('whatsapp message 1: choose an approved template before saving.');
    draft.followUps.sequences[0].steps[0] = { delayMinutes: 60, templateId: 9 };
    expect(parseAssistantDraft(draft)).toEqual(draft);
  });
  it("fails closed for malformed rollout allowlists and keeps profile activation isolated", () => {
    const oldFlag = process.env.SUPPORT_ASSISTANTS_ENABLED,
      oldProfiles = process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
    try {
      process.env.SUPPORT_ASSISTANTS_ENABLED = "true";
      process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES = "2,3";
      expect(assistantRolloutProfiles()).toEqual([2, 3]);
      expect(
        withBusinessScope(
          { userId: 1, businessProfileId: 2 },
          assistantsRuntimeEnabled,
        ),
      ).toBe(true);
      expect(
        withBusinessScope(
          { userId: 1, businessProfileId: 4 },
          assistantsRuntimeEnabled,
        ),
      ).toBe(false);
      for (const invalid of ["typo", "2,", "0", "2.5", "2,wrong"]) {
        process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES = invalid;
        expect(
          withBusinessScope(
            { userId: 1, businessProfileId: 2 },
            assistantsRuntimeEnabled,
          ),
        ).toBe(false);
      }
    } finally {
      if (oldFlag === undefined) delete process.env.SUPPORT_ASSISTANTS_ENABLED;
      else process.env.SUPPORT_ASSISTANTS_ENABLED = oldFlag;
      if (oldProfiles === undefined)
        delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
      else process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES = oldProfiles;
    }
  });
  it("allows a deliberately empty assistant but not silently inherited resources", () => {
    const { draft, catalog } = fixture();
    expect(parseAssistantDraft(draft)).toEqual(draft);
    expect(
      assistantReadiness(draft, catalog, {
        classifier: true,
        privacyVault: true,
      }).ready,
    ).toBe(true);
    draft.knowledge.mode = "unconfigured";
    expect(
      assistantReadiness(draft, catalog, {
        classifier: true,
        privacyVault: true,
      }).ready,
    ).toBe(false);
    draft.knowledge.mode = "selected";
    expect(() => parseAssistantDraft(draft)).toThrow("select a resource");
  });
  it("cannot disable baseline privacy, use unsupported channels or duplicate account/surfaces", () => {
    const { draft } = fixture();
    expect(() =>
      parseAssistantDraft({
        ...draft,
        privacy: { ...draft.privacy, redaction: false },
      }),
    ).toThrow();
    for (const channel of ["line", "linkedin", "twitter"])
      expect(() =>
        parseAssistantDraft({
          ...draft,
          bindings: [{ ...draft.bindings[0], channel }],
        }),
      ).toThrow();
    expect(() =>
      parseAssistantDraft({
        ...draft,
        bindings: [...draft.bindings, ...draft.bindings],
      }),
    ).toThrow("only once");
    expect(() =>
      parseAssistantDraft({
        ...draft,
        bindings: [{ ...draft.bindings[0], surface: "public_comment" }],
      }),
    ).toThrow("Instagram and Facebook");
  });
  it("rejects unavailable fallbacks and unsupported response controls", () => {
    const { draft, catalog } = fixture();
    draft.fallbackModels = [{ provider: "gemini", model: "not-configured" }];
    expect(
      assistantReadiness(draft, catalog, {
        classifier: true,
        privacyVault: true,
      }).checks.find((c) => c.key === "model")?.ok,
    ).toBe(false);
    draft.fallbackModels = [draft.replyModel!];
    expect(() => parseAssistantDraft(draft)).toThrow("distinct");
    draft.fallbackModels = [];
    catalog.models[0].controls = [];
    draft.response.temperature = 0.7;
    expect(
      assistantReadiness(draft, catalog, {
        classifier: true,
        privacyVault: true,
      }).checks.find((c) => c.key === "response")?.ok,
    ).toBe(false);
  });
  it("requires classifier, encrypted vault and baseline high-risk approvals before publish", () => {
    const { draft, catalog } = fixture();
    expect(
      assistantReadiness(draft, catalog, {
        classifier: false,
        privacyVault: false,
      }).ready,
    ).toBe(false);
    catalog.tools = [
      { name: "create_proposal", label: "Proposal", approvalRequired: true },
    ];
    draft.tools = {
      mode: "selected",
      names: ["create_proposal"],
      approvalRequired: [],
    };
    expect(
      assistantReadiness(draft, catalog, {
        classifier: true,
        privacyVault: true,
      }).checks.find((c) => c.key === "tools")?.ok,
    ).toBe(false);
  });
  it("intersects PII collection with assigned playbooks and checks actual template variables", () => {
    const { draft, catalog } = fixture();
    catalog.playbooks = [
      {
        id: 1,
        name: "Published",
        channels: ["whatsapp"],
        agentType: draft.agentType,
        collectionFields: ["contact.name"],
      },
    ];
    draft.playbooks = {
      mode: "selected",
      assignments: [
        {
          playbookId: 1,
          channel: "whatsapp",
          surface: "private",
          intent: "booking",
          priority: 1,
        },
      ],
    };
    draft.privacy.permittedCollectionFields = ["contact.name", "payment_card"];
    expect(
      assistantReadiness(draft, catalog, {
        classifier: true,
        privacyVault: true,
      }).checks.find((c) => c.key === "collection")?.ok,
    ).toBe(false);
    draft.privacy.permittedCollectionFields = ["contact.name"];
    catalog.templates = [
      {
        id: 2,
        name: "Approved",
        channels: ["whatsapp"],
        variables: ["firstName", "email"],
      },
    ];
    draft.followUps = {
      mode: "selected",
      sequences: [
        { channel: "whatsapp", steps: [{ delayMinutes: 30, templateId: 2 }] },
      ],
    };
    expect(
      assistantReadiness(draft, catalog, {
        classifier: true,
        privacyVault: true,
      }).checks.find((c) => c.key === "followUps")?.ok,
    ).toBe(false);
    expect(
      assistantTemplateVariableAllowed("firstName", ["contact.name"]),
    ).toBe(true);
    expect(assistantTemplateVariableAllowed("email", ["contact.name"])).toBe(
      false,
    );
    expect(
      assistantTemplateVariableAllowed("arbitrarySecret", ["arbitrarySecret"]),
    ).toBe(false);
  });
  it("None is an empty allowlist, not the entire business knowledge or media library", () => {
    const { draft } = fixture();
    const context: ResolvedAssistant = {
      configuration: draft,
      preview: true,
      provenance: {
        assistantId: "e1a11111-1111-4111-8111-111111111111",
        revision: 0,
        bindingId: 0,
        bindingVersion: 0,
        businessProfileId: 1,
        channel: "web",
        surface: "private",
        accountId: "simulator",
      },
    };
    expect(assistantResourceIds("knowledge")).toBeUndefined();
    withAssistantContext(context, () => {
      expect(assistantResourceIds("knowledge")).toEqual([]);
      expect(assistantResourceIds("documents")).toEqual([]);
      draft.galleries = { mode: "selected", ids: [4] };
      expect(assistantResourceIds("galleries")).toEqual([4]);
    });
  });
});
describe("assistant availability", () => {
  it("defaults to 24/7 and supports an explicit full day ending at 24:00", () => {
    const { draft } = fixture();
    expect(withinAssistantHours(draft.availability)).toBe(true);
    const availability = {
      enabled: true,
      timezone: "Asia/Kolkata",
      weekly: [{ day: 2, ranges: [{ start: "00:00", end: "24:00" }] }],
      awayMessage: null,
    };
    expect(availabilityErrors(availability)).toEqual([]);
    expect(
      withinAssistantHours(availability, new Date("2026-09-29T18:29:59Z")),
    ).toBe(true);
    expect(
      withinAssistantHours(availability, new Date("2026-09-29T18:30:00Z")),
    ).toBe(false);
  });
  it("rejects invalid timezone, overlaps, duplicate days and unsplit overnight ranges", () => {
    const availability = {
      enabled: true,
      timezone: "Not/AZone",
      weekly: [
        { day: 1, ranges: [{ start: "22:00", end: "02:00" }] },
        { day: 1, ranges: [] },
      ],
      awayMessage: null,
    };
    expect(availabilityErrors(availability)).toHaveLength(3);
    availability.timezone = "UTC";
    availability.weekly = [
      {
        day: 1,
        ranges: [
          { start: "09:00", end: "12:00" },
          { start: "11:00", end: "15:00" },
        ],
      },
    ];
    expect(availabilityErrors(availability)).toHaveLength(1);
  });
  it("defers to an actual UTC opening across daylight-saving changes and skips breaks", () => {
    const availability = {
      enabled: true,
      timezone: "America/New_York",
      weekly: [
        {
          day: 7,
          ranges: [
            { start: "09:00", end: "12:00" },
            { start: "14:00", end: "18:00" },
          ],
        },
      ],
      awayMessage: null,
    };
    expect(
      nextAssistantOpen(
        availability,
        new Date("2026-11-01T04:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-11-01T14:00:00.000Z");
    expect(
      nextAssistantOpen(
        availability,
        new Date("2026-11-01T17:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-11-01T19:00:00.000Z");
  });
});
describe("isolated simulator continuation", () => {
  const identity = {
    userId: 1,
    businessProfileId: 2,
    assistantId: "assistant-a",
    configurationVersion: "draft:4",
    channel: "whatsapp",
  };
  it("preserves the same preview only for the exact identity and revision", () => {
    const session = assistantPreviewSession(identity, {}, 100000);
    expect(assistantPreviewSession(identity, session, 100001)).toEqual(session);
    for (const changed of [
      { userId: 3 },
      { businessProfileId: 3 },
      { assistantId: "other" },
      { configurationVersion: "draft:5" },
      { channel: "email" },
    ]) {
      expect(() =>
        assistantPreviewSession({ ...identity, ...changed }, session, 100001),
      ).toThrow("different assistant");
    }
  });
  it("rejects customer IDs, expired continuations and tampered signatures", () => {
    const session = assistantPreviewSession(identity, {}, 100000);
    expect(() =>
      assistantPreviewSession(
        identity,
        { ...session, conversationId: 7 },
        100001,
      ),
    ).toThrow();
    expect(() =>
      assistantPreviewSession(
        identity,
        session,
        100000 + 2 * 60 * 60 * 1000 + 1,
      ),
    ).toThrow("expired");
    expect(() =>
      assistantPreviewSession(
        identity,
        { ...session, previewSessionToken: session.previewSessionToken + "a" },
        100001,
      ),
    ).toThrow();
  });
});
