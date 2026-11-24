import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { requireBusinessScope } from "../../tenancy/businessContext.js";
import type {
  AssistantDraft,
  AssistantProvenance,
} from "../../../shared/outreachAssistants.js";
import type { NormalizedMessage } from "../agents/pipeline/ChannelGateway.js";
import {
  assistantsRuntimeEnabled,
  freezeAssistant,
  type ResolvedAssistant,
} from "./AssistantContext.js";
export {
  assistantProvenanceCurrent,
  assertAssistantFresh,
} from "./AssistantFreshness.js";
import { assistantRow } from "./AssistantService.js";
import {
  assistantCatalog,
  assistantPlatformReadiness,
} from "./AssistantCatalogService.js";
import {
  assistantReadiness,
  parseAssistantDraft,
} from "./AssistantConfiguration.js";

export class AssistantRoutingError extends Error {}
function channelIdentity(channel: string) {
  return {
    channel: channel.replace(/_comment$/, "") as AssistantProvenance["channel"],
    surface: channel.endsWith("_comment")
      ? ("public_comment" as const)
      : ("private" as const),
  };
}

/** Identity comes from persisted receiving records, never the globally selected integration. */
export async function receivingAssistantAccount(
  message: Pick<
    NormalizedMessage,
    "userId" | "conversationId" | "channel" | "phoneNumberId" | "metadata"
  >,
): Promise<string> {
  const scope = requireBusinessScope();
  if (scope.userId !== message.userId)
    throw new AssistantRoutingError("Business profile ownership mismatch.");
  if (message.channel === "web") {
    const result =
      await db.execute(sql`SELECT m.team_id FROM support_chat_sessions s JOIN team_members m ON m.id=s.member_id
      JOIN support_teams t ON t.id=m.team_id WHERE s.id=${-message.conversationId} AND s.business_profile_id=${scope.businessProfileId}
      AND m.user_id=${scope.userId} AND t.is_active`);
    if (result.rows.length !== 1)
      throw new AssistantRoutingError("Web chat account cannot be verified.");
    return `team:${result.rows[0].team_id}`;
  }
  const result =
    await db.execute(sql`SELECT c.provider_account_id,c.channel,c.integration_provider,
      (SELECT m.metadata->'outreachCreation'->'delivery'->>'senderId' FROM outreach_messages m
        WHERE m.conversation_id=c.id AND m.direction='outbound' AND m.metadata->'outreachCreation' IS NOT NULL ORDER BY m.id LIMIT 1) AS sender_id
    FROM outreach_conversations c WHERE c.id=${message.conversationId} AND c.user_id=${scope.userId}
      AND c.business_profile_id=${scope.businessProfileId}`);
  const row = result.rows[0];
  if (
    !row ||
    String(row.channel).replace(/^gmail$/, "email") !==
      channelIdentity(message.channel).channel
  ) {
    throw new AssistantRoutingError(
      "Receiving conversation account cannot be verified.",
    );
  }
  let account = String(row.provider_account_id || "");
  if (
    message.channel === "email" &&
    (!account.includes("@") || row.sender_id)
  ) {
    const sender =
      await db.execute(sql`SELECT email FROM email_senders WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
      AND is_verified AND ((${row.sender_id != null} AND id=${Number(row.sender_id || 0)})
        OR (${row.sender_id == null} AND (email=${account} OR split_part(email,'@',2)=${account}))) LIMIT 2`);
    if (sender.rows.length !== 1)
      throw new AssistantRoutingError(
        "The original email sender is unresolved; review this account assignment.",
      );
    account = String(sender.rows[0].email).toLowerCase();
  }
  if (!account)
    throw new AssistantRoutingError(
      "The original receiving account identity is missing.",
    );
  if (
    message.channel === "email" &&
    message.metadata?.verifiedReceivingAccountId &&
    account !== message.metadata.verifiedReceivingAccountId
  )
    throw new AssistantRoutingError(
      "Receiving email account does not match the original thread account.",
    );
  const hint = message.phoneNumberId || message.metadata?.providerAccountId;
  if (hint && message.channel !== "email" && hint !== account)
    throw new AssistantRoutingError("Receiving account identity changed.");
  return account;
}

