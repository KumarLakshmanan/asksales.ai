import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../models/db.js";
import {
  businessAuditActor,
  currentBusinessScope,
} from "../tenancy/businessContext.js";
import { storageService } from "./StorageService.js";
import { lockManagedStorageReferences } from "./storageReferenceLocks.js";
import type { StorageFileRecord } from "../models/storageFiles/schema.js";
import { createHash } from "node:crypto";
import type { FileCategory } from "./StorageService.js";

export const RETENTION_DAYS = 30;
export const storageQuerySchema = z
  .object({
    view: z.enum(["files", "trash", "cleanup", "activity"]).default("files"),
    category: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,99}$/)
      .optional(),
    search: z.string().max(255).default(""),
    sort: z.enum(["newest", "oldest", "name", "size"]).default("newest"),
    type: z.enum(["all", "image", "video", "audio", "document"]).default("all"),
    after: z.string().date().optional(),
    before: z.string().date().optional(),
    minSize: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    maxSize: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    folder: z.string().min(1).max(950).optional(),
    tag: z.string().min(1).max(40).optional(),
    collection: z.string().min(1).max(80).optional(),
    cleanup: z.enum(["large", "old", "unlinked"]).default("large"),
    cursor: z.string().max(1500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine(
    (q) => !q.after || !q.before || q.after <= q.before,
    "Start date must precede end date",
  )
  .refine(
    (q) =>
      q.minSize === undefined ||
      q.maxSize === undefined ||
      q.minSize <= q.maxSize,
    "Minimum size must not exceed maximum size",
  );
export type StorageQuery = z.infer<typeof storageQuerySchema>;
export const storageMutationSchema = z
  .object({
    action: z.enum(["trash", "restore", "purge", "organize", "rename"]),
    fileIds: z.array(z.number().int().positive()).min(1).max(200),
    acknowledgeReferences: z.boolean().default(false),
    tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    collection: z.string().trim().max(80).optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      // eslint-disable-next-line no-control-regex -- Names cannot contain control characters or path separators.
      .regex(/^[^\x00-\x1f\x7f/\\]+$/)
      .optional(),
  })
  .refine(
    (m) => m.action !== "rename" || (m.fileIds.length === 1 && !!m.name),
    "Rename requires one file and a name",
  );
export type StorageMutation = z.infer<typeof storageMutationSchema>;
type WorkspaceMetadata = {
  trashedAt?: string;
  tags?: string[];
  collection?: string;
  events?: Array<{ action: string; at: string; actorUserId: number }>;
};
export class StorageWorkspaceError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "StorageWorkspaceError";
  }
}
export function workspaceMetadata(file: StorageFileRecord): WorkspaceMetadata {
  return (file.metadata?.storageWorkspace || {}) as WorkspaceMetadata;
}
export function fileSource(file: StorageFileRecord) {
  const reference = file.referenceType;
  const id = file.referenceId;
  const numericId = id && /^\d+$/.test(id) ? id : null;
  const sources: Record<string, { label: string; href: string }> = {
    chat_thread: {
      label: "Campaign conversation",
      href: numericId
        ? `/dashboard/conversations/${numericId}`
        : "/dashboard/chats",
    },
    knowledge_base: {
      label: "Knowledge base",
      href: numericId
        ? `/dashboard/knowledge-base/${numericId}`
        : "/dashboard/knowledge-base/documents",
    },
    brand_toolkit_image: {
      label: "Brand toolkit",
      href: "/dashboard/brand-toolkit",
    },
    brand_toolkit_logo: {
      label: "Brand toolkit",
      href: "/dashboard/brand-toolkit",
    },
    content_asset: {
      label: "Content library",
      href: "/dashboard/saved-templates",
    },
    content: { label: "Generated content", href: "/dashboard/saved-templates" },
    media_generation: {
      label: "Generated media",
      href: "/dashboard/saved-templates",
    },
    support_media_gallery_version: {
      label: "Support media",
      href: "/dashboard/knowledge-base/media",
    },
  };
  return reference === "user_upload" || !reference
    ? null
    : sources[reference] || { label: reference.replace(/_/g, " "), href: null };
}
export function deletionDependency(file: StorageFileRecord) {
  // A missing reference is not proof that a published URL is unused.
  const linked = Boolean(
    file.referenceType && file.referenceType !== "user_upload",
  );
  const generated = [
    "brand_asset",
    "knowledge_base",
    "support_media",
    "content_asset",
    "image",
    "video",
    "actor_output",
  ].includes(file.category);
  return {
    linked,
    needsReview: linked || generated,
    message: linked
      ? "This file is linked to other work. Removing it may break that resource."
      : generated
        ? "This asset may be used by other work or a published link. Review it before removing it."
        : "No source link is recorded. This does not guarantee the file is unused.",
  };
}
const active = sql`metadata #>> '{storageWorkspace,trashedAt}' IS NULL`;
function ownerPredicate(userId: number) {
  const scope = currentBusinessScope();
  if (!scope || scope.userId !== userId)
    throw new StorageWorkspaceError(
      "Select a business profile to manage files.",
      400,
    );
  return sql`user_id = ${userId} AND business_profile_id = ${scope.businessProfileId}`;
}
function toFile(row: Record<string, unknown>): StorageFileRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    businessProfileId:
      row.business_profile_id == null ? null : Number(row.business_profile_id),
    fileName: String(row.file_name),
    originalName: row.original_name as string | null,
    storageKey: String(row.storage_key),
    storageBackend: String(row.storage_backend),
    mimeType: row.mime_type as string | null,
    fileSizeBytes: Number(row.file_size_bytes),
    category: String(row.category),
    referenceType: row.reference_type as string | null,
    referenceId: row.reference_id as string | null,
    url: row.url as string | null,
    metadata: (row.metadata || {}) as Record<string, unknown>,
    isDeleted: Boolean(row.is_deleted),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    deletedAt: row.deleted_at ? new Date(row.deleted_at as string) : null,
  };
}
export function publicFile(file: StorageFileRecord) {
  const workspace = workspaceMetadata(file);
  return {
    ...file,
    storageKey: file.category === "actor_output" ? file.storageKey : "",
    storageBackend: undefined,
    url: `/api/settings/storage/files/${file.id}/download?inline=true`,
    metadata: undefined,
    workspace: {
      ...workspace,
      uploadedByUserId:
        typeof file.metadata?.workspaceUploadedBy === "number"
          ? file.metadata.workspaceUploadedBy
          : null,
    },
    source: fileSource(file),
    dependency: deletionDependency(file),
  };
}
export function storagePredicates(userId: number, query: StorageQuery): SQL {
  const terms: SQL[] = [
    ownerPredicate(userId),
    sql`is_deleted = false`,
    query.view === "trash" ? sql`NOT (${active})` : active,
  ];
  if (query.category) terms.push(sql`category = ${query.category}`);
  if (query.search.trim()) {
    const pattern = `%${query.search.trim().replace(/[\\%_]/g, "\\$&")}%`;
    terms.push(
      sql`(original_name ILIKE ${pattern} OR file_name ILIKE ${pattern})`,
    );
  }
  if (query.folder)
    terms.push(
      sql`category = 'actor_output' AND regexp_replace(storage_key, '/[^/]*$', '') = ${`${userId}/actor_output/${query.folder}`}`,
    );
  if (query.type !== "all")
    terms.push(
      query.type === "document"
        ? sql`COALESCE(mime_type, '') !~ '^(image|video|audio)/'`
        : sql`mime_type LIKE ${`${query.type}/%`}`,
    );
  if (query.after) terms.push(sql`created_at >= ${query.after}::date`);
  if (query.before)
    terms.push(sql`created_at < ${query.before}::date + interval '1 day'`);
  if (query.minSize !== undefined)
    terms.push(sql`file_size_bytes >= ${query.minSize}`);
  if (query.maxSize !== undefined)
    terms.push(sql`file_size_bytes <= ${query.maxSize}`);
  if (query.tag)
    terms.push(
      sql`metadata #> '{storageWorkspace,tags}' @> ${JSON.stringify([query.tag])}::jsonb`,
    );
  if (query.collection)
    terms.push(
      sql`metadata #>> '{storageWorkspace,collection}' = ${query.collection}`,
    );
  if (query.view === "cleanup") {
    if (query.cleanup === "large")
      terms.push(sql`file_size_bytes >= ${5 * 1024 * 1024}`);
    if (query.cleanup === "old")
      terms.push(
        sql`created_at < CURRENT_TIMESTAMP - interval '90 days' AND category IN ('actor_output', 'image', 'video', 'content_asset')`,
      );
    if (query.cleanup === "unlinked")
      terms.push(sql`reference_type IS NULL OR reference_type = 'user_upload'`);
  }
  return sql`(${sql.join(
    terms.map((term) => sql`(${term})`),
    sql` AND `,
  )})`;
}
function sortExpression(sort: StorageQuery["sort"]) {
  return sort === "name"
    ? sql`lower(coalesce(original_name,file_name))`
    : sort === "size"
      ? sql`file_size_bytes`
      : sql`created_at`;
}
export async function listWorkspaceFiles(userId: number, query: StorageQuery) {
  const where = storagePredicates(userId, query),
    sort = sortExpression(query.sort);
  const ascending = ["oldest", "name"].includes(query.sort);
  const direction = ascending ? sql`ASC` : sql`DESC`;
  let cursorWhere = sql`true`;
  if (query.cursor) {
    let cursor: {
      sort: string;
      value: string | number;
      id: number;
      filter: string;
    };
    try {
      cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
    } catch {
      throw new StorageWorkspaceError("Invalid file cursor");
    }
    if (
      !cursor ||
      typeof cursor !== "object" ||
      cursor.sort !== query.sort ||
      !Number.isSafeInteger(cursor.id) ||
      cursor.id <= 0 ||
      !["string", "number"].includes(typeof cursor.value) ||
      cursor.filter !== cursorFilter(query)
    )
      throw new StorageWorkspaceError(
        "The filters changed. Reload the file list.",
      );
    if (
      (query.sort === "size" &&
        (!Number.isSafeInteger(cursor.value) || Number(cursor.value) < 0)) ||
      (query.sort === "name" && typeof cursor.value !== "string") ||
      (["newest", "oldest"].includes(query.sort) &&
        (typeof cursor.value !== "string" ||
          !Number.isFinite(Date.parse(cursor.value))))
    ) {
      throw new StorageWorkspaceError("Invalid file cursor");
    }
    const value = ["newest", "oldest"].includes(query.sort)
      ? sql`${cursor.value}::timestamptz`
      : sql`${cursor.value}`;
    cursorWhere = ascending
      ? sql`(${sort}, id) > (${value}, ${cursor.id})`
      : sql`(${sort}, id) < (${value}, ${cursor.id})`;
  }
  const total = await db.execute(
    sql`SELECT count(*)::int AS count FROM storage_files WHERE ${where}`,
  );
  const result =
    await db.execute(sql`SELECT *, lower(coalesce(original_name,file_name)) AS sort_name FROM storage_files WHERE ${where} AND ${cursorWhere}
    ORDER BY ${sort} ${direction}, id ${direction} LIMIT ${query.limit + 1}`);
  const more = result.rows.length > query.limit;
  const rows = result.rows.slice(0, query.limit) as Array<
      Record<string, unknown>
    >,
    last = rows.at(-1);
  const value = !last
    ? null
    : query.sort === "name"
      ? last.sort_name
      : query.sort === "size"
        ? Number(last.file_size_bytes)
        : new Date(last.created_at as string).toISOString();
  return {
    files: rows.map((row: Record<string, unknown>) => publicFile(toFile(row))),
    total: Number(total.rows[0]?.count || 0),
    nextCursor:
      more && last
        ? Buffer.from(
            JSON.stringify({
              sort: query.sort,
              value,
              id: last.id,
              filter: cursorFilter(query),
            }),
          ).toString("base64url")
        : null,
  };
}
function cursorFilter(query: StorageQuery) {
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex");
}
export async function workspaceFile(
  userId: number,
  id: number,
  includeTrash = false,
) {
  const result = await db.execute(
    sql`SELECT * FROM storage_files WHERE id = ${id} AND ${ownerPredicate(userId)} AND is_deleted = false ${includeTrash ? sql`` : sql`AND ${active}`} LIMIT 1`,
  );
  if (!result.rows[0]) throw new StorageWorkspaceError("File not found", 404);
  return toFile(result.rows[0]);
}
export async function workspaceOverview(userId: number) {
  const usage = await storageService.getUsageSummary(userId);
  const groups = await db.execute(
    sql`SELECT category, count(*)::int AS count, sum(file_size_bytes)::bigint AS bytes FROM storage_files WHERE ${ownerPredicate(userId)} AND is_deleted = false AND ${active} GROUP BY category ORDER BY sum(file_size_bytes) DESC`,
  );
  const summary =
    await db.execute(sql`SELECT count(*) FILTER (WHERE ${active})::int AS active_count, COALESCE(sum(file_size_bytes) FILTER (WHERE ${active}),0)::bigint AS active_bytes,
    count(*) FILTER (WHERE NOT (${active}))::int AS trash_count, COALESCE(sum(file_size_bytes) FILTER (WHERE NOT (${active})),0)::bigint AS trash_bytes
    FROM storage_files WHERE ${ownerPredicate(userId)} AND is_deleted = false`);
  const organization = await db.execute(
    sql`SELECT DISTINCT metadata #>> '{storageWorkspace,collection}' AS collection FROM storage_files WHERE ${ownerPredicate(userId)} AND is_deleted = false AND ${active} AND metadata #>> '{storageWorkspace,collection}' <> '' ORDER BY collection LIMIT 100`,
  );
  const profile = currentBusinessScope()?.businessProfileId;
  const name = profile
    ? await db.execute(
        sql`SELECT coalesce(nullif(company_name,''),nullif(business_name,''),nullif(name,''),'Selected business') AS name FROM company_settings WHERE id = ${profile} AND user_id = ${userId} LIMIT 1`,
      )
    : null;
  return {
    ...usage,
    businessName: name?.rows[0]?.name || "Selected business",
    breakdown: groups.rows.map(
      (r: { category: string; count: number; bytes: string }) => ({
        ...r,
        bytes: Number(r.bytes),
      }),
    ),
    activeCount: Number(summary.rows[0]?.active_count || 0),
    activeBytes: Number(summary.rows[0]?.active_bytes || 0),
    trashCount: Number(summary.rows[0]?.trash_count || 0),
    trashBytes: Number(summary.rows[0]?.trash_bytes || 0),
    collections: organization.rows.map(
      (r: { collection: string }) => r.collection,
    ),
    businessProfileId: currentBusinessScope()?.businessProfileId || null,
    scope: "selected_business",
    capacityScope: "organization",
    retentionDays: RETENTION_DAYS,
  };
}
export async function actorFolders(userId: number, search = "", offset = 0) {
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const result =
    await db.execute(sql`WITH runs AS (SELECT regexp_replace(storage_key, '/[^/]*$', '') AS key, count(*)::int AS count,
    sum(file_size_bytes)::bigint AS bytes, max(created_at) AS newest FROM storage_files
    WHERE ${ownerPredicate(userId)} AND is_deleted = false AND ${active} AND category = 'actor_output'
    AND storage_key LIKE ${`${userId}/actor_output/%/%`} GROUP BY regexp_replace(storage_key, '/[^/]*$', ''))
    SELECT *, count(*) OVER()::int AS total FROM runs WHERE key ILIKE ${pattern} ORDER BY newest DESC, key ASC LIMIT 50 OFFSET ${offset}`);
  return {
    folders: result.rows.map(
      (r: { key: string; count: number; bytes: string; newest: Date }) => ({
        folder: r.key.slice(`${userId}/actor_output/`.length),
        count: r.count,
        bytes: Number(r.bytes),
        newest: r.newest,
      }),
    ),
    total: Number(result.rows[0]?.total || 0),
  };
}
export async function storageActivity(userId: number, offset = 0) {
  const result = await db.execute(sql`WITH events AS (
    SELECT id, coalesce(original_name,file_name) AS name, created_at AS at, 'uploaded' AS action, (metadata->>'workspaceUploadedBy')::int AS actor_user_id FROM storage_files WHERE ${ownerPredicate(userId)}
    UNION ALL SELECT id, coalesce(original_name,file_name), (event->>'at')::timestamptz, event->>'action', (event->>'actorUserId')::int
    FROM storage_files, jsonb_array_elements(coalesce(metadata #> '{storageWorkspace,events}', '[]'::jsonb)) event WHERE ${ownerPredicate(userId)})
    SELECT *, count(*) OVER()::int AS total FROM events ORDER BY at DESC, id DESC LIMIT 50 OFFSET ${offset}`);
  return { events: result.rows, total: Number(result.rows[0]?.total || 0) };
}
export async function mutateWorkspace(
  userId: number,
  mutation: StorageMutation,
) {
  const ids = [...new Set(mutation.fileIds)];
  // Lock the full batch before any mutation: a stale or foreign ID never silently
  // turns an intended all-or-nothing operation into a partial one.
  await db.transaction(async (tx: typeof db) => {
    const business=currentBusinessScope();
    if(!business) throw new StorageWorkspaceError('Select a business profile to manage files.',400);
    await lockManagedStorageReferences(tx,{userId,businessProfileId:business.businessProfileId});
    const result = await tx.execute(
      sql`SELECT * FROM storage_files WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`,`,
      )}) AND ${ownerPredicate(userId)} AND is_deleted = false ORDER BY id FOR UPDATE`,
    );
    if (result.rows.length !== ids.length)
      throw new StorageWorkspaceError(
        "Some selected files are no longer available. Refresh and try again.",
        409,
      );
    for (const row of result.rows) {
      const file = toFile(row),
        meta = workspaceMetadata(file),
        trashed = !!meta.trashedAt;
      if (["restore", "purge"].includes(mutation.action) !== trashed)
        throw new StorageWorkspaceError(
          "The file state changed. Refresh and try again.",
          409,
        );
      if (
        mutation.action === "trash" &&
        deletionDependency(file).needsReview &&
        !mutation.acknowledgeReferences
      )
        throw new StorageWorkspaceError(
          "Review the related resources before moving these files to Trash.",
          409,
        );
      if (
        mutation.action === "restore" &&
        Date.parse(meta.trashedAt!) + RETENTION_DAYS * 86400000 <= Date.now()
      )
        throw new StorageWorkspaceError("The restore period has expired.", 409);
      const at = new Date().toISOString();
      if (mutation.action === "trash") meta.trashedAt = at;
      if (mutation.action === "restore") delete meta.trashedAt;
      if (mutation.action === "organize") {
        if (mutation.tags) meta.tags = [...new Set(mutation.tags)];
        if (mutation.collection !== undefined)
          meta.collection = mutation.collection;
      }
      meta.events = [
        ...(meta.events || []).slice(-99),
        {
          action:
            mutation.action === "purge" ? "purge_requested" : mutation.action,
          at,
          actorUserId: businessAuditActor(userId),
        },
      ];
      await tx.execute(sql`UPDATE storage_files SET metadata = ${JSON.stringify({ ...file.metadata, storageWorkspace: meta })}::jsonb,
        original_name = ${mutation.action === "rename" ? mutation.name! : file.originalName}, updated_at = CURRENT_TIMESTAMP WHERE id = ${file.id} AND ${ownerPredicate(userId)}`);
    }
  });
  let affected = ids.length;
  if (mutation.action === "purge") {
    // Object deletion uses the existing retryable cleanup ledger and quota path.
    affected = await storageService.deleteFiles(ids, userId, new Date(), 'trash_purge');
    if (affected !== ids.length)
      throw new StorageWorkspaceError(
        `${affected} files were removed. Refresh before retrying the remaining files.`,
        409,
      );
  }
  return { affected };
}

