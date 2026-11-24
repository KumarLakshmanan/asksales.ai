import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { requireBusinessOwner } from "../middleware/businessPermissions.js";
import { requireModuleAccess } from "../middleware/platformAccess.js";
import { requireBusinessScope } from "../tenancy/businessContext.js";
import {
  assistantService,
  AssistantManagementError,
} from "../services/assistants/AssistantService.js";
import { assistantCatalog } from "../services/assistants/AssistantCatalogService.js";
import { assistantResourceFilters, assistantResourcePage } from '../services/assistants/AssistantResourcePicker.js';
import { ASSISTANT_CHANNELS } from "../../shared/outreachAssistants.js";
import { channelGateway } from "../services/agents/pipeline/ChannelGateway.js";
import { logger } from "../utils/logger.js";
import { assistantPreviewSession } from "../services/assistants/AssistantPreviewSession.js";
import { assistantOperations } from "../services/assistants/AssistantOperationsService.js";

const router = Router();
router.use(requireModuleAccess("support_ai"));
const handler =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) => {
    void fn(req, res).catch((error) => {
      const capacity=normalizeCapacityError(error);
      if(capacity) return res.status(capacity.status).json(capacity.toJSON());
      if (error instanceof AssistantManagementError)
        return res
          .status(error.status)
          .json({ error: error.message, details: error.details });
      logger.error({ err: error }, "[OutreachAssistants] Request failed");
      return res
        .status(500)
        .json({
          error: "Assistant settings could not be processed. Please try again.",
        });
    });
  };
