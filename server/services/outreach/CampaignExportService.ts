import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../models/db.js";
import { requireBusinessScope } from "../../tenancy/businessContext.js";
import { captureJobBusiness } from "../../tenancy/jobBusinessScope.js";
import { serializeUtcTimestamp } from "../../utils/supportTimestamp.js";
import { campaignReportFiltersSchema } from "./CampaignReportFilters.js";
import {
  getCampaignReport,
  validateReportScope,
} from "./CampaignReportingService.js";
import {
  getCampaignCustomers,
  getCampaignHistory,
} from "./CustomerEngagementService.js";
import { renderCampaignReport } from "./CampaignReportFormats.js";
import {
  DashboardOperationError,
  ownedDashboardOperation,
  enqueueDashboardOperation,
  resumeDashboardOperation,
  type DashboardOperationRow,
} from "../operations/DashboardOperations.js";
import { operationRequestKeySchema } from "../operations/ContactAnalysisValidation.js";
import {
  campaignExportFormats,
  type CampaignExportFormat,
  type CampaignExportOperation,
  type CampaignReportSnapshot,
} from "../../../shared/campaignExports.js";
import { campaignReportUrl } from "../../../shared/campaignReporting.js";
export const campaignExportSchema = z
  .object({
    name: z.string().trim().min(1).max(160).default("Campaign delivery report"),
    filters: campaignReportFiltersSchema.default({ messageKind: "outreach" }),
    requestKey: operationRequestKeySchema,
  })
  .strict();
export const campaignExportFormatSchema = z.enum(campaignExportFormats);
export const campaignExportTypes: Record<CampaignExportFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  html: "text/html; charset=utf-8",
};
const instant = (value: unknown) => serializeUtcTimestamp(value)!;
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const fileName = (format: CampaignExportFormat) =>
  format === "html" ? "conversation-history.html" : `campaign-report.${format}`;
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;
function view(row: DashboardOperationRow): CampaignExportOperation {
  if (Date.parse(instant(row.expires_at)) <= Date.now() || !row.payload.filters)
    throw new DashboardOperationError(
      "This saved export expired. Generate a fresh campaign snapshot.",
      410,
    );
  const result = row.result || {},
    files = (result.files || []) as CampaignExportOperation["files"];
  const checkedAt =
    typeof result.snapshotAt === "string" ? result.snapshotAt : null;
  return {
    id: row.id,
    businessProfileId: row.business_profile_id,
    name: String(row.payload.name),
    status: row.status,
    createdAt: instant(row.created_at),
    expiresAt: instant(row.expires_at),
    snapshotAt: checkedAt,
    snapshotHash:
      typeof result.snapshotHash === "string" ? result.snapshotHash : null,
    filters: row.payload.filters as CampaignExportOperation["filters"],
    progress: { completed: row.processed, total: row.total },
    error: row.error,
    files,
    card: {
      title: "Campaign report downloads",
      status: row.status,
      businessProfileId: row.business_profile_id,
      checkedAt: checkedAt || instant(row.created_at),
      operation: { id: row.id, kind: "campaign_export" },
      progress: { completed: row.processed, total: row.total },
      description:
        row.error ||
        (checkedAt
          ? "PDF, Word, Excel and protected conversation history use this exact saved snapshot. Download links expire after 30 days."
          : "Preparing one timestamped snapshot for all report formats."),
      metrics: [
        { label: "Files ready", value: files.length },
        ...(Number.isSafeInteger(result.customerCount)
          ? [
              {
                label: "Selected customers",
                value: Number(result.customerCount),
              },
            ]
          : []),
      ],
      actions: [
        {
          label:
            row.status === "completed"
              ? "Download report"
              : "View report progress",
          href: `/dashboard/outreach/reports/exports/${row.id}`,
        },
        {
          label: "View live campaign report",
          href: campaignReportUrl(
            row.payload.filters as CampaignExportOperation["filters"],
          ),
        },
      ],
    },
  };
}
export async function getCampaignExport(id: string) {
  return view(await ownedDashboardOperation(id, ["campaign_export"]));
}
export async function createCampaignExport(
  input: z.infer<typeof campaignExportSchema>,
) {
  input = campaignExportSchema.parse(input);
  const scope = requireBusinessScope();
  await validateReportScope(scope.userId, input.filters);
  const fingerprint = hash(
      JSON.stringify({ name: input.name, filters: input.filters }),
    ),
    origin = await captureJobBusiness({
      userId: scope.userId,
      businessProfileId: scope.businessProfileId,
    });
  const row = await db.transaction(async (tx: typeof db) => {
    const inserted =
      await tx.execute(sql`INSERT INTO dashboard_operations(id,user_id,business_profile_id,kind,status,request_key,fingerprint,origin,payload,total)
      VALUES(${randomUUID()}::uuid,${scope.userId},${scope.businessProfileId},'campaign_export','queued',${input.requestKey},${fingerprint},${JSON.stringify(origin)}::jsonb,
        ${JSON.stringify({ name: input.name, filters: input.filters })}::jsonb,5) ON CONFLICT(business_profile_id,user_id,request_key) DO NOTHING RETURNING *`);
    const row = (inserted.rows[0] ||
      (
        await tx.execute(
          sql`SELECT * FROM dashboard_operations WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND request_key=${input.requestKey}`,
        )
      ).rows[0]) as DashboardOperationRow;
    if (row.kind !== "campaign_export" || row.fingerprint !== fingerprint)
      throw new DashboardOperationError(
        "This request key belongs to a different report. Open the saved export or generate a new snapshot.",
        409,
      );
    return row;
  });
  try {
    await enqueueDashboardOperation(row);
  } catch {
    /* SQL recovery retains the original authority. */
  }
  return view(row);
}
/** Repeatable-read is part of BEGIN, before the scoped pool sets its local
 * identity. All formats use these immutable bytes, never fresh live queries. */
