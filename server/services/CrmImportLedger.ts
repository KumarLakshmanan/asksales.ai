import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { crmContactImportsTable } from "../models/crmContactImports/schema.js";
import { crmContactImportDetailsTable } from "../models/crmContactImportDetails/schema.js";
import { requireBusinessScope } from "../tenancy/businessContext.js";

export const CRM_IMPORT_TERMINAL_STATUSES = [
  "success",
  "warning",
  "duplicate",
  "skipped",
  "failed",
] as const;

export class CrmImportInterruptedError extends Error {
  constructor(public readonly importId: number) {
    super(
      "Import interrupted. Resubmit the same file and mapping to resume committed row receipts.",
    );
  }
}

/** Counters are written atomically by saveCrmImportReceipt. Read them without
 * recounting every successful row after each checkpoint. Only warnings and a
 * bounded issue preview use their dedicated partial indexes. */
export async function readCrmImportProgress(userId:number,importId:number) {
  const {businessProfileId:business}=requireBusinessScope();
  const result=await db.execute(sql`SELECT batch.id AS "importId",batch.total_records AS "totalRecords",batch.import_status AS "importStatus",
    COALESCE(batch.success_count,0)::int AS "successCount",
    (batch.processed_records-COALESCE(batch.success_count,0)-COALESCE(batch.error_count,0)-COALESCE(batch.skipped_count,0))::int AS "duplicateCount",
    COALESCE(batch.skipped_count,0)::int AS "skippedCount",COALESCE(batch.error_count,0)::int AS "errorCount",
    (SELECT count(*)::int FROM crm_contact_import_details warning WHERE warning.import_id=batch.id
      AND warning.business_profile_id=batch.business_profile_id AND warning.status='warning') AS "warningCount",
    batch.processed_records::int AS "processedRecords",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('row',issue.row_number,'type',CASE WHEN issue.status IN('failed','blocked') THEN 'error' ELSE issue.status END,'message',issue.error_message) ORDER BY issue.row_number)
      FROM (SELECT row_number,status,error_message FROM crm_contact_import_details WHERE import_id=batch.id AND business_profile_id=batch.business_profile_id
        AND status IN('warning','duplicate','skipped','failed','blocked') AND error_message IS NOT NULL ORDER BY row_number LIMIT 20) issue),'[]'::jsonb) AS issues
    FROM crm_contact_imports batch
    WHERE batch.id=${importId} AND batch.user_id=${userId} AND batch.business_profile_id=${business}`);
  const row=result.rows[0];
  if(!row) throw new CrmImportInterruptedError(importId);
  return {importId:Number(row.importId),totalRecords:Number(row.totalRecords),successCount:Number(row.successCount),duplicateCount:Number(row.duplicateCount),
    skippedCount:Number(row.skippedCount),errorCount:Number(row.errorCount),warningCount:Number(row.warningCount),processedRecords:Number(row.processedRecords),
    importStatus:Number(row.processedRecords)>=Number(row.totalRecords) ? 'completed' : String(row.importStatus),issues:row.issues as Array<{row:number;type:'warning'|'error'|'duplicate'|'skipped';message:string}>};
}
export async function beginCrmImport(
  userId: number,
  rows: Array<Record<string, string>>,
  mapping: Record<string, string>,
  fileName: string,
  updateExisting = false,
) {
  const profile = requireBusinessScope();
  if (profile.userId !== userId)
    throw new Error("Import owner does not match business scope");
  const sorted = (value: Record<string, unknown>) =>
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([rows.map(sorted), sorted(mapping), updateExisting]))
    .digest("hex");
  return db.transaction(async (tx: typeof db) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('crm-import-identity'),${userId})`,
    );
    const [prior] = await tx
      .select()
      .from(crmContactImportsTable)
      .where(
        and(
          eq(crmContactImportsTable.userId, userId),
          eq(
            crmContactImportsTable.businessProfileId,
            profile.businessProfileId,
          ),
          eq(crmContactImportsTable.requestFingerprint, fingerprint),
        ),
      )
      .limit(1);
    if (prior) return prior;
    const [record] = await tx
      .insert(crmContactImportsTable)
      .values({
        userId,
        businessProfileId: profile.businessProfileId,
        fileName,
        totalRecords: rows.length,
        columnMapping: mapping,
        requestFingerprint: fingerprint,
        processedRecords: 0,
        importStatus: "processing",
        uploadedAt: new Date(),
      })
      .returning();
    return record;
  });
}
export async function importRowCommitted(
  tx: typeof db,
  importId: number,
  rowNumber: number,
): Promise<boolean> {
  const rows = await tx.execute(
    sql`SELECT status FROM crm_contact_import_details WHERE import_id=${importId} AND row_number=${rowNumber}`,
  );
  return rows.rows.some((row: { status: string }) =>
    CRM_IMPORT_TERMINAL_STATUSES.some((status) => status === row.status),
  );
}
/** The caller holds the shared CRM resolution lock. Receipt and progress commit
 * with the contact/lead effect; no finalization-only update is needed. */
export async function saveCrmImportReceipt(
  tx: typeof db,
  values: typeof crmContactImportDetailsTable.$inferInsert,
) {
  await tx.execute(
    sql`DELETE FROM crm_contact_import_details WHERE import_id=${values.importId} AND row_number=${values.rowNumber} AND status='blocked'`,
  );
  await tx.insert(crmContactImportDetailsTable).values(values);
  if (values.status === "blocked") {
    await tx.execute(
      sql`UPDATE crm_contact_imports SET import_status='failed' WHERE id=${values.importId}`,
    );
    return;
  }
  await tx.execute(sql`UPDATE crm_contact_imports SET
    success_count=COALESCE(success_count,0)+${["success", "warning"].includes(values.status || "") ? 1 : 0},
    error_count=COALESCE(error_count,0)+${values.status === "failed" ? 1 : 0},
    skipped_count=COALESCE(skipped_count,0)+${values.status === "skipped" ? 1 : 0},
    processed_records=processed_records+1,
    import_status=CASE WHEN processed_records+1>=total_records THEN 'completed' ELSE 'processing' END,
    completed_at=CASE WHEN processed_records+1>=total_records THEN NOW() ELSE NULL END,
    error_summary=CASE WHEN ${values.status === "failed"} THEN COALESCE(error_summary,'[]'::jsonb)||
      jsonb_build_array(jsonb_build_object('row',${values.rowNumber}::integer,'error',${values.errorMessage || "Row rejected"}::text)) ELSE error_summary END
    WHERE id=${values.importId}`);
}