function version(req: Request): number {
  const value = req.body?.expectedDraftVersion;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new AssistantManagementError(
      "The reviewed draft version is required.",
    );
  return value;
}
const assistantId = (req: Request) => String(req.params.id);
router.get(
  "/",
  handler(async (req, res) => res.json(await assistantService.listPage(req.query))),
);
router.get(
  "/catalog",
  handler(async (_req, res) => res.json(await assistantCatalog())),
);
router.get('/diagnostics', handler(async (req,res) => res.json(await assistantOperations.diagnostics(req.query))));
router.get('/resources/:category', handler(async (req, res) => {
  const filters = assistantResourceFilters(String(req.params.category), req.query);
  res.json(assistantResourcePage(await assistantCatalog(), filters));
}));
router.get('/conversations/:conversationId/activity', handler(async (req,res) => res.json(await assistantOperations.conversation(Number(req.params.conversationId),req.query))));
router.get('/:id/revisions', handler(async (req,res) => res.json(await assistantOperations.revisions(assistantId(req),req.query))));
router.get('/:id/scenarios', handler(async (req,res) => res.json(await assistantOperations.scenarios(assistantId(req)))));
router.post('/:id/scenarios', requireBusinessOwner, handler(async (req,res) => res.status(201).json(await assistantOperations.saveScenario(assistantId(req),req.body))));
router.delete('/:id/scenarios/:scenarioId', requireBusinessOwner, handler(async (req,res) => {await assistantOperations.deleteScenario(assistantId(req),String(req.params.scenarioId));return res.status(204).send();}));
router.post('/:id/knowledge-gaps/review', requireBusinessOwner, handler(async (req,res) => res.json(await assistantOperations.reviewGap(assistantId(req),req.body))));
router.post(
  "/migrate",
  requireBusinessOwner,
  handler(async (_req, res) =>
    res.json({ assistants: await assistantService.migrateLegacy() }),
  ),
);
router.post(
  "/",
  requireBusinessOwner,
  handler(async (req, res) =>
    res.status(201).json(await assistantService.create(req.body?.draft)),
  ),
);
router.get(
  "/:id",
  handler(async (req, res) =>
    res.json(await assistantService.get(assistantId(req))),
  ),
);
router.put(
  "/:id",
  requireBusinessOwner,
  handler(async (req, res) =>
    res.json(
      await assistantService.save(
        assistantId(req),
        req.body?.draft,
        version(req),
      ),
    ),
  ),
);
router.delete(
  "/:id",
  requireBusinessOwner,
  handler(async (req, res) => {
    await assistantService.remove(assistantId(req));
    return res.status(204).send();
  }),
);
router.post(
  "/:id/readiness",
  handler(async (req, res) =>
    res.json(await assistantService.readiness(assistantId(req))),
  ),
);
router.post(
  "/:id/publish",
  requireBusinessOwner,
  handler(async (req, res) => {
    if (req.body?.confirmAssignments !== true)
      throw new AssistantManagementError(
        "Review and confirm the final assignment summary.",
      );
    return res.json(
      await assistantService.publish(
        assistantId(req),
        version(req),
        req.body?.reassign === true,
      ),
    );
  }),
);
router.post(
  "/:id/pause",
  requireBusinessOwner,
  handler(async (req, res) =>
    res.json(await assistantService.pause(assistantId(req))),
  ),
);
router.post(
  "/:id/resume",
  requireBusinessOwner,
  handler(async (req, res) =>
    res.json(await assistantService.resume(assistantId(req))),
  ),
);
router.post(
  "/:id/rollback",
  requireBusinessOwner,
  handler(async (req, res) => {
    if (req.body?.confirmAssignments !== true)
      throw new AssistantManagementError(
        "Review and confirm the rollback assignment summary.",
      );
    const revision = req.body?.revision;
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new AssistantManagementError(
        "A previous published revision is required.",
      );
    return res.json(
      await assistantService.publish(
        assistantId(req),
        version(req),
        req.body?.reassign === true,
        revision,
      ),
    );
  }),
);
router.post(
  "/:id/rollback-bindings",
  requireBusinessOwner,
  handler(async (req, res) => {
    if (
      req.body?.confirmAssignments !== true ||
      !Number.isSafeInteger(req.body.expectedPublishedRevision) ||
      req.body.expectedPublishedRevision < 1
    ) {
      throw new AssistantManagementError(
        "Review the previous bindings and confirm the current published revision.",
      );
    }
    return res.json({
      assistants: await assistantService.rollbackBindings(
        assistantId(req),
        req.body.expectedPublishedRevision,
      ),
    });
  }),
);
router.get(
  "/:id/history",
  handler(async (req, res) =>
    res.json(await assistantOperations.history(assistantId(req),req.query)),
  ),
);
router.post(
  "/:id/simulate",
  handler(async (req, res) => {
    const assistant = await assistantService.get(assistantId(req)),
      scope = requireBusinessScope();
    const message = String(req.body?.message || "").trim(),
      channel = String(req.body?.channel || "web");
    if (
      !message ||
      message.length > 20000 ||
      !ASSISTANT_CHANNELS.includes(channel as any)
    )
      throw new AssistantManagementError(
        "Provide a message and a supported channel.",
      );
    if (!["draft", "published"].includes(req.body?.revision))
      throw new AssistantManagementError(
        "Select draft or published configuration.",
      );
    const history = req.body?.conversationHistory;
    if (
      history !== undefined &&
      (!Array.isArray(history) ||
        history.length > 20 ||
        history.some(
          (item) =>
            !item ||
            !["user", "assistant"].includes(item.role) ||
            typeof item.content !== "string" ||
            item.content.length > 8000,
        ))
    ) {
      throw new AssistantManagementError(
        "Provide a bounded simulator history with only user and assistant messages.",
      );
    }
    let session;
    try {
      session = assistantPreviewSession(
        {
          userId: scope.userId,
          businessProfileId: scope.businessProfileId,
          assistantId: assistant.id,
          configurationVersion:
            req.body.revision === "draft"
              ? `draft:${assistant.draftVersion}`
              : `published:${assistant.publishedRevision}`,
          channel,
        },
        req.body,
      );
    } catch (error) {
      throw new AssistantManagementError(
        error instanceof Error ? error.message : "Invalid simulator session.",
      );
    }
    const result = await channelGateway.process({
      userId: scope.userId,
      conversationId: session.conversationId,
      channel: channel as any,
      senderIdentifier: "simulator",
      inboundText: message,
      rawMessageId: `simulator:${randomUUID()}`,
      metadata: {
        executionMode: "preview",
        conversationKind: "owner_simulator",
        simulationAssistantId: assistant.id,
        simulationRevision: req.body.revision,
        conversationHistory: history || [],
      },
    });
    const ctx = result.context;
    return res.json({
      ...session,
      outcome: result.method,
      reply:
        ctx?.guardrailResult?.finalText || ctx?.agentResult?.replyText || "",
      replyText:
        ctx?.guardrailResult?.finalText || ctx?.agentResult?.replyText || "",
      resolvedAssistant: ctx?.metadata?.resolvedAssistant || null,
      playbook: ctx?.metadata?.playbookDirective || null,
      knowledgeSources: ctx?.contextLanes?.knowledge?.evidence || [],
      tools: ctx?.agentResult?.toolCallsExecuted || [],
      stages: ctx?.metadata?.stageTrace || [],
      model: ctx?.metadata?.llmProvider && ctx?.metadata?.llmModel ? {
        provider: ctx.metadata.llmProvider, model: ctx.metadata.llmModel, tokens: ctx.metadata.llmTokens || null,
      } : null,
      privacyOutcome: {
        redactedInput: ctx?.message.inboundText || "",
        piiTypes: ctx?.metadata?.privacy?.piiTypes || [],
        mandatory: true,
      },
      sideEffectsSuppressed: true,
      error: result.error || null,
    });
  }),
);
export default router;
