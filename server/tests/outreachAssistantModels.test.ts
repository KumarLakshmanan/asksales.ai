import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { emptyAssistantDraft } from "../../shared/outreachAssistants.js";
import {
  withAssistantContext,
  type ResolvedAssistant,
} from "../services/assistants/AssistantContext.js";
import { withBusinessScope } from "../tenancy/businessContext.js";

let credentials: any[] = [];
const calls: Array<{ provider: string; options: any }> = [];
const failures = new Set<string>();
let stale = false;
let managedModels: import('../services/assistants/AssistantModelCatalogService.js').ManagedAssistantModel[] = [];
const markInactive = jest.fn();
jest.unstable_mockModule("../models/adminApiCredentials/functions.js", () => ({
  getActiveLLMAdminCredentials: async () => credentials,
  getActiveAdminCredential: jest.fn(),
  getAllActiveAdminCredentials: jest.fn(),
  markAdminCredentialInactive: markInactive,
  updateAdminCredentialLastUsed: async () => {},
}));
jest.unstable_mockModule(
  "../services/assistants/AssistantFreshness.js",
  () => ({
    assertAssistantFresh: async () => {
      if (stale) throw new Error("Assignment superseded");
    },
  }),
);
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
function providerClass(name: string) {
  return class {
    defaultModel: string;
    constructor(_key: string, model: string) {
      this.defaultModel = model;
    }
    getProviderName() {
      return name;
    }
    async createChatCompletion(options: any) {
      calls.push({ provider: name, options });
      return failures.has(options.model)
        ? { success: false, error: "Synthetic credential rejected" }
        : { success: true, content: "Synthetic answer" };
    }
    async createChatCompletionStream(options: any) {
      calls.push({ provider: name, options });
      options.onComplete?.("Synthetic answer");
      return { success: true };
    }
  };
}
for (const [file, exportName, name] of [
  ["OpenAIService", "OpenAIService", "openai"],
  ["GeminiProvider", "GeminiProvider", "gemini"],
  ["VertexAIProvider", "VertexAIProvider", "vertex_ai"],
  ["OpenRouterProvider", "OpenRouterProvider", "openrouter"],
  ["CustomAIProvider", "CustomAIProvider", "custom_ai"],
])
  jest.unstable_mockModule(`../services/agents/${file}.js`, () => ({
    [exportName]: providerClass(name),
  }));
const { LLMProviderFactory } =
  await import("../services/agents/LLMProviderFactory.js");
const { db } = await import('../models/db.js');

