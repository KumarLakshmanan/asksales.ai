import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Request, Response } from "express";
import { PgDialect } from "drizzle-orm/pg-core";

let rows: unknown[][] = [];
const mutations: { values?: unknown; condition?: unknown }[] = [];
function query(mutation = false) {
  const result = rows.shift() || [];
  const recorded: { values?: unknown; condition?: unknown } = {};
  if (mutation) mutations.push(recorded);
  const builder: Record<string, unknown> = {};
  for (const method of [
    "from",
    "leftJoin",
    "innerJoin",
    "groupBy",
    "orderBy",
    "limit",
    "returning",
  ])
    builder[method] = () => builder;
  builder.set = (values: unknown) => {
    recorded.values = values;
    return builder;
  };
  builder.where = (condition: unknown) => {
    recorded.condition = condition;
    return builder;
  };
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);
  return builder;
}
jest.unstable_mockModule("../models/db.js", () => ({
  db: { select: () => query(), update: () => query(true) },
}));
jest.unstable_mockModule("../tenancy/businessContext.js", () => ({
  businessOwnerUserId: () => 7,
}));
jest.unstable_mockModule(
  "../services/agents/orchestration/WidgetCommitRecovery.js",
  () => ({ widgetCommitEnvelope: jest.fn(), finishWidgetCommit: jest.fn() }),
);
jest.unstable_mockModule(
  "../services/ConversationRequestCoordinator.js",
  () => ({ validConversationRequestId: jest.fn() }),
);
jest.unstable_mockModule("../services/agents/AgentRouter.js", () => ({
  agentRouter: {},
}));
jest.unstable_mockModule(
  "../services/agents/orchestration/PrivacyVaultService.js",
  () => ({
    privacyVaultService: {},
    redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
  }),
);
jest.unstable_mockModule("../models/companySettings/functions.js", () => ({
  getBusinessProfileContextByUserId: async () => ({
    companyName: "Example business",
  }),
}));
jest.unstable_mockModule(
  "../services/supportDocuments/SupportWidgetDocuments.js",
  () => ({
    downloadWidgetDocument: jest.fn(),
    loadApprovedWidgetDocument: jest.fn(),
    publicWidgetMessage: (value: unknown) => value,
  }),
);
jest.unstable_mockModule(
  "../services/agents/orchestration/SupportConversationTurn.js",
  () => ({
    supportConversationTurnsEnabled: jest.fn(),
    currentSupportTurn: jest.fn(),
    assertSupportTurnFresh: jest.fn(),
    sealSupportTurn: jest.fn(),
    SupersededSupportTurn: class extends Error {},
    supportTurnDeliveryMetadata: jest.fn(),
    supportOwnershipSnapshot: jest.fn(),
  }),
);
jest.unstable_mockModule(
  "../services/assistants/AssistantFreshness.js",
  () => ({
    assistantProvenanceCurrent: jest.fn(),
    withPublishedAssistant: jest.fn(),
  }),
);
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}));
const controller = await import("../controllers/supportWidgetController.js");
const settings = {
  displayName: "Example help",
  greeting: "Hello there",
  primaryColor: "#123456",
  logoUrl: "https://example.com/logo.png",
  launcherPosition: "left",
};
const token = "a".repeat(64);
function req(
  body: unknown = {},
  params: unknown = {},
  origin = "https://widget.example",
) {
  return {
    body,
    params,
    query: { token },
    get: (name: string) => (name === "origin" ? origin : undefined),
  } as unknown as Request;
}
function res() {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
    send: jest.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  response.send.mockReturnValue(response);
  return response as unknown as Response;
}
const team = { id: 11, userId: 7, name: "Help", widgetSettings: settings };
const member = { id: 12 };
describe("support widget appearance and credentials", () => {
  beforeEach(() => {
    rows = [];
    mutations.length = 0;
  });
  it("persists settings only within active owned team scope", async () => {
    rows = [[{ id: 11 }]];
    const response = res();
    await controller.updateWidgetSettings(
      req(settings, { teamId: "11" }),
      response,
    );
    expect(mutations[0].values).toEqual(
      expect.objectContaining({ widgetSettings: settings }),
    );
    const condition = new PgDialect().sqlToQuery(
      mutations[0].condition as never,
    );
    expect(condition.sql).toContain('"support_teams"."user_id"');
    expect(condition.params).toEqual([11, 7, true]);
    expect(response.status).not.toHaveBeenCalled();
  });
  it("rejects invalid appearance without touching the database", async () => {
    const response = res();
    await controller.updateWidgetSettings(
      req({ ...settings, logoUrl: "javascript:alert(1)" }, { teamId: 11 }),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(mutations).toHaveLength(0);
  });
  it("rotates the random token and clears the old installation signal", async () => {
    rows = [[team], [member], []];
    const response = res();
    await controller.generateWidgetToken(req({ teamId: 11 }), response);
    expect(mutations[0].values).toEqual(
      expect.objectContaining({
        widgetToken: expect.stringMatching(/^[a-f0-9]{64}$/),
        widgetInstallation: null,
      }),
    );
  });
  it("revokes a key within owned-team scope and removes the installation signal", async () => {
    rows = [[{ id: 11 }]];
    const response = res();
    await controller.revokeWidgetToken(req({}, { teamId: 11 }), response);
    expect(mutations[0].values).toEqual(
      expect.objectContaining({ widgetToken: null, widgetInstallation: null }),
    );
    const condition = new PgDialect().sqlToQuery(
      mutations[0].condition as never,
    );
    expect(condition.params).toEqual([11, 7, true]);
  });
  it("rejects unknown/revoked widget tokens when submitting feedback", async () => {
    rows = [[]];
    const response = res();
    await controller.submitWidgetFeedback(
      req(
        { token, sessionToken: "session-key", rating: "helpful" },
        { sessionId: 30 },
      ),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(401);
    expect(mutations).toHaveLength(0);
  });
  it("rejects feedback whose session expires between read and update", async () => {
    rows = [
      [team],
      [member],
      [
        {
          publicToken: "session-key",
          expiresAt: new Date(Date.now() + 10000),
          metadata: { widgetOrigin: "https://widget.example" },
        },
      ],
      [],
    ];
    const response = res();
    await controller.submitWidgetFeedback(
      req(
        { token, sessionToken: "session-key", rating: "helpful" },
        { sessionId: 30 },
      ),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(440);
  });
  it("records the actual Origin rather than a supplied hostname", async () => {
    rows = [[team], [member], []];
    const response = res();
    await controller.recordWidgetInstallation(
      req({
        token,
        origin: "https://widget.example",
        hostname: "spoof.example",
      }),
      response,
    );
    expect(mutations[0].values).toEqual(
      expect.objectContaining({
        widgetInstallation: expect.objectContaining({
          origin: "https://widget.example",
          hostname: "widget.example",
        }),
      }),
    );
  });
  it("rejects an installation origin mismatch", async () => {
    const response = res();
    await controller.recordWidgetInstallation(
      req({ token, origin: "https://spoof.example" }),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(mutations).toHaveLength(0);
  });
  it("uses saved appearance in public config and generated loader", async () => {
    rows = [[team], [member]];
    const response = res();
    await controller.getWidgetConfig(req(), response);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(settings) }),
    );
    rows = [[team], [member]];
    const scriptResponse = res();
    await controller.getEmbedScript(req(), scriptResponse);
    const script = (scriptResponse.send as jest.Mock).mock
      .calls[0][0] as string;
    expect(script).toContain("background: #123456");
    expect(script).toContain("left: 24px");
    expect(script).toContain("method: 'POST'");
    expect(script).toContain("credentials: 'omit'");
    expect(() => new Function(script)).not.toThrow();
  });
  it.each([
    [
      "expired",
      {
        publicToken: "session-key",
        expiresAt: new Date(0),
        metadata: { widgetOrigin: "https://widget.example" },
      },
      440,
    ],
    [
      "wrong session token",
      {
        publicToken: "other-key",
        expiresAt: new Date(Date.now() + 10000),
        metadata: { widgetOrigin: "https://widget.example" },
      },
      403,
    ],
    [
      "wrong origin",
      {
        publicToken: "session-key",
        expiresAt: new Date(Date.now() + 10000),
        metadata: { widgetOrigin: "https://other.example" },
      },
      403,
    ],
    ["cross-team session", null, 403],
  ])("rejects feedback for %s", async (_label, session, status) => {
    rows = [[team], [member], session ? [session] : []];
    const response = res();
    await controller.submitWidgetFeedback(
      req(
        { token, sessionToken: "session-key", rating: "helpful" },
        { sessionId: 30 },
      ),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(status);
    expect(mutations).toHaveLength(0);
  });
  it("stores feedback on a credentialed team-owned unexpired session", async () => {
    rows = [
      [team],
      [member],
      [
        {
          publicToken: "session-key",
          expiresAt: new Date(Date.now() + 10000),
          metadata: { widgetOrigin: "https://widget.example" },
        },
      ],
      [{ id: 30 }],
    ];
    const response = res();
    await controller.submitWidgetFeedback(
      req(
        {
          token,
          sessionToken: "session-key",
          rating: "not_helpful",
          comment: "More detail please",
        },
        { sessionId: 30 },
      ),
      response,
    );
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rating: "not_helpful",
          comment: "More detail please",
          ratedAt: expect.any(String),
        }),
      }),
    );
    const condition = new PgDialect().sqlToQuery(
      mutations[0].condition as never,
    );
    expect(condition.params).toEqual([30, "session-key"]);
    expect(condition.sql).toContain("session_expires_at");
  });
});
