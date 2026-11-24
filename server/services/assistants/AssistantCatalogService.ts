import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { requireBusinessScope } from "../../tenancy/businessContext.js";
import { getActiveLLMAdminCredentials } from "../../models/adminApiCredentials/functions.js";
import { getActiveClassifierCredentials } from "../../models/intentClassifierCredentials/functions.js";
import { DEFAULT_SUPPORT_AGENT_PROFILES } from "../agents/orchestration/DefaultSupportConfiguration.js";
import {
  HIGH_RISK_SUPPORT_TOOLS,
  SUPPORT_TOOL_NAMES,
} from "../agents/orchestration/SafeToolExecutor.js";
import { isPrivacyVaultConfigured } from "../agents/orchestration/PrivacyVaultService.js";
import { getManagedAssistantModels, mergeAssistantModelCatalog, quotaDisabledAIProviders } from './AssistantModelCatalogService.js';
import { platformAIQuotaMessage } from '../../../shared/assistantModelCatalog.js';
import {
  assistantBindingKey,
  type AssistantAccount,
  type AssistantCatalog,
  type AssistantResource,
} from "../../../shared/outreachAssistants.js";
import { assistantsRuntimeEnabled } from "./AssistantContext.js";
import { extractTemplateVariables } from "../../utils/contentTemplateRendering.js";
import { resolveContentBrandContext } from '../content/ContentBrandContextService.js';
import { redactPiiWithStableTokens } from '../agents/orchestration/PrivacyVaultService.js';

/** Models come only from active, server-configured integrations. Never expose credentials/config JSON. */
export async function availableAssistantModels(): Promise<
  AssistantCatalog["models"]
> {
  const models: AssistantCatalog["models"] = [];
  const [credentials, managed] = await Promise.all([getActiveLLMAdminCredentials(), getManagedAssistantModels()]);
  for (const entry of mergeAssistantModelCatalog(credentials, managed)) {
      if (!entry.enabled || !entry.connected) continue;
      const model = entry.model;
      const reasoning =
        entry.provider === "openai" && /^(?:o\d|gpt-5)/i.test(model);
      models.push({
        provider: entry.provider,
        model,
        label: entry.label,
        description: entry.description,
        controls: reasoning ? [] : ["temperature", "topP"],
      });
  }
  return models;
}

export async function assistantPlatformReadiness() {
  const credentials = await getActiveClassifierCredentials();
  return {
    privacyVault: isPrivacyVaultConfigured(),
    classifier: credentials.some(
      (c) =>
        c.validationStatus === "valid" &&
        Boolean(c.apiKey) &&
        typeof c.config?.model === "string" &&
        Boolean(c.config.model.trim()),
    ),
  };
}