function context(): ResolvedAssistant {
  const configuration = emptyAssistantDraft();
  configuration.name = "Support";
  configuration.agentType = "general_service";
  configuration.replyModel = { provider: "gemini", model: "gemini-2.5-flash" };
  configuration.fallbackModels = [{ provider: "openai", model: "gpt-4o-mini" }];
  configuration.response = { maxReplyTokens: 300, temperature: 0.2, topP: 0.9 };
  return {
    configuration,
    preview: true,
    provenance: {
      assistantId: "c1a11111-1111-4111-8111-111111111111",
      businessProfileId: 1,
      revision: 0,
      bindingId: 0,
      bindingVersion: 0,
      channel: "web",
      surface: "private",
      accountId: "simulator",
    },
  };
}
function run<T>(selected: ResolvedAssistant, work: () => T) {
  return withBusinessScope({ userId: 1, businessProfileId: 1 }, () =>
    withAssistantContext(selected, work),
  );
}
beforeEach(() => {
  managedModels = [];
  db.execute = async () => ({ rows: managedModels });
  calls.length = 0;
  failures.clear();
  stale = false;
  markInactive.mockClear();
  credentials = [
    {
      id: 1,
      platform: "openrouter",
      apiKey: "offline-fixture-key",
      config: { selectedModel: "openai/gpt-4o" },
    },
    {
      id: 2,
      platform: "gemini",
      apiKey: "offline-fixture-key",
      config: { selectedModel: "gemini-2.5-flash" },
    },
    {
      id: 3,
      platform: "openai",
      apiKey: "offline-fixture-key",
      config: { selectedModel: "gpt-4o-mini", allowedModels: ["gpt-5-mini"] },
    },
  ];
});
describe("assistant-approved reply providers across every call path", () => {
  it('uses an admin catalog model through its configured connection even without a legacy allow-list entry', async () => {
    managedModels = [{ id: 1, provider: 'gemini', model: 'fixture-new-gemini', label: 'Customer Gemini', description: '', enabled: true, order: 1, credentialId: 2, version: 1 }];
    const selected = context(); selected.configuration.replyModel = { provider: 'gemini', model: 'fixture-new-gemini' }; selected.configuration.fallbackModels = [];
    await run(selected, () => LLMProviderFactory.createChatCompletionWithFallback(1, { messages: [], model: 'unapproved' }));
    expect(calls.map(call => [call.provider, call.options.model])).toEqual([['gemini', 'fixture-new-gemini']]);
  });
  it('does not use a disabled catalog entry through the legacy provider configuration', async () => {
    managedModels = [{ id: 1, provider: 'gemini', model: 'gemini-2.5-flash', label: 'Customer Gemini', description: '', enabled: false, order: 1, credentialId: 2, version: 1 }];
    const selected = context(); selected.configuration.fallbackModels = [];
    await expect(run(selected, () => LLMProviderFactory.createProviderForUser(1))).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it("uses only the primary and approved fallback, regardless of global credential priority", async () => {
    const selected = context();
    failures.add("gemini-2.5-flash");
    const result = await run(selected, () =>
      LLMProviderFactory.createChatCompletionWithFallback(1, {
        model: "unapproved-model",
        messages: [],
        max_tokens: 9000,
        loggingContext: { purpose: "support_reply", service: "Test" },
      }),
    );
    expect(result.success).toBe(true);
    expect(calls.map((c) => [c.provider, c.options.model])).toEqual([
      ["gemini", "gemini-2.5-flash"],
      ["openai", "gpt-4o-mini"],
    ]);
    expect(calls.every((c) => c.options.max_tokens === 300)).toBe(true);
    expect(
      calls.every(
        (c) =>
          c.options.loggingContext.metadata.assistant.assistantId ===
          selected.provenance.assistantId,
      ),
    ).toBe(true);
  });
  it("does not broaden an empty fallback selection when the primary fails", async () => {
    const selected = context();
    selected.configuration.fallbackModels = [];
    failures.add("gemini-2.5-flash");
    const result = await run(selected, () =>
      LLMProviderFactory.createChatCompletionWithFallback(1, {
        model: "gpt-4o-mini",
        messages: [],
      }),
    );
    expect(result.success).toBe(false);
    expect(calls.map((c) => c.provider)).toEqual(["gemini"]);
  });
  it("binds direct provider calls and streaming calls to the selected model", async () => {
    const selected = context();
    await run(selected, async () => {
      const provider = await LLMProviderFactory.createProviderForUser(1);
      await provider.createChatCompletion({
        model: "unapproved-model",
        messages: [],
        temperature: 1.7,
      });
      await provider.createChatCompletionStream({
        model: "another-unapproved-model",
        messages: [],
        onChunk: () => {},
        onComplete: () => {},
        onError: () => {},
      });
    });
    expect(calls.map((c) => c.options.model)).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-flash",
    ]);
    expect(calls[0].options.temperature).toBe(0.2);
  });
  it("preserves internal extraction budgets and removes controls unsupported by a fallback", async () => {
    const selected = context();
    selected.configuration.fallbackModels = [
      { provider: "openai", model: "gpt-5-mini" },
    ];
    failures.add("gemini-2.5-flash");
    await run(selected, () =>
      LLMProviderFactory.createChatCompletionWithFallback(1, {
        model: "any",
        messages: [],
        max_tokens: 2400,
        temperature: 1,
        top_p: 0.5,
        loggingContext: {
          purpose: "playbook_field_extraction",
          service: "Test",
        },
      }),
    );
    expect(calls.map((c) => c.options.max_tokens)).toEqual([2400, 2400]);
    expect(calls[1].options.model).toBe("gpt-5-mini");
    expect(calls[1].options.temperature).toBeUndefined();
    expect(calls[1].options.top_p).toBeUndefined();
  });
  it("keeps the separately approved classifier model out of the reply allowlist", async () => {
    const selected = context();
    await run(selected, async () => {
      const classifier = LLMProviderFactory.createClassifierProvider(1, {
        id: 4,
        platform: "openai",
        apiKey: "offline",
        isActive: true,
        config: { model: "gpt-4.1-mini" },
      } as any);
      await classifier.createChatCompletion({
        model: "gpt-4.1-mini",
        messages: [],
        max_tokens: 1700,
      });
    });
    expect(calls[0].options.model).toBe("gpt-4.1-mini");
    expect(calls[0].options.max_tokens).toBe(1700);
  });
  it("stops stale direct calls and prevents reuse outside the resolved turn", async () => {
    let provider: any;
    await run(context(), async () => {
      provider = await LLMProviderFactory.createProviderForUser(1);
    });
    await expect(
      provider.createChatCompletion({ model: "gpt-4o-mini", messages: [] }),
    ).rejects.toThrow("another assistant turn");
    stale = true;
    await expect(
      run(context(), () =>
        LLMProviderFactory.executeWithFallback(1, (p) =>
          p.createChatCompletion({ model: "any", messages: [] }),
        ),
      ),
    ).rejects.toThrow("superseded");
    expect(calls).toHaveLength(0);
  });
  it("never silently uses another configured model after the selected integration disappears", async () => {
    credentials = credentials.filter((c) => c.platform === "openrouter");
    await expect(
      run(context(), () => LLMProviderFactory.createProviderForUser(1)),
    ).rejects.toThrow("No active LLM");
    expect(calls).toHaveLength(0);
  });
});
