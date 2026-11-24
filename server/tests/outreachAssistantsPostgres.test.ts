import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { randomUUID } from "node:crypto";
import type { AssistantActivity } from '../../shared/assistantOperations.js';
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import type { Server } from "node:http";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import {
  requireBusinessScope,
  withBusinessScope,
} from "../tenancy/businessContext.js";
import {
  emptyAssistantDraft,
  type AssistantCatalog,
  type AssistantDraft,
  type AssistantChannel,
} from "../../shared/outreachAssistants.js";

const target = process.env.ASSISTANTS_TEST_DATABASE;
const suite = target ? describe : describe.skip;
let pool: Pool, admin: Pool, database: NodePgDatabase;
let userId: number,
  otherUserId: number,
  profileId: number,
  secondProfileId: number,
  otherProfileId: number,
  teamId: number,
  sessionId: number;
let catalog: AssistantCatalog, mainId: string;
const conversations = new Map<string, number>();
const providerCalls: Array<Record<string, unknown>> = [];
let providerMode: "confirmed" | "missing_ack" | "throw" = "confirmed";
let brandVersion = 1;
const proxy = new Proxy(
  {},
  {
    get: (_target, key) => {
      const value = database[key as keyof NodePgDatabase];
      return typeof value === "function" ? value.bind(database) : value;
    },
  },
);
jest.unstable_mockModule("../models/db.js", () => ({ db: proxy }));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule(
  "../services/assistants/AssistantCatalogService.js",
  () => ({
    assistantCatalog: async () => catalog,
    availableAssistantModels: async () => catalog?.models || [],
    assistantPlatformReadiness: async () => ({
      classifier: true,
      privacyVault: true,
    }),
  }),
);
jest.unstable_mockModule(
  "../services/content/ContentBrandContextService.js",
  () => ({
    resolveContentBrandContext: async () => ({
      businessProfile: {
        id: requireBusinessScope().businessProfileId,
        version: brandVersion,
        companyName: "Fixture company",
        website: "https://example.invalid",
      },
      brandToolkit: { id: 1, version: brandVersion },
      provenance: {},
    }),
  }),
);
jest.unstable_mockModule("../middleware/platformAccess.js", () => ({
  requireModuleAccess: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
jest.unstable_mockModule("../services/whatsappApiService.js", () => ({
  whatsappApiService: {
    sendText: async (args: Record<string, unknown>) => {
      providerCalls.push(args);
      if (providerMode === "throw")
        throw new Error("Synthetic provider transport uncertainty");
      return {
        messages:
          providerMode === "confirmed"
            ? [{ id: `fixture-wa-${randomUUID()}` }]
            : [],
      };
    },
  },
}));
// The simulator's model is deliberately offline; routing, privacy, API and DB
// behavior remain real. No test can contact a customer or an external provider.
jest.unstable_mockModule(
  "../services/agents/pipeline/ChannelGateway.js",
  () => ({
    channelGateway: {
      process: async (message: any) => {
        const resolved = await resolveTurnAssistant({
          ...message,
          metadata: { ...message.metadata, dryRun: true },
        });
        const input = redactPiiWithStableTokens(
          message.inboundText,
        ).redactedText;
        return {
          method: "ready_for_channel_delivery",
          context: {
            message: { ...message, inboundText: input },
            guardrailResult: {
              finalText:
                "Offline simulator: " +
                resolved!.configuration.privacy.uncertaintyMessage,
            },
            metadata: {
              resolvedAssistant: {
                ...resolved!.provenance,
                replyModel: resolved!.configuration.replyModel,
              },
              privacy: { piiTypes: ["email"] },
            },
            contextLanes: { knowledge: { evidence: [] } },
            agentResult: { toolCallsExecuted: [] },
          },
        };
      },
    },
  }),
);
const { assistantService } =
  await import("../services/assistants/AssistantService.js");
const { resolveTurnAssistant } =
  await import("../services/assistants/AssistantResolver.js");
const {
  assistantProvenanceCurrent,
  assistantDeliveryCurrent,
  withPublishedAssistant,
  withPrivateAssistantForPublicDelivery,
} = await import("../services/assistants/AssistantFreshness.js");
const { withAssistantContext } =
  await import("../services/assistants/AssistantContext.js");
const { AssistantAvailabilityStage, confirmAssistantAwayMessage } =
  await import("../services/assistants/AssistantAvailability.js");
const {
  assistantFollowUps,
  scheduleAssistantFollowUp,
  cancelAssistantFollowUps,
} = await import("../services/assistants/AssistantFollowUps.js");
const { deliveryOutboxService } =
  await import("../services/agents/orchestration/DeliveryOutboxService.js");
const { redactPiiWithStableTokens } =
  await import("../services/agents/orchestration/PrivacyVaultService.js");
const router = (await import("../routes/outreachAssistants.routes.js")).default;

function owner<T>(work: () => T, profile = profileId) {
  return withBusinessScope(
    { userId, businessProfileId: profile, actorUserId: userId, role: "owner" },
    work,
  );
}
function readyDraft(
  name = "Fixture assistant",
  bindings = catalog.accounts
    .filter((a) => a.surface === "private")
    .map(({ channel, surface, accountId }) => ({
      channel,
      surface,
      accountId,
    })),
): AssistantDraft {
  const draft = emptyAssistantDraft();
  draft.name = name;
  draft.agentType = "general_service";
  draft.instructions = "Use only verified, explicitly assigned information.";
  draft.bindings = bindings;
  draft.replyModel = { provider: "openai", model: "gpt-4o-mini" };
  for (const key of ["knowledge", "documents", "galleries"] as const)
    draft[key].mode = "none";
  draft.playbooks.mode = "none";
  draft.followUps.mode = "none";
  draft.tools.mode = "none";
  return draft;
}
function appFor(actor = userId, profile = profileId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.setHeader(
      "Access-Control-Allow-Origin",
      String(req.headers.origin || "http://127.0.0.1:3167"),
    );
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,X-Business-Profile-Id",
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,DELETE,OPTIONS",
    );
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  app.use((req, _res, next) => {
    req.user = { id: actor } as any;
    withBusinessScope(
      {
        userId,
        businessProfileId: profile,
        actorUserId: actor,
        role: actor === userId ? "owner" : "member",
      },
      next,
    );
  });
  app.use("/api/settings/outreach/assistants", router);
  return app;
}
async function conversation(channel: AssistantChannel, accountId: string) {
  const lead = (
    await database.execute(sql`INSERT INTO leads(uuid,user_id,source,name,full_name,email,phone,status)
    VALUES(${randomUUID()},${userId},'assistant_qa','Synthetic Customer','Synthetic Customer','customer@example.invalid','15550000001','replied') RETURNING id`)
  ).rows[0];
  return Number(
    (
      await database.execute(sql`INSERT INTO outreach_conversations(user_id,lead_id,channel,provider_account_id,external_thread_id,lead_email)
    VALUES(${userId},${Number(lead.id)},${channel},${accountId},${channel === "email" ? "fixture-email-thread" : "15550000001"},'customer@example.invalid') RETURNING id`)
    ).rows[0].id,
  );
}
async function resolved(
  channel: AssistantChannel,
  conversationId = conversations.get(channel)!,
) {
  return (await resolveTurnAssistant({
    userId,
    conversationId: channel === "web" ? -sessionId : conversationId,
    channel,
    senderIdentifier: "customer@example.invalid",
    inboundText: "Hello",
    metadata: { executionMode: "customer" },
  }))!;
}
async function newFollowUpFixture(
  templateContent = "Do you still need any help?",
) {
  const accountId = `phone-${randomUUID()}`;
  catalog.accounts.push({
    channel: "whatsapp",
    surface: "private",
    accountId,
    label: "Synthetic WhatsApp",
    connected: true,
  });
  const templateId = Number(
    (
      await database.execute(sql`INSERT INTO content_templates(user_id,name,type,content,is_approved,approved_by,brand_context_snapshot)
    VALUES(${userId},'Approved synthetic follow-up','whatsapp',${templateContent},TRUE,${userId},${JSON.stringify({ provenance: { businessProfile: { version: brandVersion }, brandToolkit: { version: brandVersion } } })}::jsonb) RETURNING id`)
    ).rows[0].id,
  );
  catalog.templates.push({
    id: templateId,
    name: "Approved synthetic follow-up",
    channels: ["whatsapp"],
    variables: [],
  });
  const draft = readyDraft("Follow-up fixture", [
    { channel: "whatsapp", surface: "private", accountId },
  ]);
  draft.followUps = {
    mode: "selected",
    sequences: [
      { channel: "whatsapp", steps: [{ delayMinutes: 1, templateId }] },
    ],
  };
  const created = await assistantService.create(draft);
  await assistantService.publish(created.id, created.draftVersion);
  const conversationId = await conversation("whatsapp", accountId),
    context = await resolved("whatsapp", conversationId);
  await database.execute(
    sql`INSERT INTO outreach_messages(user_id,conversation_id,direction,content,status) VALUES(${userId},${conversationId},'inbound','Hello','received')`,
  );
  const anchorId = Number(
    (
      await database.execute(sql`INSERT INTO outreach_messages(user_id,conversation_id,direction,content,status,message_kind,provider_call_state,sent_at,metadata)
    VALUES(${userId},${conversationId},'outbound','Confirmed support reply','sent','reply','confirmed',NOW()-INTERVAL '2 minutes',${JSON.stringify({ assistant: context.provenance })}::jsonb) RETURNING id`)
    ).rows[0].id,
  );
  await scheduleAssistantFollowUp(anchorId);
  return { id: created.id, conversationId, context, anchorId, templateId };
}

suite(
  "assistant revisions, routing, privacy and confirmed follow-ups in isolated PostgreSQL",
  () => {
    beforeAll(async () => {
      if (!target?.startsWith("asksales_assistants_qa_"))
        throw new Error(
          "Only a disposable assistant QA database is permitted.",
        );
      process.env.SUPPORT_ASSISTANTS_ENABLED = "true";
      delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
      process.env.SUPPORT_PII_ENCRYPTION_KEY =
        "assistant-qa-fixture-key-at-least-32-characters";
      admin = new Pool({
        host: "/tmp",
        database: target,
        max: 1,
        options: "-c timezone=UTC",
      });
      pool = createBusinessScopedPool(
        new Pool({
          host: "/tmp",
          database: target,
          max: 8,
          options: "-c timezone=UTC",
        }),
      );
      database = drizzle(pool);
      // Previous interrupted runs can leave synthetic schedules due. The worker
      // is global, so retire ONLY this suite's clearly identified old fixtures.
      const staleFixtures=await admin.query("SELECT u.id,c.id AS profile_id FROM users u JOIN company_settings c ON c.user_id=u.id WHERE u.name='Assistant QA owner' AND u.password='fixture' AND u.email LIKE 'assistant-%@example.invalid'");
      for (const fixture of staleFixtures.rows) await withBusinessScope({userId:Number(fixture.id),businessProfileId:Number(fixture.profile_id),actorUserId:Number(fixture.id),role:'owner'},async()=> {
        await database.execute(sql`UPDATE outreach_assistant_follow_up_schedules SET status='cancelled',version=version+1,cancellation_reason='qa_fixture_retired' WHERE user_id=${Number(fixture.id)} AND business_profile_id=${Number(fixture.profile_id)} AND status IN ('active','queued')`);
        await database.execute(sql`UPDATE support_delivery_outbox SET status='cancelled',next_attempt_at=NULL,last_error='qa_fixture_retired' WHERE user_id=${Number(fixture.id)} AND business_profile_id=${Number(fixture.profile_id)} AND status IN ('pending','failed','drafted')`);
      });
      const suffix = randomUUID();
      const users = await admin.query(
        "INSERT INTO users(email,password,name,is_approved) VALUES($1,'fixture','Assistant QA owner',TRUE),($2,'fixture','Other owner',TRUE) RETURNING id",
        [
          `assistant-${suffix}@example.invalid`,
          `other-${suffix}@example.invalid`,
        ],
      );
      [userId, otherUserId] = users.rows.map((row) => Number(row.id));
      profileId = Number(
        (
          await admin.query(
            "INSERT INTO company_settings(user_id,name,company_name,is_default) VALUES($1,'Assistant QA','Synthetic Company',TRUE) RETURNING id",
            [userId],
          )
        ).rows[0].id,
      );
      secondProfileId = Number(
        (
          await admin.query(
            "INSERT INTO company_settings(user_id,name,company_name,is_default) VALUES($1,'Second assistant QA','Second Synthetic Company',FALSE) RETURNING id",
            [userId],
          )
        ).rows[0].id,
      );
      otherProfileId = Number(
        (
          await admin.query(
            "INSERT INTO company_settings(user_id,name,company_name,is_default) VALUES($1,'Other assistant QA','Other Synthetic Company',TRUE) RETURNING id",
            [otherUserId],
          )
        ).rows[0].id,
      );
      await owner(async () => {
        teamId = Number(
          (
            await database.execute(
              sql`INSERT INTO support_teams(user_id,name,is_active,widget_token) VALUES(${userId},'Assistant QA widget',TRUE,${randomUUID().replaceAll("-", "")}) RETURNING id`,
            )
          ).rows[0].id,
        );
        const memberId = Number(
          (
            await database.execute(
              sql`INSERT INTO team_members(user_id,team_id,name,is_active) VALUES(${userId},${teamId},'Synthetic Support',TRUE) RETURNING id`,
            )
          ).rows[0].id,
        );
        sessionId = Number(
          (
            await database.execute(
              sql`INSERT INTO support_chat_sessions(member_id,automation_mode) VALUES(${memberId},'ai_active') RETURNING id`,
            )
          ).rows[0].id,
        );
      });
      catalog = {
        runtimeEnabled: true,
        presets: [
          {
            agentType: "general_service",
            name: "General service",
            description: "Support",
            instructions: "Verified sources only",
            tools: [],
            policies: {},
          },
        ],
        models: [
          {
            provider: "openai",
            model: "gpt-4o-mini",
            label: "Offline configured reply model",
            controls: ["temperature", "topP"],
          },
        ],
        accounts: [
          {
            channel: "whatsapp",
            surface: "private",
            accountId: "phone-a",
            label: "Synthetic WhatsApp",
            connected: true,
          },
          {
            channel: "instagram",
            surface: "private",
            accountId: "ig-a",
            label: "Synthetic Instagram",
            connected: true,
          },
          {
            channel: "instagram",
            surface: "public_comment",
            accountId: "ig-a",
            label: "Synthetic Instagram comments",
            connected: true,
          },
          {
            channel: "facebook",
            surface: "private",
            accountId: "fb-a",
            label: "Synthetic Messenger",
            connected: true,
          },
          {
            channel: "facebook",
            surface: "public_comment",
            accountId: "fb-a",
            label: "Synthetic Facebook comments",
            connected: true,
          },
          {
            channel: "email",
            surface: "private",
            accountId: "support@example.invalid",
            label: "Synthetic email",
            connected: true,
          },
          {
            channel: "web",
            surface: "private",
            accountId: `team:${teamId}`,
            label: "Synthetic web chat",
            connected: true,
          },
        ],
        knowledge: [],
        playbooks: [],
        templates: [],
        documents: [],
        galleries: [],
        tools: [],
        permissions: {
          canManage: true,
          description: "Existing staff permissions",
        },
      };
      await owner(async () => {
        for (const account of catalog.accounts.filter(
          (a) => a.surface === "private" && a.channel !== "web",
        ))
          conversations.set(
            account.channel,
            await conversation(account.channel, account.accountId),
          );
      });
    });
    beforeEach(() => {
      providerCalls.length = 0;
      providerMode = "confirmed";
      brandVersion = 1;
    });
    afterAll(async () => {
      delete process.env.SUPPORT_ASSISTANTS_ENABLED;
      if(database&&userId) for(const profile of [profileId,secondProfileId]) await owner(()=>database.execute(sql`UPDATE outreach_assistant_follow_up_schedules SET status='cancelled',version=version+1,cancellation_reason='qa_complete' WHERE user_id=${userId} AND business_profile_id=${profile} AND status IN ('active','queued')`),profile);
      await pool?.end();
      await admin?.end();
    });

    it("creates drafts through the API without enabling replies; mutation requires the business owner", async () => {
      const created = await request(appFor())
        .post("/api/settings/outreach/assistants")
        .send({ draft: readyDraft() })
        .expect(201);
      mainId = created.body.id;
      expect(created.body).toMatchObject({
        state: "draft",
        publishedRevision: null,
        draftVersion: 1,
      });
      await owner(async () =>
        expect(
          (
            await database.execute(
              sql`SELECT id FROM outreach_assistant_bindings WHERE assistant_id=${mainId}::uuid`,
            )
          ).rows,
        ).toHaveLength(0),
      );
      await request(appFor(otherUserId))
        .post("/api/settings/outreach/assistants")
        .send({ draft: readyDraft() })
        .expect(403);
      await request(appFor())
        .post(`/api/settings/outreach/assistants/${mainId}/publish`)
        .send({ expectedDraftVersion: 1 })
        .expect(400);
      await request(appFor())
        .post(`/api/settings/outreach/assistants/${mainId}/publish`)
        .send({ expectedDraftVersion: 1, confirmAssignments: true })
        .expect(200);
    });
    it("routes all five reply channels only by the original account and business profile", async () =>
      owner(async () => {
        for (const channel of [
          "whatsapp",
          "instagram",
          "facebook",
          "email",
          "web",
        ] as const) {
          const context = await resolved(channel);
          expect(context.provenance).toMatchObject({
            assistantId: mainId,
            revision: 1,
            channel,
            businessProfileId: profileId,
          });
          expect(Object.isFrozen(context.configuration)).toBe(true);
        }
        await expect(
          resolveTurnAssistant({
            userId,
            conversationId: conversations.get("whatsapp")!,
            channel: "whatsapp",
            senderIdentifier: "test",
            inboundText: "Hello",
            phoneNumberId: "phone-b",
            metadata: { executionMode: "customer" },
          }),
        ).rejects.toThrow("identity changed");
        await expect(
          owner(() => resolved("whatsapp"), secondProfileId),
        ).rejects.toThrow("cannot be verified");
      }));
    it("keeps private messages and public comments as independent assignments", async () =>
      owner(async () => {
        await expect(
          resolveTurnAssistant({
            userId,
            conversationId: conversations.get("instagram")!,
            channel: "instagram_comment",
            senderIdentifier: "test",
            inboundText: "Hello",
            metadata: { executionMode: "customer" },
          }),
        ).rejects.toThrow("No unique live");
        const draft = readyDraft("Public comments", [
          {
            channel: "instagram",
            surface: "public_comment",
            accountId: "ig-a",
          },
        ]);
        const created = await assistantService.create(draft);
        await assistantService.publish(created.id, created.draftVersion);
        const context = await resolveTurnAssistant({
          userId,
          conversationId: conversations.get("instagram")!,
          channel: "instagram_comment",
          senderIdentifier: "test",
          inboundText: "Hello",
          metadata: { executionMode: "customer" },
        });
        expect(context?.provenance).toMatchObject({
          assistantId: created.id,
          surface: "public_comment",
        });
        expect((await resolved("instagram")).provenance.assistantId).toBe(
          mainId,
        );
        let privateSent = false;
        expect(
          await withPrivateAssistantForPublicDelivery(
            context?.provenance,
            async () => {
              privateSent = true;
            },
          ),
        ).toBe(false);
        expect(privateSent).toBe(false);
        const privateContext = await resolved("instagram");
        const pending = await withAssistantContext(privateContext, () =>
          deliveryOutboxService.enqueue(
            {
              userId,
              conversationId: conversations.get("instagram")!,
              channel: "instagram",
              idempotencyKey: "private-pending",
            },
            {
              text: "Private draft remains private",
              recipient: "synthetic",
              metadata: { dispatchKind: "pipeline_message" },
            },
          ),
        );
        await assistantService.pause(created.id);
        expect(
          (
            await database.execute(
              sql`SELECT status FROM support_delivery_outbox WHERE id=${pending.id}`,
            )
          ).rows[0].status,
        ).toBe("pending");
        expect(
          await assistantProvenanceCurrent(privateContext.provenance),
        ).toBe(true);
        await assistantService.resume(created.id);
      }));
    it("resolves read-only email/composer previews by the owned original receiving account without a global specialist", async () =>
      owner(async () => {
        const preview = await resolveTurnAssistant({
          userId,
          conversationId: -1700000010,
          channel: "email",
          senderIdentifier: "synthetic",
          inboundText: "Hello",
          metadata: {
            executionMode: "preview",
            dryRun: true,
            conversationKind: "email_smart_reply",
            sourceConversationId: conversations.get("email"),
          },
        });
        expect(preview).toMatchObject({
          preview: true,
          provenance: {
            assistantId: mainId,
            accountId: "support@example.invalid",
            revision: 1,
          },
        });
        await expect(
          owner(
            () =>
              resolveTurnAssistant({
                userId,
                conversationId: -1700000010,
                channel: "email",
                senderIdentifier: "synthetic",
                inboundText: "Hello",
                metadata: {
                  executionMode: "preview",
                  dryRun: true,
                  conversationKind: "email_smart_reply",
                  sourceConversationId: conversations.get("email"),
                },
              }),
            secondProfileId,
          ),
        ).rejects.toThrow("cannot be verified");
      }));
    it("keeps saved incomplete drafts separate from the live revision and enforces optimistic saving", async () =>
      owner(async () => {
        const current = await assistantService.get(mainId),
          draft = { ...current.draft, name: "Unfinished draft", bindings: [] };
        const saved = await assistantService.save(
          mainId,
          draft,
          current.draftVersion,
        );
        expect(saved.state).toBe("live");
        expect(saved.published?.name).toBe("Fixture assistant");
        expect(saved.readiness.ready).toBe(false);
        expect((await resolved("whatsapp")).configuration.name).toBe(
          "Fixture assistant",
        );
        await expect(
          assistantService.save(mainId, draft, current.draftVersion),
        ).rejects.toMatchObject({ status: 409 });
        await expect(
          assistantService.publish(mainId, saved.draftVersion),
        ).rejects.toMatchObject({ status: 422 });
        await expect(
          pool.query(
            "UPDATE outreach_assistant_revisions SET configuration=$1 WHERE assistant_id=$2",
            [JSON.stringify(draft), mainId],
          ),
        ).rejects.toThrow("immutable");
      }));
    it("enforces RLS, business ownership and a unique enabled binding even for direct SQL", async () => {
      await owner(async () => {
        const current = await assistantService.get(mainId);
        await expect(
          database.execute(sql`INSERT INTO outreach_assistant_bindings(user_id,assistant_id,revision,channel,surface,account_id)
        VALUES(${userId},${mainId}::uuid,1,'whatsapp','private','phone-a')`),
        ).rejects.toThrow();
        await expect(
          pool.query(
            "INSERT INTO outreach_assistants(id,user_id,business_profile_id,draft) VALUES($1,$2,$3,$4)",
            [
              randomUUID(),
              otherUserId,
              otherProfileId,
              JSON.stringify(current.draft),
            ],
          ),
        ).rejects.toThrow();
      });
      await owner(async () => {
        expect(
          (
            await database.execute(
              sql`SELECT id FROM outreach_assistants WHERE id=${mainId}::uuid`,
            )
          ).rows,
        ).toHaveLength(0);
        await expect(assistantService.get(mainId)).rejects.toMatchObject({
          status: 404,
        });
      }, secondProfileId);
    });
    it("simulates the chosen draft without changing CRM, bindings, approvals or outbox and returns a scoped continuation", async () => {
      const before = await owner(() =>
        database.execute(
          sql`SELECT (SELECT count(*) FROM outreach_messages) AS messages,(SELECT count(*) FROM tool_approvals) AS approvals,(SELECT count(*) FROM support_delivery_outbox) AS outbox`,
        ),
      );
      const first = await request(appFor())
        .post(`/api/settings/outreach/assistants/${mainId}/simulate`)
        .send({
          message: "Email me at synthetic@example.invalid",
          channel: "web",
          revision: "draft",
        })
        .expect(200);
      expect(first.body.sideEffectsSuppressed).toBe(true);
      expect(first.body.resolvedAssistant).toMatchObject({
        assistantId: mainId,
        revision: 0,
      });
      expect(first.body.privacyOutcome.redactedInput).not.toContain(
        "synthetic@example.invalid",
      );
      const second = await request(appFor())
        .post(`/api/settings/outreach/assistants/${mainId}/simulate`)
        .send({
          message: "Hello again",
          channel: "web",
          revision: "draft",
          conversationId: first.body.conversationId,
          previewSessionToken: first.body.previewSessionToken,
        })
        .expect(200);
      expect(second.body.conversationId).toBe(first.body.conversationId);
      await request(appFor())
        .post(`/api/settings/outreach/assistants/${mainId}/simulate`)
        .send({
          message: "Wrong context",
          channel: "email",
          revision: "draft",
          conversationId: first.body.conversationId,
          previewSessionToken: first.body.previewSessionToken,
        })
        .expect(400);
      const after = await owner(() =>
        database.execute(
          sql`SELECT (SELECT count(*) FROM outreach_messages) AS messages,(SELECT count(*) FROM tool_approvals) AS approvals,(SELECT count(*) FROM support_delivery_outbox) AS outbox`,
        ),
      );
      expect(after.rows).toEqual(before.rows);
    });
    it("blocks conflicting publication until explicit reassignment, cancels old unsent work and makes old turns stale", async () =>
      owner(async () => {
        const old = await resolved("whatsapp"),
          conversationId = conversations.get("whatsapp")!;
        const action = await withAssistantContext(old, () =>
          deliveryOutboxService.enqueue(
            {
              userId,
              conversationId,
              channel: "whatsapp",
              idempotencyKey: "before-reassignment",
            },
            {
              text: "Old draft",
              recipient: "15550000001",
              phoneNumberId: "phone-a",
              metadata: { dispatchKind: "pipeline_message" },
            },
          ),
        );
        const next = await assistantService.create(
          readyDraft("Replacement", [
            { channel: "whatsapp", surface: "private", accountId: "phone-a" },
          ]),
        );
        await expect(
          assistantService.publish(next.id, next.draftVersion),
        ).rejects.toMatchObject({ status: 409 });
        await assistantService.publish(next.id, next.draftVersion, true);
        expect(await assistantProvenanceCurrent(old.provenance)).toBe(false);
        expect((await resolved("whatsapp")).provenance.assistantId).toBe(
          next.id,
        );
        expect(
          (
            await database.execute(
              sql`SELECT status FROM support_delivery_outbox WHERE id=${action.id}`,
            )
          ).rows[0].status,
        ).toBe("cancelled");
        await expect(
          withPublishedAssistant(old.provenance, async () => {
            throw new Error("Must not run");
          }),
        ).rejects.toThrow("superseded");
        await assistantService.pause(next.id);
        await expect(resolved("whatsapp")).rejects.toThrow("No unique live");
        await assistantService.resume(next.id);
        expect((await resolved("whatsapp")).provenance.revision).toBe(2);
        await expect(assistantService.remove(next.id)).rejects.toMatchObject({
          status: 409,
        });
      }));
    it("creates check-ins only for acknowledged support replies and completes the receipt and step atomically", async () =>
      owner(async () => {
        const fixture = await newFollowUpFixture();
        expect(await scheduleAssistantFollowUp(fixture.anchorId)).toBe(false);
        const unconfirmed = Number(
          (
            await database.execute(sql`INSERT INTO outreach_messages(user_id,conversation_id,direction,content,status,message_kind,metadata)
      VALUES(${userId},${fixture.conversationId},'outbound','Not confirmed','pending','reply',${JSON.stringify({ assistant: fixture.context.provenance })}::jsonb) RETURNING id`)
          ).rows[0].id,
        );
        expect(await scheduleAssistantFollowUp(unconfirmed)).toBe(false);
        await assistantFollowUps.processDue();
        const ownCalls=providerCalls.filter(call=>Number(call.userId)===userId);
        expect(ownCalls).toHaveLength(1);
        expect(ownCalls[0].phoneNumberId).toBe(
          fixture.context.provenance.accountId,
        );
        const history = await assistantService.history(fixture.id);
        expect(history.history).toHaveLength(1);
        expect(history.history[0].status).toBe("sent");
        expect(
          (
            await database.execute(
              sql`SELECT status,next_step FROM outreach_assistant_follow_up_schedules WHERE conversation_id=${fixture.conversationId}`,
            )
          ).rows[0],
        ).toMatchObject({ status: "completed", next_step: 1 });
        await assistantFollowUps.processDue();
        expect(providerCalls).toHaveLength(1);
      }));
    it("restores previous reviewed bindings on rollback without overwriting later account changes", async () =>
      owner(async () => {
        const accountId = `rollback-${randomUUID()}`;
        catalog.accounts.push({
          channel: "facebook",
          surface: "private",
          accountId,
          label: "Rollback fixture",
          connected: true,
        });
        const original = await assistantService.create(
          readyDraft("Before rollout", [
            { channel: "facebook", surface: "private", accountId },
          ]),
        );
        await assistantService.publish(original.id, 1);
        const conversationId = await conversation("facebook", accountId),
          before = await resolved("facebook", conversationId);
        const next = await assistantService.create(
          readyDraft("New rollout", [
            { channel: "facebook", surface: "private", accountId },
          ]),
        );
        await assistantService.publish(next.id, 1, true);
        expect(
          (await resolved("facebook", conversationId)).provenance.assistantId,
        ).toBe(next.id);
        await expect(
          assistantService.rollbackBindings(next.id, 2),
        ).rejects.toMatchObject({ status: 409 });
        await assistantService.rollbackBindings(next.id, 1);
        const after = await resolved("facebook", conversationId);
        expect(after.provenance.assistantId).toBe(original.id);
        expect(after.provenance.bindingId).not.toBe(
          before.provenance.bindingId,
        );
        expect((await assistantService.get(next.id)).state).toBe("paused");
        expect(await assistantProvenanceCurrent(before.provenance)).toBe(false);
      }));
    it.each([
      "new_reply",
      "opt_out",
      "human_takeover",
      "closure",
      "pause",
    ] as const)("cancels a pending check-in on %s", async (event) =>
      owner(async () => {
        const fixture = await newFollowUpFixture();
        if (event === "new_reply")
          await database.execute(
            sql`INSERT INTO outreach_messages(user_id,conversation_id,direction,content,status) VALUES(${userId},${fixture.conversationId},'inbound','Another customer message','received')`,
          );
        if (event === "opt_out")
          await database.execute(
            sql`UPDATE outreach_conversations SET status='unsubscribed' WHERE id=${fixture.conversationId}`,
          );
        if (event === "human_takeover")
          await database.execute(
            sql`UPDATE outreach_conversations SET automation_mode='human_owned' WHERE id=${fixture.conversationId}`,
          );
        if (event === "closure")
          await database.execute(
            sql`UPDATE outreach_conversations SET session_ended_at=NOW() WHERE id=${fixture.conversationId}`,
          );
        if (event === "pause") await assistantService.pause(fixture.id);
        await assistantFollowUps.processDue();
        expect(providerCalls).toHaveLength(0);
        expect(
          (
            await database.execute(
              sql`SELECT status FROM outreach_assistant_follow_up_schedules WHERE conversation_id=${fixture.conversationId}`,
            )
          ).rows[0].status,
        ).toBe("cancelled");
      }),
    );
    it.each([
      "withdrawn",
      "brand_changed",
      "missing_variable",
      "unpermitted_personal_value",
      "window_closed",
    ] as const)("stops safely when a follow-up becomes %s", async (failure) =>
      owner(async () => {
        const fixture = await newFollowUpFixture();
        if (failure === "withdrawn")
          await database.execute(
            sql`UPDATE content_templates SET is_approved=FALSE WHERE id=${fixture.templateId}`,
          );
        if (failure === "brand_changed") brandVersion = 2;
        if (failure === "missing_variable")
          await database.execute(
            sql`UPDATE content_templates SET content='Hello {{unrecognisedField}}' WHERE id=${fixture.templateId}`,
          );
        if (failure === "unpermitted_personal_value")
          await database.execute(
            sql`UPDATE content_templates SET content='Hello {{email}}' WHERE id=${fixture.templateId}`,
          );
        if (failure === "window_closed")
          await database.execute(
            sql`UPDATE outreach_messages SET created_at=NOW()-INTERVAL '25 hours' WHERE conversation_id=${fixture.conversationId} AND direction='inbound'`,
          );
        await assistantFollowUps.processDue();
        expect(providerCalls).toHaveLength(0);
        expect(
          (
            await database.execute(
              sql`SELECT status FROM outreach_assistant_follow_up_schedules WHERE conversation_id=${fixture.conversationId}`,
            )
          ).rows[0].status,
        ).toBe("stopped");
      }),
    );
    it.each(["missing_ack", "throw"] as const)(
      "never reports confirmed delivery or retries a follow-up after %s",
      async (mode) =>
        owner(async () => {
          const fixture = await newFollowUpFixture();
          providerMode = mode;
          await assistantFollowUps.processDue();
          expect(providerCalls).toHaveLength(1);
          expect(
            (
              await database.execute(
                sql`SELECT status FROM outreach_assistant_follow_up_schedules WHERE conversation_id=${fixture.conversationId}`,
              )
            ).rows[0].status,
          ).toBe("uncertain");
          expect(
            (await assistantService.history(fixture.id)).history,
          ).toHaveLength(0);
          await assistantFollowUps.processDue();
          expect(providerCalls).toHaveLength(1);
        }),
    );
    it("defers support check-ins outside assigned hours rather than delivering them", async () =>
      owner(async () => {
        const fixture = await newFollowUpFixture();
        const current = await assistantService.get(fixture.id);
        const tomorrow = ((((new Date().getUTCDay() + 6) % 7) + 1) % 7) + 1;
        current.draft.availability = {
          enabled: true,
          timezone: "UTC",
          weekly: [
            { day: tomorrow, ranges: [{ start: "00:00", end: "24:00" }] },
          ],
          awayMessage: null,
        };
        const saved = await assistantService.save(
          fixture.id,
          current.draft,
          current.draftVersion,
        );
        await assistantService.publish(fixture.id, saved.draftVersion);
        const context = await resolved("whatsapp", fixture.conversationId);
        await database.execute(
          sql`UPDATE outreach_assistant_follow_up_schedules SET status='active',assistant_provenance=${JSON.stringify(context.provenance)}::jsonb,binding_id=${context.provenance.bindingId},next_run_at=NOW()-INTERVAL '1 minute' WHERE conversation_id=${fixture.conversationId}`,
        );
        await assistantFollowUps.processDue();
        expect(providerCalls).toHaveLength(0);
        const row = (
          await database.execute(
            sql`SELECT status,next_run_at>NOW() AS deferred FROM outreach_assistant_follow_up_schedules WHERE conversation_id=${fixture.conversationId}`,
          )
        ).rows[0];
        expect(row).toMatchObject({ status: "active", deferred: true });
        await cancelAssistantFollowUps(fixture.conversationId, "qa_complete");
      }));
    it("reserves away messages without claiming delivery, rate-limits confirmed sends and invalidates expired reservations", async () =>
      owner(async () => {
        const accountId = `away-${randomUUID()}`;
        catalog.accounts.push({
          channel: "whatsapp",
          surface: "private",
          accountId,
          label: "Away fixture",
          connected: true,
        });
        const draft = readyDraft("Away fixture", [
          { channel: "whatsapp", surface: "private", accountId },
        ]);
        const tomorrow = ((((new Date().getUTCDay() + 6) % 7) + 1) % 7) + 1;
        draft.availability = {
          enabled: true,
          timezone: "UTC",
          weekly: [
            { day: tomorrow, ranges: [{ start: "00:00", end: "24:00" }] },
          ],
          awayMessage:
            "We are currently away. We can help during our next open hours.",
        };
        const created = await assistantService.create(draft);
        await assistantService.publish(created.id, 1);
        const conversationId = await conversation("whatsapp", accountId),
          context = await resolved("whatsapp", conversationId),
          stage = new AssistantAvailabilityStage();
        const input = () =>
          ({
            message: {
              userId,
              conversationId,
              channel: "whatsapp",
              senderIdentifier: "customer-1",
              inboundText: "Hello",
              metadata: {},
            },
            metadata: {},
          }) as any;
        const first = await withAssistantContext(context, () =>
          stage.execute(input()),
        );
        expect(first.metadata!.assistantAwayReceipt).toBeDefined();
        expect(
          await assistantDeliveryCurrent(context.provenance, first.metadata),
        ).toBe(true);
        expect(
          (
            await database.execute(
              sql`SELECT last_sent_at FROM outreach_assistant_away_receipts WHERE id=${first.metadata!.assistantAwayReceipt.id}`,
            )
          ).rows[0].last_sent_at,
        ).toBeNull();
        await confirmAssistantAwayMessage(first.metadata);
        expect(
          await assistantDeliveryCurrent(context.provenance, first.metadata),
        ).toBe(false);
        await expect(
          withAssistantContext(context, () => stage.execute(input())),
        ).rejects.toThrow("already sent");
        const second = await withAssistantContext(context, () =>
          stage.execute({
            ...input(),
            message: { ...input().message, senderIdentifier: "customer-2" },
          }),
        );
        await database.execute(
          sql`UPDATE outreach_assistant_away_receipts SET reserved_until=NOW()-INTERVAL '1 second' WHERE id=${second.metadata!.assistantAwayReceipt.id}`,
        );
        expect(
          await assistantDeliveryCurrent(context.provenance, second.metadata),
        ).toBe(false);
      }));

    it("imports determinate legacy settings into an idempotent paused review draft and preserves approved email steps and history", async () =>
      owner(async () => {
        const templateId = Number(
          (
            await database.execute(sql`INSERT INTO content_templates(user_id,name,type,content,is_approved,approved_by,brand_context_snapshot)
      VALUES(${userId},'Legacy approved email','email','Synthetic support check-in',TRUE,${userId},${JSON.stringify({ provenance: { businessProfile: { version: 1 }, brandToolkit: { version: 1 } } })}::jsonb) RETURNING id`)
          ).rows[0].id,
        );
        catalog.templates.push({
          id: templateId,
          name: "Legacy approved email",
          channels: ["email"],
          variables: [],
        });
        const legacyId = Number(
          (
            await database.execute(sql`INSERT INTO ai_agent_configs(user_id,agent_type,enabled,display_name,system_prompt,model_override,channel_scope,metadata)
      VALUES(${userId},'general_service',TRUE,'Imported email assistant','Use only approved sources.','gpt-4o-mini','["email"]'::jsonb,
        '{"trainingConversations":[{"userMessage":"Email synthetic@example.invalid","agentReply":"I can help."}]}'::jsonb) RETURNING id`)
          ).rows[0].id,
        );
        await database.execute(sql`INSERT INTO outreach_settings(user_id,enable_auto_follow_up,follow_up_steps)
      VALUES(${userId},TRUE,${JSON.stringify([{ id: 1, delayHours: 2, templateId, templateName: "Legacy approved email", customSubject: "", customBody: "" }])}::jsonb)`);
        const before = (
          await database.execute(
            sql`SELECT count(*) AS count FROM outreach_messages`,
          )
        ).rows;
        await assistantService.migrateLegacy();
        await assistantService.migrateLegacy();
        const imported = (
          await database.execute(
            sql`SELECT id,draft,state,migration_review_required FROM outreach_assistants WHERE legacy_config_id=${legacyId}`,
          )
        ).rows;
        expect(imported).toHaveLength(1);
        expect(imported[0]).toMatchObject({
          state: "paused",
          migration_review_required: true,
        });
        expect((imported[0].draft as any).bindings).toEqual([
          {
            channel: "email",
            surface: "private",
            accountId: "support@example.invalid",
          },
        ]);
        expect((imported[0].draft as any).followUps).toEqual({
          mode: "selected",
          sequences: [
            { channel: "email", steps: [{ delayMinutes: 120, templateId }] },
          ],
        });
        expect(
          JSON.stringify((imported[0].draft as any).demonstrations),
        ).not.toContain("synthetic@example.invalid");
        expect(
          (
            await database.execute(
              sql`SELECT id FROM outreach_assistant_bindings WHERE assistant_id=${String(imported[0].id)}::uuid AND enabled`,
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await database.execute(
              sql`SELECT count(*) AS count FROM outreach_messages`,
            )
          ).rows,
        ).toEqual(before);
      }));

    it('paginates and searches scoped assistant lists and rejects invalid cursors', async () => {
      const prefix=`Paged-${randomUUID()}`;
      await owner(async()=>{for(let n=0;n<3;n++) await assistantService.create(readyDraft(`${prefix}-${n}`));});
      expect((await owner(()=>assistantService.listPage({limit:2,search:prefix}))).assistants).toHaveLength(2);
      const first=await request(appFor()).get('/api/settings/outreach/assistants').query({limit:2,search:prefix}).expect(200);
      expect(first.body.assistants).toHaveLength(2);expect(first.body.nextCursor).toBeTruthy();
      const second=await request(appFor()).get('/api/settings/outreach/assistants').query({limit:2,search:prefix,cursor:first.body.nextCursor}).expect(200);
      expect(second.body.assistants).toHaveLength(1);
      expect(new Set([...first.body.assistants,...second.body.assistants].map(a=>a.id)).size).toBe(3);
      await request(appFor()).get('/api/settings/outreach/assistants').query({limit:0}).expect(400);
      await request(appFor()).get('/api/settings/outreach/assistants').query({cursor:first.body.nextCursor,search:'different'}).expect(400);
      const isolated=await request(appFor(userId,secondProfileId)).get('/api/settings/outreach/assistants').query({search:prefix}).expect(200);
      expect(isolated.body.assistants).toEqual([]);
    });

    it('persists redacted reusable scenarios with owner-only writes and business isolation', async()=>{
      const created=await owner(()=>assistantService.create(readyDraft('Scenario operations'))),url=`/api/settings/outreach/assistants/${created.id}/scenarios`;
      const input={name:'Email test',channel:'email',messages:['Contact person@example.invalid for help'],expected:{replyIncludes:['help'],outcome:'ready_for_channel_delivery',playbookId:null}};
      const saved=await request(appFor()).post(url).send(input).expect(201);
      expect(saved.body.messages[0]).not.toContain('person@example.invalid');
      const list=await request(appFor()).get(url).expect(200);expect(list.body.items).toHaveLength(1);expect(list.body.items[0].id).toBe(saved.body.id);
      await request(appFor(otherUserId)).post(url).send(input).expect(403);
      await request(appFor(userId,secondProfileId)).get(url).expect(404);
      await request(appFor()).post(url).send({...input,messages:Array(21).fill('too many')}).expect(400);
      await request(appFor()).delete(`${url}/${saved.body.id}`).expect(204);
      expect((await request(appFor()).get(url).expect(200)).body.items).toEqual([]);
    });

    it('lists immutable revision records and paginated schedule/outbox receipts without invented sends', async()=>{
      const fixture=await owner(()=>newFollowUpFixture()),base=`/api/settings/outreach/assistants/${fixture.id}`;
      const revision=await request(appFor()).get(`${base}/revisions`).expect(200);
      expect(revision.body.items[0]).toMatchObject({revision:1,current:true});
      expect(revision.body.items[0].configuration.name).toBe('Follow-up fixture');
      await owner(()=>database.execute(sql`INSERT INTO support_delivery_outbox(user_id,conversation_id,channel,decision_key,status,payload,provider_message_id)
        VALUES(${userId},${fixture.conversationId},'whatsapp',${randomUUID()},'sent',${JSON.stringify({text:'Follow-up sent',recipient:'15550000001',metadata:{dispatchKind:'assistant_follow_up',assistant:fixture.context.provenance}})}::jsonb,'confirmed-fixture-receipt')`));
      const first=await request(appFor()).get(`${base}/history?limit=1`).expect(200);
      expect(first.body.history).toHaveLength(1);expect(first.body.nextCursor).toBeTruthy();
      const second=await request(appFor()).get(`${base}/history`).query({limit:1,cursor:first.body.nextCursor}).expect(200);
      expect(second.body.history).toHaveLength(1);expect(second.body.history[0].key).not.toBe(first.body.history[0].key);
      const full=await request(appFor()).get(`${base}/history`).expect(200);
      const history = full.body.history as AssistantActivity[];
      expect(history.some(e=>e.kind==='schedule'&&e.status==='active')).toBe(true);
      expect(history.find(e=>e.kind==='delivery')).toMatchObject({status:'sent',providerMessageId:'confirmed-fixture-receipt'});
      const timeline=await request(appFor()).get(`/api/settings/outreach/assistants/conversations/${fixture.conversationId}/activity`).expect(200);
      expect(timeline.body.context).toMatchObject({assistantId:fixture.id,revision:1,channel:'whatsapp',mode:'ai_active'});
      const activity = timeline.body.items as AssistantActivity[];
      expect(activity.some(e=>e.kind==='session'&&e.status==='started')).toBe(true);
      expect(activity.find(e=>e.kind==='message')!.content).not.toContain('customer@example.invalid');
      await request(appFor(userId,secondProfileId)).get(`/api/settings/outreach/assistants/conversations/${fixture.conversationId}/activity`).expect(404);
      await request(appFor()).get('/api/settings/outreach/assistants/conversations/-1/activity').expect(400);
    });

    it('aggregates actual per-day/account outcomes and tokens, excludes previews and persists gap reviews',async()=>{
      const fixture=await owner(()=>newFollowUpFixture());
      await owner(async()=>{
        for(const outcome of ['auto_sent','error']) await database.execute(sql`INSERT INTO agent_audit_logs(user_id,conversation_id,channel,outcome,duration_ms,confidence,provider_name,provider_model,llm_tokens_used,intent,trace)
          VALUES(${userId},${fixture.conversationId},'whatsapp',${outcome},100,0.8,'openai','fixture-recorded-model',50,'product_info',${JSON.stringify({executionMode:'customer',knowledgeUncertaintyReply:true,resolvedAssistant:fixture.context.provenance})}::jsonb)`);
        await database.execute(sql`INSERT INTO agent_audit_logs(user_id,conversation_id,channel,outcome,provider_name,provider_model,llm_tokens_used,trace)
          VALUES(${userId},${fixture.conversationId},'whatsapp','auto_sent','openai','fixture-recorded-model',999,${JSON.stringify({executionMode:'preview',resolvedAssistant:fixture.context.provenance})}::jsonb)`);
      });
      const url='/api/settings/outreach/assistants/diagnostics',query={assistantId:fixture.id,channel:'whatsapp',accountId:fixture.context.provenance.accountId};
      const report=(await request(appFor()).get(url).query(query).expect(200)).body;
      expect(report.metrics).toHaveLength(1);expect(report.metrics[0]).toMatchObject({replies:1,failures:1,averageDurationMs:100,accountId:fixture.context.provenance.accountId});
      expect(report.metrics[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(report.usage[0]).toMatchObject({calls:2,totalTokens:100,cost:null,currency:null,model:'fixture-recorded-model'});
      expect(report.knowledgeGaps[0]).toMatchObject({count:2,review:'open',conversations:[{id:fixture.conversationId,channel:'whatsapp'}]});
      await request(appFor()).post(`/api/settings/outreach/assistants/${fixture.id}/knowledge-gaps/review`).send({key:report.knowledgeGaps[0].key,review:'reviewed',note:'Verified gap'}).expect(200);
      expect((await request(appFor()).get(url).query(query).expect(200)).body.knowledgeGaps[0].review).toBe('reviewed');
      await owner(async()=>{
        const {createLLMUsage}=await import('../models/llmUsages/functions.js');
        await withAssistantContext(fixture.context,()=>createLLMUsage({userId,provider:'openai',model:'fixture-recorded-model',purpose:'support_reply',service:'AssistantOperationsQA',totalTokens:75,estimatedCostCents:2}));
        await withAssistantContext({...fixture.context,preview:true},()=>createLLMUsage({userId,provider:'openai',model:'fixture-recorded-model',purpose:'support_reply',service:'AssistantOperationsQA',totalTokens:999,estimatedCostCents:20}));
        // Empty retrieval for a greeting is not an unanswered factual question.
        await database.execute(sql`INSERT INTO agent_audit_logs(user_id,conversation_id,channel,outcome,intent,trace)
          VALUES(${userId},${fixture.conversationId},'whatsapp','auto_sent','greeting',${JSON.stringify({executionMode:'customer',knowledgeRetrievalStatus:'insufficient',knowledgeUncertaintyReply:false,resolvedAssistant:fixture.context.provenance})}::jsonb)`);
      });
      const costReport=(await request(appFor()).get(url).query(query).expect(200)).body;
      expect(costReport.usage[0]).toMatchObject({source:'model_usage',calls:1,totalTokens:75,cost:0.02,currency:'USD',costRecordedCalls:1});
      expect(costReport.knowledgeGaps).toHaveLength(1);
      await owner(async()=>{
        for(const status of ['conflict_detected','stale_only']) await database.execute(sql`INSERT INTO agent_audit_logs(user_id,conversation_id,channel,outcome,intent,trace)
          VALUES(${userId},${fixture.conversationId},'whatsapp','human_handoff','hours',${JSON.stringify({executionMode:'customer',knowledgeRetrievalStatus:status,redactedQuestion:'Contact customer@example.invalid about verified hours',resolvedAssistant:fixture.context.provenance})}::jsonb)`);
      });
      const gapsReport=(await request(appFor()).get(url).query(query).expect(200)).body;
      expect(gapsReport.knowledgeGaps).toHaveLength(3);
      expect(gapsReport.knowledgeGaps.some((gap:any)=>gap.reason.includes('conflicting'))).toBe(true);
      expect(gapsReport.knowledgeGaps.some((gap:any)=>gap.reason.includes('stale'))).toBe(true);
      for(const gap of gapsReport.knowledgeGaps.filter((item:any)=>item.intent==='hours')) {
        expect(gap.dailyCounts).toEqual([{day:expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),count:1}]);
        expect(gap.questionSamples[0]).not.toContain('customer@example.invalid');
      }
      const staffReport=(await request(appFor(otherUserId)).get(url).query(query).expect(200)).body;
      expect(staffReport.usage[0]).toMatchObject({cost:null,currency:null,costRecordedCalls:0});
      await owner(()=>cancelAssistantFollowUps(fixture.conversationId,'qa_complete'));
      await request(appFor()).get(url).query({days:91}).expect(400);
      await request(appFor(userId,secondProfileId)).get(url).query(query).expect(404);
    });

    it(
      "can serve the isolated local browser fixture without starting cron or provider workers",
      async () => {
        const port = Number(process.env.ASSISTANT_BROWSER_QA_PORT || 0);
        if (!port) return;
        const app = appFor();
        let finish: () => void = () => {};
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const fixtureUser = {
          id: userId,
          email: "assistant-qa@example.invalid",
          name: "Assistant QA",
          isApproved: true,
          isSetupComplete: true,
          hasBusinessProfile: true,
          hasBrandToolkit: true,
          workspaceRole: "owner",
          businessProfileId: profileId,
        };
        app.get("/api/auth/me", (_req, res) => res.json({ user: fixtureUser }));
        app.get("/api/settings/business-profiles", (_req, res) =>
          res.json([
            {
              id: profileId,
              userId,
              name: "Assistant QA",
              companyName: "Synthetic Company",
              isDefault: true,
              isApproved: true,
              version: 1,
            },
          ]),
        );
        app.get("/api/settings/business-profile", (_req, res) =>
          res.json({
            id: profileId,
            userId,
            name: "Assistant QA",
            companyName: "Synthetic Company",
            isDefault: true,
            isApproved: true,
          }),
        );
        app.get("/api/platform/access", (_req, res) =>
          res.json({
            maintenance: { enabled: false, message: "" },
            modules: [
              "settings",
              "support_ai",
              "dashboard",
              "outreach",
              "knowledge",
              "support",
            ].map((key) => ({ key, enabled: true })),
          }),
        );
        app.get("/api/:section/:resource", (_req, res) =>
          res.json({
            data: [],
            items: [],
            count: 0,
            balance: 0,
            success: true,
          }),
        );
        app.get("/__qa", (_req, res) =>
          res.json({
            userId,
            profileId,
            mainId,
            mode: "Offline providers; real isolated PostgreSQL assistant API",
          }),
        );
        app.post("/__qa/stop", (_req, res) => {
          res.json({ stopped: true });
          finish();
        });
        const server: Server = await new Promise((resolve) => {
          const listener = app.listen(port, "127.0.0.1", () =>
            resolve(listener),
          );
        });
        process.stdout.write(
          `Assistant browser QA API ready at http://127.0.0.1:${port}\n`,
        );
        await done;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
      15 * 60 * 1000,
    );
  },
);