export async function assistantAccounts(): Promise<AssistantAccount[]> {
  const scope = requireBusinessScope();
  const [credentials, pages, email, web, bindings] = await Promise.all([
    db.execute(sql`SELECT platform,account_identifier,account_name,is_active,token_expiry,
      (COALESCE(length(access_token),0)>0 OR COALESCE(length(api_key),0)>0) AS has_secret,
      session_data->>'whatsappEnabled' AS whatsapp_enabled
      FROM channel_credentials WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
        AND platform IN ('whatsapp','instagram','facebook','instagram_api','facebook_api','gmail_api','smtp')`),
    db.execute(sql`SELECT page_id,page_name,instagram_account_id,instagram_username,is_active,facebook_active,instagram_active,
      webhook_subscribed,token_expiry,length(page_access_token)>0 AS has_secret FROM meta_page_connections WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}`),
    db.execute(sql`SELECT s.id,s.email,s.label,s.is_verified,s.type,
      CASE WHEN s.type='resend' THEN
        EXISTS(SELECT 1 FROM resend_domains d WHERE d.user_id=s.user_id AND d.business_profile_id=s.business_profile_id
          AND d.name=split_part(lower(s.email),'@',2) AND d.status='verified')
        AND EXISTS(SELECT 1 FROM admin_api_credentials a WHERE a.platform='resend' AND a.is_active AND length(a.api_key)>0)
      ELSE EXISTS(SELECT 1 FROM channel_credentials c WHERE c.id=s.credential_id AND c.user_id=s.user_id
        AND c.business_profile_id=s.business_profile_id AND c.platform='gmail_api' AND c.is_active
        AND lower(c.account_identifier)=lower(s.email) AND (c.access_token IS NOT NULL OR c.refresh_token IS NOT NULL)
        AND (c.token_expiry IS NULL OR c.token_expiry>NOW() OR c.refresh_token IS NOT NULL)) END AS route_connected
      FROM email_senders s WHERE s.user_id=${scope.userId} AND s.business_profile_id=${scope.businessProfileId}`),
    db.execute(sql`SELECT id,name,is_active,widget_token IS NOT NULL AS connected FROM support_teams
      WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}`),
    db.execute(sql`SELECT channel,surface,account_id,assistant_id FROM outreach_assistant_bindings
      WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND enabled`),
  ]);
  const accounts = new Map<string, AssistantAccount>();
  const add = (account: AssistantAccount) => {
    const key = assistantBindingKey(account);
    // Prefer a currently verified connected route; selection state is never a routing hint.
    const previous = accounts.get(key);
    if (!previous || (!previous.connected && account.connected))
      accounts.set(key, account);
  };
  for (const row of credentials.rows) {
    const channel = String(row.platform).replace(/_api$/, "");
    if (
      !row.account_identifier ||
      !["whatsapp", "instagram", "facebook"].includes(channel)
    )
      continue;
    const account: AssistantAccount = {
      channel: channel as AssistantAccount["channel"],
      surface: "private",
      accountId: String(row.account_identifier),
      label: String(row.account_name || row.account_identifier),
      connected: Boolean(
        row.is_active &&
        row.has_secret &&
        row.whatsapp_enabled !== "false" &&
        (!row.token_expiry || new Date(String(row.token_expiry)) > new Date()),
      ),
    };
    add(account);
    if (["instagram", "facebook"].includes(account.channel))
      add({ ...account, surface: "public_comment" });
  }
  for (const row of pages.rows) {
    const valid = Boolean(
      row.is_active &&
      row.has_secret &&
      row.webhook_subscribed &&
      (!row.token_expiry || new Date(String(row.token_expiry)) > new Date()),
    );
    for (const surface of ["private", "public_comment"] as const) {
      add({
        channel: "facebook",
        surface,
        accountId: String(row.page_id),
        label: String(row.page_name || row.page_id),
        connected: valid && Boolean(row.facebook_active),
      });
      if (row.instagram_account_id)
        add({
          channel: "instagram",
          surface,
          accountId: String(row.instagram_account_id),
          label: String(row.instagram_username || row.instagram_account_id),
          connected: valid && Boolean(row.instagram_active),
        });
    }
  }
  // Canonical email identity is the verified sender address, not the selected sender or a mutable label.
  for (const row of email.rows)
    add({
      channel: "email",
      surface: "private",
      accountId: String(row.email).toLowerCase(),
      label: String(row.label || row.email),
      connected: Boolean(row.is_verified && row.route_connected),
    });
  for (const row of web.rows)
    add({
      channel: "web",
      surface: "private",
      accountId: `team:${row.id}`,
      label: String(row.name || `Web chat ${row.id}`),
      connected: Boolean(row.is_active && row.connected),
    });
  for (const account of accounts.values())
    account.assignedAssistantId =
      String(
        bindings.rows.find(
          (b: Record<string, any>) =>
            assistantBindingKey({
              channel: b.channel as AssistantAccount["channel"],
              surface: b.surface as AssistantAccount["surface"],
              accountId: String(b.account_id),
            }) === assistantBindingKey(account),
        )?.assistant_id || "",
      ) || null;
  // Historical credentials remain stored for reconnects and audit history, but
  // only usable connections belong in the assistant account inventory.
  return [...accounts.values()].filter(account => account.connected).sort(
    (a, b) =>
      a.channel.localeCompare(b.channel) || a.label.localeCompare(b.label),
  );
}

