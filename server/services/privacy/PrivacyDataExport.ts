import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../../models/db.js";
import { withSystemScope } from "../../tenancy/businessContext.js";

export interface ExportSection {
  table: string;
  columns: string[];
  parent?: { table: string; foreignKey: string };
}
const section = (
  table: string,
  columns: string,
  parent?: ExportSection["parent"],
): ExportSection => ({ table, columns: columns.split(" "), parent });
/** Reviewed projections only. New model columns never enter an export implicitly. */
export const PRIVACY_EXPORT_SECTIONS: readonly ExportSection[] = [
  section(
    "users",
    "id email name avatar bio phone timezone notification_preferences created_at updated_at deleted_at",
  ),
  section(
    "user_consents",
    "id user_id consent_type granted reason ip_address user_agent created_at",
  ),
  section(
    "company_settings",
    "id user_id name company_name industry website phone email address city state country postal_code description archived_at created_at updated_at",
  ),
  section(
    "leads",
    "id user_id business_profile_id name first_name last_name email phone company role website status source created_at updated_at deleted_at",
  ),
  section(
    "crm_contacts",
    "id user_id business_profile_id lead_id first_name last_name email phone company role status pipeline_status tags notes deal_value currency created_at updated_at deleted_at",
  ),
  section(
    "crm_activities",
    "id user_id business_profile_id contact_id type subject body due_at completed_at created_at updated_at",
  ),
  section(
    "crm_contact_imports",
    "id user_id business_profile_id file_name total_records success_count error_count skipped_count import_status uploaded_at completed_at created_at",
  ),
  section(
    "crm_contact_import_details",
    "id business_profile_id import_id row_number status created_contact_id created_at",
    { table: "crm_contact_imports", foreignKey: "import_id" },
  ),
  section(
    "campaign_lead_imports",
    "id user_id business_profile_id thread_id file_name total_records created_at",
  ),
  section(
    "campaign_lead_import_members",
    "id user_id business_profile_id import_id lead_id recipient_lead_id contact_id",
  ),
  section(
    "chat_threads",
    "id user_id business_profile_id title selected_agent created_at updated_at deleted_at",
  ),
  section(
    "chat_messages",
    "id user_id business_profile_id thread_id role content created_at deleted_at",
  ),
  section(
    "outreach_conversations",
    "id user_id business_profile_id lead_id crm_contact_id channel subject status created_at updated_at",
  ),
  section(
    "outreach_messages",
    "id business_profile_id conversation_id direction subject redacted_content status created_at",
    { table: "outreach_conversations", foreignKey: "conversation_id" },
  ),
  section(
    "support_tickets",
    "id user_id business_profile_id contact_id ticket_number subject description status priority created_at updated_at deleted_at",
  ),
  section(
    "storage_files",
    "id user_id business_profile_id file_name original_name mime_type file_size_bytes category is_deleted deleted_at created_at updated_at",
  ),
];
export const PRIVACY_EXPORT_EXCLUSIONS = [
  "Authentication, verification, reset and webhook secrets and security internals.",
  "Provider credentials, tokens, payment instruments and integration configuration.",
  "Restricted privacy-vault originals; this export does not grant reveal authorization.",
  "Raw import payloads, arbitrary JSON metadata and provider error payloads.",
  "Stored binary objects; storage_files contains metadata only.",
  "Tables and fields outside the declared reviewed sections; this is not a full account backup.",
];
export interface PreparedPrivacyExport {
  path: string;
  bytes: number;
  dispose: () => Promise<void>;
}

/** Build completely before sending headers. A failed query produces no downloadable
 * partial success; the private temporary artifact is removed on every failure. */
export async function preparePrivacyExport(
  userId: number,
  signal?: AbortSignal,
  database: typeof db = db,
  sections: readonly ExportSection[] = PRIVACY_EXPORT_SECTIONS,
): Promise<PreparedPrivacyExport> {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new Error("Account identity required");
  if (signal?.aborted) throw new Error("Export cancelled");
  const directory = await mkdtemp(join(tmpdir(), "privacy-export-"));
  const path = join(directory, "export.ndjson");
  const dispose = () => rm(directory, { recursive: true, force: true });
  const file = await open(path, "wx", 0o600).catch(async (error) => {
    await dispose();
    throw error;
  });
  let bytes = 0,
    totalRows = 0;
  const digest = createHash("sha256");
  const counts: Record<string, number> = {};
  const check = () => {
    if (signal?.aborted) throw new Error("Export cancelled");
  };
  const write = async (value: unknown, hashed = true) => {
    check();
    const line = JSON.stringify(value) + "\n";
    bytes += Buffer.byteLength(line);
    if (bytes > 100 * 1024 * 1024)
      throw new Error("Export exceeds the 100 MiB limit");
    if (hashed) digest.update(line);
    await file.writeFile(line);
  };
  try {
    await withSystemScope("Prepare account owner data export", () =>
      database.transaction(
        async (tx: typeof db) => {
          for (const item of sections) {
            let lastId = 0;
            counts[item.table] = 0;
            while (true) {
              check();
              const owner: SQL =
                item.table === "users"
                  ? sql`r.id=${userId}`
                  : item.parent
                    ? sql`EXISTS (SELECT 1 FROM ${sql.identifier(item.parent.table)} p WHERE p.id=r.${sql.identifier(item.parent.foreignKey)}
                AND p.user_id=${userId} AND p.business_profile_id IS NOT DISTINCT FROM r.business_profile_id)`
                    : sql`r.user_id=${userId}`;
              const result = await tx.execute(sql`SELECT ${sql.join(
                item.columns.map((column) => sql`r.${sql.identifier(column)}`),
                sql`, `,
              )}
            FROM ${sql.identifier(item.table)} r WHERE ${owner} AND r.id>${lastId} ORDER BY r.id LIMIT 250`);
              for (const row of result.rows as Array<Record<string, unknown>>) {
                if (++totalRows > 100_000)
                  throw new Error("Export exceeds the 100,000 row limit");
                await write({ table: item.table, data: row });
                counts[item.table]++;
                lastId = Number(row.id);
              }
              if (result.rows.length < 250) break;
            }
          }
        },
        { isolationLevel: "repeatable read", readOnly: true },
      ),
    );
    await write(
      {
        table: "export_manifest",
        data: {
          version: 2,
          status: "completed",
          inventoryComplete: false,
          coverage: "declared_sections_only",
          userId,
          sections: sections.map((item) => ({
            table: item.table,
            columns: item.columns,
          })),
          counts,
          totalRows,
          exclusions: PRIVACY_EXPORT_EXCLUSIONS,
          recordsSha256: digest.digest("hex"),
        },
      },
      false,
    );
    await file.close();
    return { path, bytes, dispose };
  } catch (error) {
    await file.close().catch(() => {});
    await dispose();
    throw error;
  }
}