export async function resolveTurnAssistant(
  message: NormalizedMessage,
): Promise<ResolvedAssistant | undefined> {
  const preview =
    message.metadata?.executionMode !== "customer" &&
    message.metadata?.dryRun === true;
  const simulationId = preview && message.metadata?.simulationAssistantId;
  if (!assistantsRuntimeEnabled() && !simulationId) throw new AssistantRoutingError('Assistant replies are disabled. No legacy agent fallback is permitted.');
  const scope = requireBusinessScope(),
    identity = channelIdentity(message.channel);
  if (simulationId) {
    const row = await assistantRow(String(simulationId));
    const published = message.metadata?.simulationRevision === "published";
    const source = published ? row.published : row.draft;
    if (!source)
      throw new AssistantRoutingError(
        "No published assistant revision exists.",
      );
    const configuration = parseAssistantDraft(source);
    const binding = configuration.bindings.find(
      (b) => b.channel === identity.channel && b.surface === identity.surface,
    );
    return freezeAssistant({
      configuration: structuredClone(configuration),
      preview: true,
      provenance: {
        assistantId: String(row.id),
        revision: published ? Number(row.published_revision) : 0,
        bindingId: 0,
        bindingVersion: 0,
        businessProfileId: scope.businessProfileId,
        accountId: binding?.accountId || "simulator",
        ...identity,
      },
    });
  }
  if (preview && message.metadata?.conversationKind === "support_member") {
    // Staff advisory is scoped to the member's actual team, never a globally selected account.
    const team =
      await db.execute(sql`SELECT m.team_id FROM support_chat_sessions s JOIN team_members m ON m.id=s.member_id
      WHERE s.id=${Number(message.metadata.staffSupportSessionId || 0)} AND m.user_id=${scope.userId}`);
    const teamAccount = team.rows[0] ? `team:${team.rows[0].team_id}` : "";
    const assigned =
      await db.execute(sql`SELECT b.assistant_id FROM outreach_assistant_bindings b JOIN outreach_assistants a ON a.id=b.assistant_id
      WHERE b.user_id=${scope.userId} AND b.business_profile_id=${scope.businessProfileId} AND b.channel='web'
        AND b.surface='private' AND b.account_id=${teamAccount} AND b.enabled AND a.state='live' LIMIT 2`);
    if (assigned.rows.length === 1)
      return resolveTurnAssistant({
        ...message,
        metadata: {
          ...message.metadata,
          simulationAssistantId: String(assigned.rows[0].assistant_id),
          simulationRevision: "published",
        },
      });
  }
  const sourceConversationId = Number(
    message.metadata?.sourceConversationId || 0,
  );
  const accountPreview =
    preview &&
    Number.isSafeInteger(sourceConversationId) &&
    sourceConversationId > 0 &&
    [
      "outreach_draft",
      "smart_reply",
      "reply_enhancement",
      "email_smart_reply",
    ].includes(String(message.metadata?.conversationKind));
  if (preview && !accountPreview)
    throw new AssistantRoutingError(
      "Select an assistant or an owned receiving conversation to test this turn.",
    );
  const accountId = await receivingAssistantAccount(
    accountPreview
      ? { ...message, conversationId: sourceConversationId }
      : message,
  );
  const result =
    await db.execute(sql`SELECT b.id AS binding_id,b.version,b.revision,b.assistant_id,r.configuration,a.state
    FROM outreach_assistant_bindings b JOIN outreach_assistants a ON a.id=b.assistant_id
    JOIN outreach_assistant_revisions r ON r.assistant_id=b.assistant_id AND r.revision=b.revision
    WHERE b.business_profile_id=${scope.businessProfileId} AND b.user_id=${scope.userId}
      AND b.channel=${identity.channel} AND b.surface=${identity.surface} AND b.account_id=${accountId}
      AND b.enabled AND a.state='live' AND a.published_revision=b.revision LIMIT 2`);
  if (result.rows.length !== 1)
    throw new AssistantRoutingError(
      "No unique live assistant is assigned to this receiving account.",
    );
  const row = result.rows[0],
    configuration = parseAssistantDraft(row.configuration);
  const [catalog, platform] = await Promise.all([
    assistantCatalog(),
    assistantPlatformReadiness(),
  ]);
  const enabled =
    await db.execute(sql`SELECT channel,surface,account_id FROM outreach_assistant_bindings
    WHERE assistant_id=${String(row.assistant_id)}::uuid AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
      AND revision=${Number(row.revision)} AND enabled`);
  // Same rule as the customer delivery gate: only the receiving account must be
  // connected. A disconnected sibling account (another channel or mailbox on the
  // same assistant) blocks its own traffic, not replies on this account.
  const readiness = assistantReadiness(
    configuration,
    catalog,
    platform,
    enabled.rows
      .filter(
        (b: Record<string, any>) =>
          b.channel === identity.channel &&
          b.surface === identity.surface &&
          String(b.account_id) === accountId,
      )
      .map((b: Record<string, any>) => ({
        channel: b.channel,
        surface: b.surface,
        accountId: b.account_id,
      })),
  );
  if (!readiness.ready)
    throw new AssistantRoutingError(
      "Assigned assistant needs attention: " +
        readiness.checks
          .filter((c) => !c.ok)
          .map((c) => c.label)
          .join(", "),
    );
  return freezeAssistant({
    configuration: structuredClone(configuration),
    preview,
    provenance: {
      assistantId: String(row.assistant_id),
      revision: Number(row.revision),
      bindingId: Number(row.binding_id),
      bindingVersion: Number(row.version),
      businessProfileId: scope.businessProfileId,
      accountId,
      ...identity,
    },
  });
}