// Receipt transactions hold a database connection while StorageService performs
// its own quota/metadata transactions. Bound these holders so simultaneous
// retries cannot consume the whole primary pool and starve the upload itself.
let receiptSlots = 0;
const receiptWaiters: Array<() => void> = [];
async function withUploadReceiptSlot<T>(work: () => Promise<T>): Promise<T> {
  const poolSize = Number(process.env.DB_POOL_SIZE || 10);
  if (poolSize < 2)
    throw new StorageWorkspaceError(
      "Upload retry protection requires at least two database connections.",
      503,
    );
  const limit = Math.min(2, poolSize - 1);
  if (receiptSlots >= limit) {
    if (receiptWaiters.length >= 50)
      throw new StorageWorkspaceError("Uploads are busy. Retry shortly.", 429);
    await new Promise<void>((resolve) => receiptWaiters.push(resolve));
  } else receiptSlots++;
  try {
    return await work();
  } finally {
    const next = receiptWaiters.shift();
    if (next) next();
    else receiptSlots--;
  }
}

export async function uploadWorkspaceFile(
  userId: number,
  file: Express.Multer.File,
  category: FileCategory,
  requestId: string,
) {
  const digest = createHash("sha256").update(file.buffer).digest("hex");
  // Retrying an interrupted upload uses the same receipt and cannot duplicate
  // a committed file. The advisory lock is shared by all API instances.
  return withUploadReceiptSlot<ReturnType<typeof publicFile>>(() =>
    db.transaction(async (tx: typeof db) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${currentBusinessScope()?.businessProfileId}:${requestId}`}, 0))`,
      );
      const existing = await tx.execute(
        sql`SELECT * FROM storage_files WHERE ${ownerPredicate(userId)} AND metadata->>'workspaceUploadId' = ${requestId} LIMIT 1`,
      );
      if (existing.rows[0]) {
        const stored = toFile(existing.rows[0]);
        if (
          stored.metadata?.workspaceUploadDigest !== digest ||
          stored.originalName !== file.originalname
        )
          throw new StorageWorkspaceError(
            "This upload receipt belongs to another file.",
            409,
          );
        if (stored.isDeleted || workspaceMetadata(stored).trashedAt)
          throw new StorageWorkspaceError(
            "This upload was already removed. Choose it again to upload a new copy.",
            409,
          );
        return publicFile(stored);
      }
      const result = await storageService.upload(file.buffer, {
        userId,
        category,
        originalName: file.originalname,
        mimeType: file.mimetype,
        referenceType: "user_upload",
        metadata: {
          workspaceUploadId: requestId,
          workspaceUploadDigest: digest,
          workspaceUploadedBy: businessAuditActor(userId),
        },
      });
      return publicFile(await workspaceFile(userId, result.fileId));
    }),
  );
}