export async function captureCampaignSnapshot(
  userId: number,
  name: string,
  filters: z.infer<typeof campaignReportFiltersSchema>,
): Promise<CampaignReportSnapshot> {
  return db.transaction(
    async (tx: typeof db) => {
      const report = await getCampaignReport(userId, filters, tx);
      const customers = await getCampaignCustomers(
        userId,
        filters,
        {},
        tx,
        true,
      );
      const history = await getCampaignHistory(userId, filters, {}, tx, true);
      return {
        version: 1,
        name,
        businessProfileId: requireBusinessScope().businessProfileId,
        checkedAt: report.checkedAt,
        report,
        customers: customers.items,
        history: history.items,
        notes: [
          "All formats use the same immutable timestamped snapshot. Live delivery counts can change after this time.",
          "Accepted includes confirmed delivered and awaiting delivery confirmation. Awaiting confirmation is not a failed message or permission to resend.",
          "Protected conversation values are masked. Full customer rows and protected history are in the Excel and conversation-history downloads.",
          "Tracked link events may include scanners. Verified booking actions require a recorded verified event attributed to the conversation. Untracked WhatsApp URL clicks and phone-call button clicks are unavailable.",
        ],
      };
    },
    { isolationLevel: "repeatable read", readOnly: true },
  );
}
async function savedFile(
  row: DashboardOperationRow,
  ordinal: number,
  executor = db,
): Promise<Buffer | null> {
  const result =
    await executor.execute(sql`SELECT input.bytes FROM dashboard_operation_files file JOIN dashboard_operation_inputs input ON input.id=file.input_id
    AND input.user_id=file.user_id AND input.business_profile_id=file.business_profile_id WHERE file.operation_id=${row.id}::uuid AND file.ordinal=${ordinal}
    AND file.user_id=${row.user_id} AND file.business_profile_id=${row.business_profile_id} AND input.expires_at>now()`);
  return result.rows[0]?.bytes || null;
}
async function saveFile(
  row: DashboardOperationRow,
  token: string,
  ordinal: number,
  name: string,
  bytes: Buffer,
) {
  if (bytes.length > MAX_SNAPSHOT_BYTES)
    throw new DashboardOperationError(
      "This export exceeds the 100 MB file budget. Narrow the report dates or audience before generating it.",
      413,
    );
  await db.transaction(async (tx: typeof db) => {
    const fence =
      await tx.execute(sql`SELECT id FROM dashboard_operations WHERE id=${row.id}::uuid AND user_id=${row.user_id} AND business_profile_id=${row.business_profile_id}
      AND lease_token=${token}::uuid AND status='running' FOR UPDATE`);
    if (!fence.rows.length)
      throw new DashboardOperationError(
        "Export ownership changed. Refresh the saved operation.",
        409,
      );
    if (await savedFile(row, ordinal, tx)) return;
    const digest = hash(bytes),
      input =
        await tx.execute(sql`INSERT INTO dashboard_operation_inputs(id,user_id,business_profile_id,hash,bytes,expires_at)
      VALUES(${randomUUID()}::uuid,${row.user_id},${row.business_profile_id},${digest},${bytes},${instant(row.expires_at)}::timestamptz)
      ON CONFLICT(business_profile_id,user_id,hash) DO UPDATE SET expires_at=GREATEST(dashboard_operation_inputs.expires_at,EXCLUDED.expires_at) RETURNING id`);
    await tx.execute(sql`INSERT INTO dashboard_operation_files(id,user_id,business_profile_id,operation_id,name,hash,ordinal,input_id)
      VALUES(${randomUUID()}::uuid,${row.user_id},${row.business_profile_id},${row.id}::uuid,${name},${digest},${ordinal},${input.rows[0].id}::uuid) ON CONFLICT(operation_id,ordinal) DO NOTHING`);
  });
}
export async function processCampaignExport(
  row: DashboardOperationRow,
  token: string,
  checkpoint: (values: {
    cursor: number;
    processed: number;
    total: number;
    status?: DashboardOperationRow["status"];
    result?: unknown;
  }) => Promise<void>,
) {
  let bytes = await savedFile(row, 0);
  if (!bytes) {
    const snapshot = await captureCampaignSnapshot(
      row.user_id,
      String(row.payload.name),
      row.payload.filters as z.infer<typeof campaignReportFiltersSchema>,
    );
    bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
    await saveFile(row, token, 0, "snapshot.json", bytes);
  }
  const snapshot = JSON.parse(bytes.toString("utf8")) as CampaignReportSnapshot;
  if (
    snapshot.businessProfileId !== row.business_profile_id ||
    snapshot.version !== 1
  )
    throw new DashboardOperationError(
      "The saved report snapshot does not match this business.",
      409,
    );
  const result = {
    snapshotAt: snapshot.checkedAt,
    snapshotHash: hash(bytes),
    customerCount: snapshot.report.uniqueRecipients,
    files: [] as CampaignExportOperation["files"],
  };
  await checkpoint({ cursor: 1, processed: 1, total: 5, result });
  for (const [index, format] of campaignExportFormats.entries()) {
    let file = await savedFile(row, index + 1);
    if (!file) {
      file = await renderCampaignReport(snapshot, format);
      await saveFile(row, token, index + 1, fileName(format), file);
    }
    result.files.push({ format, name: fileName(format), bytes: file.length });
    await checkpoint({
      cursor: index + 2,
      processed: index + 2,
      total: 5,
      status:
        index === campaignExportFormats.length - 1 ? "completed" : "running",
      result,
    });
  }
}
export async function resumeCampaignExport(id: string) {
  await resumeDashboardOperation(id, ["campaign_export"]);
  return getCampaignExport(id);
}
export async function downloadCampaignExport(
  id: string,
  format: CampaignExportFormat,
) {
  format = campaignExportFormatSchema.parse(format);
  const row = await ownedDashboardOperation(id, ["campaign_export"]);
  view(row);
  const ordinal = campaignExportFormats.indexOf(format) + 1,
    bytes = await savedFile(row, ordinal);
  if (!bytes)
    throw new DashboardOperationError(
      "This format is not ready. Check report progress and retry the download.",
      409,
    );
  return { bytes, name: fileName(format), type: campaignExportTypes[format] };
}
