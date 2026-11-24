import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it as test,
  jest,
} from "@jest/globals";
import { Client, Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import crypto from "crypto";
import type { Request, Response } from "express";
import { withBusinessScope } from '../tenancy/businessContext.js';
// Service invocations have the same business precondition as production. These
// cloned-schema tests still do not stand in for the separate runtime-RLS suite.
const it = (name: string, work: () => void | Promise<void>, timeout?: number) =>
  test(name, () => withBusinessScope({ userId: 1, businessProfileId: 1 }, work), timeout);
const connectionString = process.env.PROPOSAL_QA_DATABASE_URL;
const describeDatabase = connectionString ? describe : describe.skip;
let client: Client;
let pool: Pool;
let database: NodePgDatabase;
const schema = `proposal_qa_${Date.now()}_${process.pid}`;
const mockEmail = jest
  .fn<
    (
      ...args: unknown[]
    ) => Promise<{ success: boolean; messageId?: string; error?: string }>
  >()
  .mockResolvedValue({ success: true, messageId: "provider-1" });
const mockRefund = jest
  .fn()
  .mockImplementation(async () => ({ success: true }));
const mockCompletion = jest.fn().mockImplementation(async () => ({
  success: true,
  content: JSON.stringify({
    coverNote: "Proposal",
    aiSummary: "Summary",
    lineItems: [
      { name: "Consulting", quantity: 1, unitPrice: 999, unit: "hour" },
    ],
    termsAndConditions: "Review terms",
  }),
}));
const getEffectiveModuleAccess = jest.fn(async () => [
  { key: "proposals", enabled: true },
]);
jest.unstable_mockModule("../models/db.js", () => ({
  db: new Proxy(
    {},
    {
      get(_target, key) {
        const value = database[key as keyof typeof database];
        return typeof value === "function" ? value.bind(database) : value;
      },
    },
  ),
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule("../services/emailService", () => ({
  emailService: { sendEmailWithUserCredentials: mockEmail },
}));
jest.unstable_mockModule("../services/agents/LLMProviderFactory", () => ({
  LLMProviderFactory: {
    createProviderForUser: async () => ({
      defaultModel: "test",
      createChatCompletion: mockCompletion,
    }),
  },
}));
jest.unstable_mockModule("../services/knowledge/KnowledgeGateway.js", () => ({
  knowledgeGateway: { retrieveText: async () => "" },
}));
jest.unstable_mockModule("../utils/emailTemplates", () => ({
  getBrandInfo: async () => ({ companyName: "Test", primaryColor: "#000000" }),
  renderBrandedEmail: () => "<p>Review</p>",
}));
jest.unstable_mockModule("../services/NotificationService", () => ({
  NotificationService: { notify: async () => {} },
}));
jest.unstable_mockModule("../services/CreditService.js", () => ({
  creditService: {
    reserveOutreachCredit: async () => ({ success: true, transactionId: 1 }),
    refundDeduction: mockRefund,
  },
}));
jest.unstable_mockModule("../models/platformAccess/functions.js", () => ({
  getEffectiveModuleAccess,
}));
jest.unstable_mockModule("../services/CRMService.js", () => ({
  crmService: {
    updatePipelineStatus: async (
      userId: number,
      contactId: number,
      status: string,
    ) => {
      await client.query(
        "UPDATE crm_contacts SET pipeline_status=$1 WHERE id=$2 AND user_id=$3",
        [status, contactId, userId],
      );
    },
  },
}));
jest.unstable_mockModule("../services/SupportService.js", () => ({
  supportService: {
    createTicket: async (
      userId: number,
      data: {
        contactId?: number;
        leadId?: number;
        outreachConversationId?: number;
        teamId?: number;
        assignedMemberId?: number;
        subject: string;
        description: string;
        handoffKey: string;
        slaDeadline?: Date;
      },
      context: { database?: NodePgDatabase } = {},
    ) => {
      const executor = context.database || database;
      return (await executor.execute(sql`INSERT INTO support_tickets
        (user_id,ticket_number,contact_id,lead_id,outreach_conversation_id,team_id,assigned_member_id,subject,description,category,handoff_key,sla_deadline)
        VALUES (${userId},${crypto.randomUUID()},${data.contactId || null},${data.leadId || null},${data.outreachConversationId || null},${data.teamId || null},${data.assignedMemberId || null},${data.subject},${data.description},'ai_handoff',${data.handoffKey},${data.slaDeadline || null})
        RETURNING id,team_id AS "teamId",assigned_member_id AS "assignedMemberId"`)).rows[0];
    },
  },
}));
const { proposalService } = await import("../services/ProposalService.js");
const { resolveWidgetProposalIdentity } = await import('../services/agents/orchestration/SupportWidgetProposalIdentity.js');
const { proposalSubAgent } = await import('../services/agents/subagents/ProposalSubAgent.js');
import type { SubAgentContext } from '../services/agents/subagents/SubAgentBase.js';
const {
  addProposalCatalogItemsTool,
  createProposalDraftTool,
  listProposalCatalogTool,
} = await import("../mastra/tools/proposalTools.js");
const { proposalLifecycleService } = await import("../services/ProposalLifecycleService.js");
const { proposalSourceContext, processProposalEvents } =
  await import("../services/ProposalWorkspaceService.js");
const {
  approveProposal,
  reviseProposal,
  recoverProposalDelivery,
  proposalPerformance,
} = await import("../controllers/proposalWorkspaceController.js");
const { configureProposalFollowups, previewProposalFollowups } =
  await import("../controllers/proposalLifecycleController.js");
const { saveAdminProposalTemplate } =
  await import("../controllers/adminProposalTemplateController.js");
// @ts-expect-error JavaScript migration intentionally shares the seed with production.
const { up } = await import("../migrations/248_proposal_workspace.js");
type ControllerHandler = (request: Request, response: Response) => unknown | Promise<unknown>;
async function call<T = unknown>(
  handler: ControllerHandler,
  userId: number,
  id: number,
  body: Record<string, unknown> = {},
  query: Record<string, unknown> = {},
) {
  const result: { status: number; body: T } = { status: 200, body: null as T };
  const response = {
    status(code: number) {
      result.status = code;
      return response;
    },
    json(value: unknown) {
      result.body = value as T;
      return response;
    },
  };
  await withBusinessScope({ userId, businessProfileId: userId }, () => handler(
    { user: { id: userId }, params: { id: String(id) }, body, query } as unknown as Request,
    response as unknown as Response,
  ));
  return result;
}

describeDatabase("proposal workspace on isolated PostgreSQL schema", () => {
  beforeAll(async () => {
    if (
      !connectionString ||
      !["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(connectionString).hostname,
      )
    )
      throw new Error("Proposal QA requires local PostgreSQL");
    // Fixture arrangement/inspection is administrative; service SQL uses the
    // separate fixture pool with explicit business settings below. The actual
    // ownership trigger remains enabled; these clones do not install full RLS.
    client = new Client({ connectionString, options: '-c app.business_system=on' });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema},public,pg_catalog`);
    for (const table of [
      "users",
      "crm_contacts",
      "leads",
      "outreach_conversations",
      "outreach_messages",
      "outreach_campaigns",
      "chat_threads",
      "chat_messages",
      "company_settings",
      "proposal_templates",
      "proposals",
      "proposal_line_items",
      "proposal_comments",
      "proposal_reminders",
      "proposal_catalog", "proposal_events", "proposal_versions", "proposal_template_audit", "proposal_review_policies", "proposal_approvals",
      "support_tickets",
      "crm_activities",
      "support_teams", "team_members", "support_chat_sessions", "handoff_queue",
    ]) {
      await client.query(
        `CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`,
      );
      if (table !== "proposal_review_policies") await client.query(
        `CREATE SEQUENCE ${table}_qa_seq; ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${table}_qa_seq')`,
      );
    }
    await up(client);
    await up(client);
    await client.query(
      "INSERT INTO users(id,email,password,name) VALUES (1,'seller@example.test','unused','Seller'),(2,'other@example.test','unused','Other')",
    );
    await client.query("INSERT INTO company_settings(id,user_id,company_name,billing_organization_id) VALUES (1,1,'Synthetic Business',1),(2,2,'Other Business',2)");
    // LIKE does not copy triggers. Retain the actual production ownership guard
    // for proposal writes so branding opt-out cannot masquerade as tenant loss.
    const ownership = (await client.query("SELECT row_to_json(t) AS spec FROM public.business_scope_tables t WHERE table_name='proposals'")).rows[0].spec;
    await client.query(`CREATE TRIGGER proposal_qa_business_scope BEFORE INSERT OR UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION public.enforce_business_ownership('${JSON.stringify(ownership).replaceAll("'", "''")}')`);
    await client.query(
      "INSERT INTO leads(id,user_id,uuid,source,status) VALUES (1,1,$1,'manual','new'),(2,2,$2,'manual','new')",
      [crypto.randomUUID(), crypto.randomUUID()],
    );
    await client.query(
      "INSERT INTO crm_contacts(id,user_id,lead_id,first_name,email) VALUES (1,1,1,'Client','client@example.test'),(2,2,2,'Other','other@example.test')",
    );
    pool = new Pool({ connectionString, max: 6, options: `-c search_path=${schema},public,pg_catalog -c app.business_profile_id=1 -c app.current_user_id=1` });
    database = drizzle(pool);
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (client) {
      await client.query("SET search_path TO pg_catalog");
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
  });
  beforeEach(() => {
    mockEmail.mockClear();
    mockEmail.mockResolvedValue({ success: true, messageId: "provider-1" });
  });
  it('binds webchat proposal drafts to one session, persists an idempotent draft, and never sets a send destination', async () => {
    process.env.SUPPORT_PII_ENCRYPTION_KEY ||= 'isolated-widget-qa-pii-key-not-for-production';
    await client.query("SELECT setval('leads_qa_seq',1000),setval('outreach_conversations_qa_seq',1000)");
    const team = (await client.query("INSERT INTO support_teams(user_id,name) VALUES(1,'QA') RETURNING id")).rows[0].id;
    const member = (await client.query("INSERT INTO team_members(team_id,user_id,name,email) VALUES($1,1,'QA','qa@example.invalid') RETURNING id",[team])).rows[0].id;
    const session = (await client.query("INSERT INTO support_chat_sessions(member_id,public_token,session_expires_at) VALUES($1,'qa-session',NOW()+INTERVAL '1 hour') RETURNING id",[member])).rows[0].id;
    const input = { userId:1,sessionId:session,token:'qa-session',create:true };
    expect(await resolveWidgetProposalIdentity({ ...input, create:false })).toBeNull();
    const before = (await client.query('SELECT COUNT(*) FROM leads')).rows[0].count;
    for (const override of [{token:'bad'},{userId:2},{sessionId:99999}]) {
      const owner = override.userId || input.userId;
      expect(await withBusinessScope({ userId: owner, businessProfileId: owner }, () => resolveWidgetProposalIdentity({ ...input,...override }))).toBeNull();
    }
    await expect(resolveWidgetProposalIdentity({ ...input, userId: 2 })).rejects.toThrow('Knowledge account does not match the selected business');
    expect((await client.query('SELECT COUNT(*) FROM leads')).rows[0].count).toBe(before);
    const identities = await Promise.all([resolveWidgetProposalIdentity(input),resolveWidgetProposalIdentity(input)]);
    expect(identities[0]).toEqual(identities[1]);
    const identity = identities[0]!;
    const secondSession = (await client.query("INSERT INTO support_chat_sessions(member_id,public_token,session_expires_at,metadata) VALUES($1,'qa-other-session',NOW()+INTERVAL '1 hour',$2) RETURNING id",
      [member,JSON.stringify({widgetProposalIdentity:identity})])).rows[0].id;
    expect(await resolveWidgetProposalIdentity({ ...input,sessionId:secondSession,token:'qa-other-session' })).toBeNull();
    const lead = (await client.query('SELECT email,phone,source FROM leads WHERE id=$1',[identity.leadId])).rows[0];
    expect(lead).toMatchObject({email:null,phone:null,source:'support_widget_proposal'});
    const ctx = { userId:1,conversationId:-session,channel:'web',widgetSession:{id:session,token:'qa-session'},
      inboundText:'Create a day outing proposal for 35 people. Do not book or send it.',
      nlu:{intent:'proposal_request'},lead:{id:0,name:'Guest'},slots:{},memory:{},intel:{},history:[],
      agentConfig:{ agentType:'general_service',toolsEnabled:['create_conversation_proposal_draft'] },executionMode:'customer',
      rawMessageId:'widget-proposal-qa-1' } as unknown as SubAgentContext;
    const args = { title:'Day outing for 35', context:ctx.inboundText, requirements:{deliverables:'Day outing for 35 people'} };
    const result = await proposalSubAgent.execute('create_conversation_proposal_draft',args,ctx);
    expect(result.toolResults?.[0].result).toMatchObject({success:true,seller_review_required:true,delivered:false});
    const second = await proposalSubAgent.execute('create_conversation_proposal_draft',args,ctx);
    expect(second.toolResults?.[0].result).toEqual(result.toolResults?.[0].result);
    const proposals = (await client.query('SELECT * FROM proposals WHERE outreach_conversation_id=$1',[identity.conversationId])).rows;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ status:'draft',lead_id:identity.leadId,recipient_email:null,sent_at:null,
      metadata:expect.objectContaining({approvalRequired:true,supportRequest:expect.objectContaining({widgetSessionId:session,requiresVerifiedDeliveryContact:true})}) });
    expect(mockEmail).not.toHaveBeenCalled();
    for (const mode of ['human_owned','approval_pending','opted_out']) {
      await client.query('UPDATE support_chat_sessions SET automation_mode=$1 WHERE id=$2',[mode,session]);
      expect(await resolveWidgetProposalIdentity(input)).toBeNull();
    }
    await client.query("UPDATE support_chat_sessions SET automation_mode='ai_active',opted_out_at=NOW() WHERE id=$1",[session]);
    expect(await resolveWidgetProposalIdentity(input)).toBeNull();
    await client.query('UPDATE support_chat_sessions SET opted_out_at=NULL WHERE id=$1',[session]);
    await client.query("INSERT INTO handoff_queue(user_id,conversation_id,channel) VALUES(1,$1,'web')",[-session]);
    expect(await resolveWidgetProposalIdentity(input)).toBeNull();
    await client.query("UPDATE handoff_queue SET status='resolved' WHERE conversation_id=$1",[-session]);
    await client.query("UPDATE support_chat_sessions SET automation_mode='ai_active',session_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[session]);
    expect(await resolveWidgetProposalIdentity(input)).toBeNull();
  });
  it("seeds exactly ten published templates idempotently and prevents tenant editing", async () => {
    const templates = await proposalService.getTemplates(1);
    expect(templates).toHaveLength(10);
    expect(
      await proposalService.updateTemplate(1, templates[0].id, {
        name: "Unauthorized",
      }),
    ).toBeNull();
    expect(await proposalService.deleteTemplate(1, templates[0].id)).toBe(
      false,
    );
  });
  it("caps published admin templates at ten, and permits drafts", async () => {
    const template = {
      name: "Extra",
      published: true,
      templateContent: {
        sections: [{ title: "Scope", body: "Approved scope", kind: "content" }],
        placeholders: [],
        warnings: [],
      },
    };
    const response: { code: number; body?: unknown; status: (code: number) => unknown; json: (value: unknown) => unknown } = {
      code: 200,
      status(c: number) {
        response.code = c;
        return response;
      },
      json(value: unknown) {
        response.body = value;
        return response;
      },
    };
    await saveAdminProposalTemplate(
      { user: { id: 99, role: "super_admin" }, params: {}, body: template } as unknown as Request,
      response as unknown as Response,
    );
    expect(response.code).toBe(409);
    response.code = 200;
    await saveAdminProposalTemplate(
      {
        user: { id: 99, role: "super_admin" },
        params: {},
        body: { ...template, published: false },
      } as unknown as Request,
      response as unknown as Response,
    );
    expect(response.code).toBe(201);
  });
  it("snapshots selected templates without later changes affecting drafts", async () => {
    const t = (await proposalService.getTemplates(1))[0];
    const p = await proposalService.createProposal(1, {
      title: "Template test",
      templateId: t.id,
      templateValues: { project_goal: "Increase qualified demos" },
    });
    expect(p.metadata.generatedSections.length).toBeGreaterThan(1);
    await client.query(
      "UPDATE proposal_templates SET name='Updated admin name',version=version+1 WHERE id=$1",
      [t.id],
    );
    const saved = await proposalService.getProposalById(1, p.id);
    expect(saved.metadata.templateSnapshot.name).toBe(t.name);
    const revision = await proposalLifecycleService.createRevision(1, p.id);
    expect(revision.metadata.templateSnapshot).toEqual(saved.metadata.templateSnapshot);
    expect(revision.metadata.templateValues).toEqual({ project_goal: "Increase qualified demos" });
  });
  it("rejects foreign references and mismatched source identities", async () => {
    await expect(
      proposalService.createProposal(1, { title: "Invalid", contactId: 2 }),
    ).rejects.toThrow("Contact not found");
    await client.query(
      "INSERT INTO outreach_conversations(id,user_id,lead_id,crm_contact_id,channel,lead_name,lead_email) VALUES (10,1,1,1,'email','Client','client@example.test')",
    );
    await expect(
      proposalSourceContext(1, { outreachConversationId: 10, leadId: 2 }),
    ).rejects.toThrow("do not match");
    await expect(
      proposalSourceContext(2, { outreachConversationId: 10 }),
    ).rejects.toThrow("not found");
  });
  it("uses only redacted outreach history and inherits linked customer identity", async () => {
    await client.query(
      "INSERT INTO outreach_messages(conversation_id,user_id,direction,content,redacted_content) VALUES (10,1,'inbound','SECRET ORIGINAL','We need implementation')",
    );
    const context = await proposalSourceContext(1, {
      outreachConversationId: 10,
    });
    expect(context.refs.contactId).toBe(1);
    expect(context.text).toContain("implementation");
    expect(context.text).not.toContain("SECRET");
  });
  it("constrains AI prices to the approved catalog", async () => {
    const p = await proposalService.generateProposalFromKBAndProfile(1, {
      title: "AI test",
      currency: "USD",
    });
    expect(Number(p.total)).toBe(0);
    const catalogId = (
      await client.query(
        "INSERT INTO proposal_catalog(user_id,name,currency,unit_price) VALUES (1,'Consulting','USD',150) RETURNING id",
      )
    ).rows[0].id;
    mockCompletion.mockImplementationOnce(async () => ({
      success: true,
      content: JSON.stringify({
        coverNote: "Proposal",
        aiSummary: "Summary",
        lineItems: [
          {
            catalogId,
            name: "Consulting",
            quantity: 1,
            unitPrice: 999,
            unit: "hour",
          },
        ],
        termsAndConditions: "Review terms",
      }),
    }));
    const priced = await proposalService.generateProposalFromKBAndProfile(1, {
      title: "Catalog test",
      currency: "USD",
    });
    expect(Number(priced.total)).toBe(150);
  });
  it("looks up catalog services by stable ID within tenant, currency, and active state", async () => {
    const ownActive = (
      await client.query(
        "INSERT INTO proposal_catalog(user_id,name,currency,unit_price,unit,active) VALUES (1,'Campaign QA service','USD',425,'campaign',true) RETURNING id",
      )
    ).rows[0].id;
    const ownInactive = (
      await client.query(
        "INSERT INTO proposal_catalog(user_id,name,currency,unit_price,active) VALUES (1,'Retired QA service','USD',500,false) RETURNING id",
      )
    ).rows[0].id;
    const otherTenant = (
      await client.query(
        "INSERT INTO proposal_catalog(user_id,name,currency,unit_price,active) VALUES (2,'Other tenant QA service','USD',600,true) RETURNING id",
      )
    ).rows[0].id;
    const otherCurrency = (
      await client.query(
        "INSERT INTO proposal_catalog(user_id,name,currency,unit_price,active) VALUES (1,'Euro QA service','EUR',700,true) RETURNING id",
      )
    ).rows[0].id;

    const catalog = await proposalService.getCatalogItems(1, {
      ids: [ownActive, ownInactive, otherTenant, otherCurrency],
      currency: "USD",
      activeOnly: true,
      limit: 4,
    });
    expect(catalog).toEqual([
      expect.objectContaining({ id: ownActive, name: "Campaign QA service", currency: "USD", unitPrice: 425, unit: "campaign", active: true }),
    ]);

    const created = await proposalService.createProposal(1, {
      title: "Stable catalog snapshot",
      currency: "USD",
      lineItems: [{ catalogId: ownActive, name: "Invented service", quantity: 1, unitPrice: 1, unit: "invented" }],
    });
    const saved = await proposalService.getProposalById(1, created.id);
    expect(saved?.lineItems).toEqual([
      expect.objectContaining({ catalogId: ownActive, name: "Campaign QA service", unitPrice: "425.00", unit: "campaign" }),
    ]);
    await client.query("UPDATE proposal_catalog SET name='Renamed later',unit_price=999 WHERE id=$1", [ownActive]);
    const edited = await proposalService.updateProposal(1, created.id, {
      expectedRevision: saved!.revision,
      lineItems: saved!.lineItems,
    });
    expect(edited?.lineItems).toEqual([
      expect.objectContaining({ catalogId: ownActive, name: "Campaign QA service", unitPrice: "425.00", unit: "campaign" }),
    ]);
  });
  it("creates a selected-lead campaign draft and adds an approved service through the real tool-service boundary", async () => {
    const threadId = (
      await client.query(
        "INSERT INTO chat_threads(user_id,title,selected_agent) VALUES (1,'Proposal campaign QA','outreach') RETURNING id",
      )
    ).rows[0].id;
    const catalogId = (
      await client.query(
        "INSERT INTO proposal_catalog(user_id,name,description,currency,unit_price,unit,active) VALUES (1,'Campaign implementation QA','Approved implementation scope','USD',875,'engagement',true) RETURNING id",
      )
    ).rows[0].id;
    const context = {
      userId: 1,
      threadId,
      selectedLeadIds: [1],
      runContext: { userId: 1, threadId, runId: "campaign-qa", turnId: "campaign-qa-create" },
    };
    type CampaignToolResult = { success?: boolean; error?: unknown; output?: unknown };
    const callTool = async <TInput>(
      tool: { execute?: (inputData: TInput, executionContext: never) => Promise<unknown> },
      input: TInput,
    ): Promise<CampaignToolResult> => {
      if (!tool.execute) throw new Error("Campaign tool has no executor");
      return await tool.execute(input, { mastra: { __toolContext: context } } as never) as CampaignToolResult;
    };

    const created = await callTool(createProposalDraftTool, {
      title: "Campaign implementation offer",
      leadId: 1,
      currency: "USD",
      generateWithAI: false,
    });
    expect(created).toMatchObject({ success: true, output: { status: "drafts_created", createdCount: 1 } });
    const proposalId = (created.output as { proposals: Array<{ id: number }> }).proposals[0].id;
    const proposal = await proposalService.getProposalById(1, proposalId);
    expect(proposal).toMatchObject({ leadId: 1, chatThreadId: threadId, status: "draft" });

    const listed = await callTool(listProposalCatalogTool, { currency: "USD", search: "Campaign implementation QA" });
    expect(listed).toMatchObject({ success: true, output: { items: [
      { id: catalogId, name: "Campaign implementation QA", unitPrice: 875, unit: "engagement" },
    ] } });

    const added = await callTool(addProposalCatalogItemsTool, {
      proposalId,
      expectedRevision: proposal!.revision,
      catalogItemIds: [catalogId],
    });
    expect(added).toMatchObject({ success: true, output: {
      status: "catalog_items_added",
      preservedLineItemCount: 0,
      addedCatalogItems: [{ id: catalogId, name: "Campaign implementation QA", currency: "USD", unitPrice: 875, unit: "engagement" }],
      proposal: { id: proposalId, leadId: 1, revision: proposal!.revision + 1, total: 875 },
    } });
    expect(await proposalService.getProposalById(1, proposalId)).toMatchObject({ lineItems: [
      { catalogId, name: "Campaign implementation QA", description: "Approved implementation scope", unitPrice: "875.00", unit: "engagement" },
    ] });

    const duplicate = await callTool(addProposalCatalogItemsTool, {
      proposalId,
      expectedRevision: proposal!.revision + 1,
      catalogItemIds: [catalogId],
    });
    expect(duplicate).toMatchObject({ success: false, error: expect.stringContaining("already included") });
  });
  it("respects the business-profile template setting", async () => {
    await client.query(
      "UPDATE company_settings SET company_name='Private Company Identity' WHERE id=1 AND user_id=1",
    );
    const template = await proposalService.createTemplate(1, {
      name: "No profile",
      templateType: "document",
      includeBusinessProfile: false,
      templateContent: {
        sections: [
          { title: "Scope", kind: "content", body: "Confirmed scope" },
        ],
        placeholders: [],
        warnings: [],
      },
    });
    mockCompletion.mockImplementationOnce(async () => ({
      success: true,
      content: JSON.stringify({
        coverNote: "Scope",
        aiSummary: "Summary",
        sections: [{ title: "Scope", kind: "content", body: "Implementation" }],
      }),
    }));
    const p = await proposalService.generateProposalFromKBAndProfile(1, {
      title: "No profile test",
      templateId: template.id,
    });
    const prompt = JSON.stringify(mockCompletion.mock.calls.at(-1));
    expect(prompt).not.toContain("Private Company Identity");
    // This field is now immutable tenant identity, not a branding inclusion flag.
    expect(p.businessProfileId).toBe(1);
    expect(p.metadata.sources).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'business' })]));
    // Positive control: the selected profile is available and would be included
    // without the template's opt-out. The negative prompt assertion is not vacuous.
    await proposalService.suggestProposalDraft(1, { title: "Profile inclusion control", businessProfileId: 1 });
    expect(JSON.stringify(mockCompletion.mock.calls.at(-1))).toContain("Private Company Identity");
  });
  it("rejects stale seller reviews and stale saved drafts", async () => {
    const p = await proposalService.createProposal(1, {
      title: "Stale draft",
      recipientEmail: "client@example.test",
    });
    await proposalService.updateProposal(1, p.id, { title: "New scope" });
    await expect(
      proposalService.updateProposal(1, p.id, {
        expectedRevision: p.revision,
        title: "Old scope",
      }),
    ).rejects.toThrow("changed since");
    expect(
      (await call(approveProposal, 1, p.id, { expectedRevision: p.revision }))
        .status,
    ).toBe(409);
  });
  it("supports tenant-scoped campaign, template and owner analytics", async () => {
    for (const group of ["template", "campaign", "owner"]) {
      const response = await call<{ data: unknown[] }>(proposalPerformance, 1, 1, {}, { group });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    }
  });
  it("returns owner and activity columns with the requested daily-work filters", async () => {
    const title = `Daily work ${crypto.randomUUID()}`;
    const proposal = await proposalService.createProposal(1, {
      title,
      contactId: 1,
      approvalRequired: true,
    });
    await client.query(
      "UPDATE crm_contacts SET assigned_to=1,last_activity_at=NOW()-INTERVAL '1 hour' WHERE id=1 AND user_id=1",
    );
    await client.query(
      "UPDATE proposals SET updated_at=NOW()-INTERVAL '2 days' WHERE id=$1 AND user_id=1",
      [proposal.id],
    );

    const listed = await proposalService.getProposals(1, { search: title });
    expect(listed.proposals).toHaveLength(1);
    expect(listed.proposals[0]).toEqual(expect.objectContaining({
      id: proposal.id,
      owner: { id: 1, name: "Seller", email: "seller@example.test" },
    }));
    expect(listed.proposals[0].lastActivityAt.getTime()).toBeGreaterThan(
      Date.now() - 2 * 60 * 60 * 1000,
    );

    const needsApproval = await proposalService.getProposals(1, {
      search: title,
      attention: "needs_approval",
    });
    expect(needsApproval.proposals.map((item) => item.id)).toEqual([proposal.id]);

    await client.query(
      "UPDATE proposals SET status='sent',sent_at=NOW(),valid_until=NOW()+INTERVAL '3 days' WHERE id=$1 AND user_id=1",
      [proposal.id],
    );
    const awaitingResponse = await proposalService.getProposals(1, {
      search: title,
      attention: "awaiting_response",
    });
    const expiringSoon = await proposalService.getProposals(1, {
      search: title,
      attention: "expiring_soon",
    });
    expect(awaitingResponse.proposals.map((item) => item.id)).toEqual([proposal.id]);
    expect(expiringSoon.proposals.map((item) => item.id)).toEqual([proposal.id]);
  });
  it("reconciles uncertain delivery credits without sending again", async () => {
    const p = await proposalService.createProposal(1, {
      title: "Provider timeout",
      recipientEmail: "client@example.test",
    });
    expect((await call(approveProposal, 1, p.id)).status).toBe(200);
    mockEmail.mockRejectedValueOnce(new Error("Provider timeout"));
    await expect(proposalService.sendProposal(1, p.id)).rejects.toThrow(
      "Provider timeout",
    );
    expect((await proposalService.getProposalById(1, p.id)).status).toBe(
      "delivery_unknown",
    );
    await call(recoverProposalDelivery, 1, p.id, {
      outcome: "not_delivered",
      note: "Provider confirmed no delivery",
    });
    await processProposalEvents();
    expect(mockRefund).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, transactionId: 1 }),
    );
    expect(mockEmail).toHaveBeenCalledTimes(1);
  });
  it("enforces review and invalidates approval after an edit", async () => {
    const p = await proposalService.createProposal(1, {
      title: "Review",
      recipientEmail: "client@example.test",
      approvalRequired: true,
    });
    await expect(proposalService.sendProposal(1, p.id)).rejects.toThrow(
      "Review and approve",
    );
    expect((await call(approveProposal, 1, p.id)).status).toBe(200);
    await proposalService.updateProposal(1, p.id, {
      coverNote: "Changed scope",
    });
    await expect(proposalService.sendProposal(1, p.id)).rejects.toThrow(
      "Review and approve",
    );
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM proposal_versions WHERE proposal_id=$1",
          [p.id],
        )
      ).rows[0].n,
    ).toBe(1);
    await call(approveProposal, 1, p.id);
    await proposalService.sendProposal(1, p.id);
    expect(mockEmail).toHaveBeenCalledTimes(1);
  });
  it("acceptance syncs CRM, creates one onboarding ticket and cancels reminders", async () => {
    const unrelated = await proposalService.createProposal(1, {
      title: "Unrelated lifecycle event",
      recipientEmail: "client@example.test",
    });
    const p = await proposalService.createProposal(1, {
      title: "Lifecycle",
      contactId: 1,
      outreachConversationId: 10,
      recipientEmail: "client@example.test",
      signatureRequired: true,
      autoOnboard: true,
      onboardingPlan: {
        dueDate: "2099-12-31",
        checklist: [
          {
            id: "kickoff",
            title: "Run kickoff",
            deliverable: "Signed project brief",
            dueDate: "2099-12-20",
          },
        ],
      },
    });
    expect((await call(approveProposal, 1, p.id)).status).toBe(200);
    const result = await proposalService.sendProposal(1, p.id);
    const token = result!.publicUrl.split("/").pop()!;
    await client.query(
      "INSERT INTO proposal_reminders(user_id,proposal_id,reminder_due_at,reminder_type) VALUES (1,$1,NOW()+INTERVAL '3 days','followup')",
      [p.id],
    );
    await proposalService.respondToPublicProposal(token, "accept", {
      name: "Client",
    });
    await proposalService.respondToPublicProposal(token, "accept", {
      name: "Client",
    });
    await processProposalEvents({ userId: 1, proposalId: p.id });
    await processProposalEvents({ userId: 1, proposalId: p.id });
    expect((await client.query(
      "SELECT processed_at FROM proposal_events WHERE proposal_id=$1 ORDER BY id LIMIT 1",
      [unrelated.id],
    )).rows[0].processed_at).toBeNull();
    await client.query("UPDATE proposal_events SET processed_at=NOW() WHERE proposal_id=$1", [unrelated.id]);
    const current = await proposalService.getProposalById(1, p.id);
    expect(current.metadata.onboardingTicketId).toBeTruthy();
    expect(current.metadata.onboarding).toMatchObject({ status: "created" });
    expect(current.signedByName).toBe("Client");
    expect(current.signedAt).toBeTruthy();
    expect(
      (
        await client.query(
          "SELECT count(*)::int n FROM support_tickets WHERE handoff_key=$1",
          [`proposal-accepted:${p.id}`],
        )
      ).rows[0].n,
    ).toBe(1);
    const onboarding = (
      await client.query(
        "SELECT description,metadata,sla_deadline FROM support_tickets WHERE handoff_key=$1",
        [`proposal-accepted:${p.id}`],
      )
    ).rows[0];
    expect(onboarding.description).toContain("Run kickoff — Signed project brief");
    expect(onboarding.metadata.proposalOnboarding.checklist).toEqual([
      expect.objectContaining({
        id: "kickoff",
        title: "Run kickoff",
        status: "pending",
      }),
    ]);
    expect(onboarding.sla_deadline.toISOString()).toBe(
      "2099-12-31T23:59:59.999Z",
    );
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM proposal_events WHERE proposal_id=$1 AND kind='accepted'",
          [p.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await client.query(
          "SELECT pipeline_status FROM crm_contacts WHERE id=1",
        )
      ).rows[0].pipeline_status,
    ).toBe("won");
    expect(
      (
        await client.query(
          "SELECT status FROM proposal_reminders WHERE proposal_id=$1",
          [p.id],
        )
      ).rows[0].status,
    ).toBe("cancelled");
  });
  it("expires overdue proposals without needing a customer visit", async () => {
    const p = await proposalService.createProposal(1, {
      title: "Expiry",
      recipientEmail: "client@example.test",
    });
    expect((await call(approveProposal, 1, p.id)).status).toBe(200);
    await proposalService.sendProposal(1, p.id);
    await client.query(
      "UPDATE proposals SET valid_until=NOW()-INTERVAL '1 day' WHERE id=$1",
      [p.id],
    );
    const analytics = await proposalService.getAnalytics(1);
    expect(analytics.expired).toBeGreaterThan(0);
    expect((await proposalService.getProposalById(1, p.id)).status).toBe(
      "expired",
    );
  });
  it("keeps unknown deliveries from being automatically resent", async () => {
    const p = await proposalService.createProposal(1, {
      title: "Unknown",
      recipientEmail: "client@example.test",
    });
    await client.query(
      "UPDATE proposals SET status='sending',updated_at=NOW()-INTERVAL '20 minutes' WHERE id=$1",
      [p.id],
    );
    await processProposalEvents();
    expect((await proposalService.getProposalById(1, p.id)).status).toBe(
      "delivery_unknown",
    );
    await expect(proposalService.sendProposal(1, p.id)).rejects.toThrow();
    expect(mockEmail).not.toHaveBeenCalled();
    expect(
      (
        await call(recoverProposalDelivery, 2, p.id, {
          outcome: "not_delivered",
          note: "Provider confirmed failure",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(recoverProposalDelivery, 1, p.id, {
          outcome: "not_delivered",
          note: "Provider confirmed failure",
        })
      ).status,
    ).toBe(200);
  });
  it("previews and replaces a timezone-aware follow-up schedule before creating a revision", async () => {
    const p = await proposalService.createProposal(1, {
      title: "Follow up",
      recipientEmail: "client@example.test",
    });
    expect((await call(approveProposal, 1, p.id)).status).toBe(200);
    await proposalService.sendProposal(1, p.id);
    const schedule = {
      timezone: "Asia/Kolkata",
      steps: [
        { afterDays: 3, localTime: "10:00", subject: "Proposal follow-up", message: "Do you have any questions?" },
        { afterDays: 7, localTime: "15:30", subject: "Proposal next steps", message: "Would you like to review next steps?" },
      ],
    };
    type FollowupResult = { data: { timezone: string; scheduled: Array<{ reminderDueAt: string; metadata: { timezone: string; localDate: string; localTime: string; subject: string } }> } };
    const preview = await call<FollowupResult>(previewProposalFollowups, 1, p.id, schedule);
    expect(preview.status).toBe(200);
    expect(preview.body.data.timezone).toBe("Asia/Kolkata");
    expect(preview.body.data.scheduled).toHaveLength(2);
    expect(preview.body.data.scheduled[0].metadata).toMatchObject({ timezone: "Asia/Kolkata", localTime: "10:00", subject: "Proposal follow-up" });
    expect((await client.query("SELECT COUNT(*)::int AS count FROM proposal_reminders WHERE proposal_id=$1 AND reminder_type='customer_followup'", [p.id])).rows[0].count).toBe(0);
    const saved = await call<FollowupResult>(configureProposalFollowups, 1, p.id, schedule);
    expect(saved).toMatchObject({ status: 200 });
    expect(saved.body.data.scheduled).toHaveLength(2);
    const replacement = { ...schedule, steps: schedule.steps.map((step, index) => index ? step : { ...step, afterDays: 4 }) };
    expect((await call<FollowupResult>(configureProposalFollowups, 1, p.id, replacement)).status).toBe(200);
    const reminderStates = await client.query("SELECT status,COUNT(*)::int AS count FROM proposal_reminders WHERE proposal_id=$1 AND reminder_type='customer_followup' GROUP BY status ORDER BY status", [p.id]);
    expect(reminderStates.rows).toEqual([{ status: "cancelled", count: 2 }, { status: "pending", count: 2 }]);
    const revision = await call<{ data: { metadata: { revisionOf: number }; status: string } }>(reviseProposal, 1, p.id);
    expect(revision.body.data.metadata.revisionOf).toBe(p.id);
    expect(revision.body.data.status).toBe("draft");
    expect((await proposalService.getProposalById(1, p.id)).status).toBe(
      "sent",
    );
  });
});