export async function assistantCatalog(): Promise<AssistantCatalog> {
  const scope = requireBusinessScope();
  const [
    accounts,
    models,
    knowledge,
    playbooks,
    templates,
    documents,
    galleries,
  ] = await Promise.all([
    assistantAccounts(),
    availableAssistantModels(),
    db.execute(sql`SELECT d.id,d.title,d.allowed_channels,v.version_no AS source_version FROM knowledge_documents d JOIN knowledge_document_versions v
      ON v.id=d.current_published_version_id AND v.document_id=d.id AND v.user_id=d.user_id
      WHERE d.user_id=${scope.userId} AND d.business_profile_id=${scope.businessProfileId} AND d.deleted_at IS NULL
        AND d.audience='customer' AND d.access_scope IN ('tenant','business_profile') AND v.privacy_classification IN ('public','business')
        AND v.status IN ('published','published_degraded') AND (v.effective_at IS NULL OR v.effective_at<=NOW())
        AND (v.expires_at IS NULL OR v.expires_at>NOW()) AND d.usage_scopes && ARRAY['support_answer','outreach_reply']::text[]`),
    // Default routing published with each playbook; the assistant editor
    // copies it when the playbook is added so assignments do not all tie.
    db.execute(sql`SELECT p.id,p.name,p.agent_type,v.graph,v.version AS source_version,
        (SELECT COALESCE(json_agg(json_build_object('intent',a.intent,'priority',a.priority) ORDER BY a.priority,a.id),'[]'::json)
          FROM support_playbook_assignments a WHERE a.playbook_id=p.id AND a.user_id=p.user_id AND a.enabled) AS default_assignments
      FROM support_playbooks p JOIN support_playbook_versions v
      ON v.playbook_id=p.id AND v.version=p.active_version WHERE p.user_id=${scope.userId}
        AND p.business_profile_id=${scope.businessProfileId} AND p.status='published' AND p.enabled`),
    db.execute(sql`SELECT id,name,type,variables,content,subject,html_content,is_approved,brand_toolkit_id,brand_context_snapshot,version AS source_version FROM content_templates WHERE user_id=${scope.userId}
      AND business_profile_id=${scope.businessProfileId} AND type IN ('email','social_message','whatsapp')`),
    db.execute(sql`SELECT a.id,a.title FROM support_approved_documents a JOIN storage_files f ON f.id=a.storage_file_id
      AND f.user_id=a.user_id WHERE a.user_id=${scope.userId} AND a.business_profile_id=${scope.businessProfileId}
        AND a.status='published' AND a.withdrawn_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>NOW())
        AND a.approved_by=a.user_id AND NOT f.is_deleted AND f.mime_type='application/pdf'`),
    db.execute(sql`SELECT g.id,g.title,g.allowed_channels FROM support_media_galleries g JOIN support_media_gallery_versions v
      ON v.id=g.current_published_version_id AND v.gallery_id=g.id WHERE g.user_id=${scope.userId}
        AND g.business_profile_id=${scope.businessProfileId} AND g.status='active' AND g.audience='customer'
        AND v.status='published' AND v.rights_certified AND (v.effective_at IS NULL OR v.effective_at<=NOW())
        AND (v.expires_at IS NULL OR v.expires_at>NOW()) AND g.usage_scopes && ARRAY['support_answer','outreach_reply']::text[]`),
  ]);
  const resource = (row: Record<string, unknown>): AssistantResource => ({
    id: Number(row.id),
    name: String(row.name || row.title),
    status: 'available',
    sourceVersion: row.source_version == null ? undefined : Number(row.source_version),
    channels:
      Array.isArray(row.allowed_channels) && row.allowed_channels.length
        ? row.allowed_channels.map(String)
        : ["whatsapp", "instagram", "facebook", "email", "web"],
  });
  // is_approved alone is insufficient: an approval expires when its business
  // or brand context changes. The same check runs again at the send boundary.
  const unavailableResources: NonNullable<AssistantCatalog['unavailableResources']> = [];
  const brandContexts = new Map<string, ReturnType<typeof resolveContentBrandContext>>();
  const templateChannels = (type: unknown) => type==='email'?['email']:type==='whatsapp'?['whatsapp']:['instagram','facebook'];
  const approvedTemplates = (
    await Promise.all(
      templates.rows.map(async (row: Record<string, any>) => {
        try {
          if (!row.is_approved) throw new Error('Review and approve this template before assigning it.');
          const contextKey=String(row.brand_toolkit_id || 'default');
          if (!brandContexts.has(contextKey)) brandContexts.set(contextKey,resolveContentBrandContext(scope.userId,{businessProfileId:scope.businessProfileId,brandToolkitId:row.brand_toolkit_id}));
          const context=await brandContexts.get(contextKey)!;
          const provenance=row.brand_context_snapshot?.provenance;
          if (provenance?.businessProfile?.version!==context.businessProfile.version || provenance?.brandToolkit?.version!==context.brandToolkit.version)
            throw new Error('The business or brand context changed. Review and approve this template again.');
          return row;
        } catch (error) {
          if ((scope.actorUserId ?? scope.userId)===scope.userId) unavailableResources.push({...resource(row),category:'templates',channels:templateChannels(row.type),status:row.is_approved?'approval_outdated':'unapproved',
            availabilityReason:error instanceof Error&&error.message.startsWith('The business')?error.message:row.is_approved?'The current approval context could not be verified.':'Review and approve this template before assigning it.'});
          return null;
        }
      }),
    )
  ).filter((row): row is (typeof templates.rows)[number] => row !== null);
  if ((scope.actorUserId ?? scope.userId)===scope.userId) {
    const excluded=await db.execute(sql`SELECT 'knowledge' AS category,d.id,d.title AS name,
      CASE WHEN d.audience<>'customer' THEN 'Internal audience: customer assistants cannot use this source.'
        WHEN d.access_scope NOT IN ('tenant','business_profile') THEN 'Restricted access: this source is not available to customer assistants.'
        WHEN v.id IS NULL OR v.status NOT IN ('published','published_degraded') THEN 'Publish a current knowledge version before assigning this source.'
        WHEN v.privacy_classification NOT IN ('public','business') THEN 'This privacy classification is not permitted for customer replies.'
        WHEN v.effective_at>NOW() THEN 'This knowledge version is not effective yet.' WHEN v.expires_at<=NOW() THEN 'This knowledge version has expired.'
        ELSE 'Enable support_answer or outreach_reply usage scope before assigning this source.' END AS reason
      FROM knowledge_documents d LEFT JOIN knowledge_document_versions v ON v.id=d.current_published_version_id AND v.document_id=d.id AND v.user_id=d.user_id AND v.business_profile_id=d.business_profile_id
      WHERE d.user_id=${scope.userId} AND d.business_profile_id=${scope.businessProfileId} AND d.deleted_at IS NULL
      UNION ALL SELECT 'documents',a.id,a.title,
        CASE WHEN a.withdrawn_at IS NOT NULL THEN 'This approved document was withdrawn.' WHEN a.expires_at<=NOW() THEN 'This approved document has expired.'
          WHEN a.status<>'published' THEN 'Publish this approved PDF before assigning it.' WHEN a.approved_by IS DISTINCT FROM a.user_id THEN 'Owner approval is required.'
          ELSE 'The approved PDF storage file is unavailable, deleted, or is not a PDF.' END
      FROM support_approved_documents a WHERE a.user_id=${scope.userId} AND a.business_profile_id=${scope.businessProfileId}
      UNION ALL SELECT 'galleries',g.id,g.title,
        CASE WHEN g.status<>'active' THEN 'Activate this gallery before assigning it.' WHEN g.audience<>'customer' THEN 'This gallery is not approved for a customer audience.'
          WHEN v.id IS NULL OR v.status<>'published' THEN 'Publish a current gallery version before assigning it.' WHEN NOT v.rights_certified THEN 'Certify media rights before assigning this gallery.'
          WHEN v.effective_at>NOW() THEN 'This gallery version is not effective yet.' WHEN v.expires_at<=NOW() THEN 'This gallery version has expired.'
          ELSE 'Enable support_answer or outreach_reply usage scope before assigning this gallery.' END
      FROM support_media_galleries g LEFT JOIN support_media_gallery_versions v ON v.id=g.current_published_version_id AND v.gallery_id=g.id AND v.business_profile_id=g.business_profile_id
      WHERE g.user_id=${scope.userId} AND g.business_profile_id=${scope.businessProfileId}`);
    const available={knowledge:knowledge.rows,documents:documents.rows,galleries:galleries.rows};
    for(const row of excluded.rows as Record<string,any>[]) if(!available[row.category as keyof typeof available].some((r:Record<string,unknown>)=>Number(r.id)===Number(row.id)))
      unavailableResources.push({...resource(row),category:row.category,status:'unavailable',availabilityReason:String(row.reason)});
  }
  const quotaProviders = models.length ? [] : await quotaDisabledAIProviders();
  return {
    runtimeEnabled: assistantsRuntimeEnabled(),
    accounts,
    models,
    ...(quotaProviders.length ? { modelAvailabilityNotice: platformAIQuotaMessage(quotaProviders) } : {}),
    unavailableResources,
    presets: DEFAULT_SUPPORT_AGENT_PROFILES.map((p) => ({
      agentType: p.type,
      name: p.name,
      description: p.description,
      instructions: p.prompt,
      tools: p.toolsEnabled,
      policies: { rules: p.escalationRules },
    })),
    knowledge: knowledge.rows.map(resource),
    playbooks: playbooks.rows.map((row: Record<string, unknown>) => {
      const graph = row.graph as {
        fields?: { key: string; pii?: string }[];
        nodes?: { data?: { fields?: { key: string; pii?: string }[] } }[];
      };
      const fields = [
        ...(graph.fields || []),
        ...(graph.nodes || []).flatMap((n) => n.data?.fields || []),
      ];
      return {
        ...resource(row),
        agentType: String(row.agent_type),
        defaultAssignments: (Array.isArray(row.default_assignments) ? row.default_assignments as { intent?: unknown; priority?: unknown }[] : [])
          .filter(a => Number.isInteger(Number(a.priority)))
          .map(a => ({ intent: typeof a.intent === 'string' && a.intent.trim() ? a.intent.trim().slice(0, 80) : null, priority: Number(a.priority) }))
          .filter((a, index, all) => all.findIndex(other => other.intent === a.intent) === index)
          .slice(0, 10),
        collectionFields: [
          ...new Set(
            fields.filter((f) => f.pii === "contact").map((f) => f.key),
          ),
        ],
      };
    }),
    templates: approvedTemplates.map((row: Record<string, unknown>) => ({
      ...resource(row),
      channels:
        row.type === "email"
          ? ["email"]
          : row.type === "whatsapp"
            ? ["whatsapp"]
            : ["instagram", "facebook"],
      variables: extractTemplateVariables(
        [row.content, row.subject, row.html_content].filter(Boolean).join("\n"),
      ),
      preview: (() => {
        let body=String(row.content || '');
        try {
          const parsed=JSON.parse(body);
          if (typeof parsed==='string') body=parsed;
          else if (parsed&&typeof parsed==='object'&&!Array.isArray(parsed)) body=[parsed.greeting,parsed.body || parsed.emailBody || parsed.message || parsed.text || parsed.content,parsed.closing,parsed.signature].filter(v=>typeof v==='string'&&v).join('\n\n');
        } catch { /* Standard plain text template. */ }
        return redactPiiWithStableTokens([row.subject,body].filter(Boolean).join('\n\n').slice(0,6000)).redactedText;
      })(),
    })),
    documents: documents.rows.map((row: Record<string, unknown>) => ({
      ...resource(row),
      channels: ["whatsapp", "web"],
    })),
    galleries: galleries.rows.map(resource),
    tools: [...SUPPORT_TOOL_NAMES].map((name) => ({
      name,
      label: name.replaceAll("_", " "),
      approvalRequired: HIGH_RISK_SUPPORT_TOOLS.has(name),
    })),
    permissions: {
      canManage: (scope.actorUserId ?? scope.userId) === scope.userId,
      description:
        "Existing business staff permissions still apply. Selecting an assistant never grants access to raw customer data.",
    },
  };
}