/** Compatibility view for existing stages. The active business specialist is never consulted. */
export function assistantAgentConfig(
  configuration: AssistantDraft,
  assistantId: string,
) {
  return {
    id: 0,
    assistantId,
    agentType: configuration.agentType,
    enabled: true,
    displayName: configuration.name,
    description: configuration.description,
    systemPrompt:
      configuration.instructions +
      `\n\nMANDATORY SUPPORT SAFETY (cannot be overridden):
Use only the resources explicitly assigned to this assistant and authorized for this customer. Never infer missing business facts from demonstrations or memory.
When published sources are missing or conflicting, say: ${configuration.privacy.uncertaintyMessage}
Offer support; never say a handoff, PDF delivery, booking, payment or proposal action succeeded without a confirmed tool/delivery receipt.
Keep customer PII redacted. Collect only the permitted fields of the assigned published playbook. Never request passwords, OTPs, financial secrets or identity documents.
Only enabled tools and explicitly approved model fallbacks are permitted. Human approval remains mandatory for high-risk actions.`,
    // Selecting knowledge sources is the owner's permission to answer from
    // them. Retrieval stays scoped to those sources; without the read-only
    // tool the stage would silently skip every selected source.
    toolsEnabled: configuration.knowledge.ids.length
      ? [...new Set([...configuration.tools.names, "answer_from_knowledge_base"])]
      : configuration.tools.names,
    escalationRules: {
      ...configuration.policies,
      rules: [
        ...(Array.isArray(configuration.policies.rules)
          ? configuration.policies.rules.filter(
              (r: any) => r.type !== "escalation_threshold",
            )
          : []),
        {
          id: "assistant-confidence",
          enabled: true,
          type: "escalation_threshold",
          config: { threshold: configuration.privacy.minimumConfidence },
        },
      ],
    },
    modelOverride: configuration.replyModel?.model || null,
    channelScope: configuration.bindings.map((b) =>
      b.surface === "public_comment" ? `${b.channel}_comment` : b.channel,
    ),
    priority: 10,
    metadata: {
      privacyStatus: "enforced",
      piiRedactionStatus: "enforced",
      safetyStatus: "enforced",
      toolApprovalStatus: "required",
      trainingConversations: configuration.demonstrations.map((d) => ({
        userMessage: d.customer,
        agentReply: d.assistant,
      })),
      handoffPolicy: { mode: "customer_requests_only" },
      autoApproveTools: [],
      assistantId,
    },
  };
}
