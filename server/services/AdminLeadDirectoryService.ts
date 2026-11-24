import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "../models/db.js";
import { leadsTable } from "../models/leads/schema.js";
import { usersTable } from "../models/users/schema.js";
import type { AdminLeadDirectoryResponse } from "../../shared/adminLeadDirectory.js";

export interface AdminLeadListFilter {
  page?: number;
  pageSize?: number;
  userId?: number;
  status?: string;
  source?: string;
  search?: string;
  minScore?: number;
  maxScore?: number;
  sortBy?: string;
}
const SORTS = [
  "created_at_desc",
  "created_at_asc",
  "score_desc",
  "score_asc",
  "name_asc",
  "name_desc",
];
function badQuery(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}
export function parseAdminLeadFilters(
  query: Record<string, unknown>,
): AdminLeadListFilter {
  const integer = (
    key: string,
    fallback?: number,
    min = 1,
    max = Number.MAX_SAFE_INTEGER,
  ) => {
    if (query[key] === undefined || query[key] === "") return fallback;
    if (typeof query[key] !== "string" || !/^\d+$/.test(query[key] as string))
      return badQuery(`Invalid ${key}`);
    const value = Number(query[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      return badQuery(`Invalid ${key}`);
    return value;
  };
  const text = (key: string, max = 255) => {
    if (query[key] === undefined || query[key] === "") return undefined;
    if (typeof query[key] !== "string" || (query[key] as string).length > max)
      return badQuery(`Invalid ${key}`);
    const value = (query[key] as string).trim();
    return value && !((key === "status" || key === "source") && value === "all")
      ? value
      : undefined;
  };
  const filter: AdminLeadListFilter = {
    page: integer("page", 1),
    pageSize: integer("pageSize", 20, 1, 200),
    userId: integer("userId"),
    status: text("status"),
    source: text("source"),
    search: text("search"),
    minScore: integer("minScore", undefined, 0, 100),
    maxScore: integer("maxScore", undefined, 0, 100),
    sortBy: text("sortBy") || "created_at_desc",
  };
  if (!SORTS.includes(filter.sortBy!)) badQuery("Invalid sortBy");
  if ((filter.minScore ?? 0) > (filter.maxScore ?? 100))
    badQuery("Invalid score range");
  return filter;
}
export function adminLeadPredicates(filter: AdminLeadListFilter): SQL[] {
  const conditions = [isNull(leadsTable.deletedAt)];
  if (filter.userId !== undefined)
    conditions.push(eq(leadsTable.userId, filter.userId));
  if (filter.status) conditions.push(eq(leadsTable.status, filter.status));
  if (filter.source) conditions.push(eq(leadsTable.source, filter.source));
  if (filter.minScore !== undefined)
    conditions.push(gte(leadsTable.score, filter.minScore));
  if (filter.maxScore !== undefined)
    conditions.push(lte(leadsTable.score, filter.maxScore));
  if (filter.search) {
    const pattern = `%${filter.search.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(
      or(
        ...[
          leadsTable.name,
          leadsTable.firstName,
          leadsTable.lastName,
          leadsTable.email,
          leadsTable.company,
          leadsTable.companyName,
          leadsTable.role,
        ].map((column) => ilike(column, pattern)),
      )!,
    );
  }
  return conditions;
}
function selectLeads(
  database: Pick<NodePgDatabase, "select">,
  filter: AdminLeadListFilter,
) {
  const column = filter.sortBy?.startsWith("score")
    ? leadsTable.score
    : filter.sortBy?.startsWith("name")
      ? sql`coalesce(${leadsTable.name}, concat_ws(' ', ${leadsTable.firstName}, ${leadsTable.lastName}))`
      : leadsTable.createdAt;
  const order = filter.sortBy?.endsWith("_asc") ? asc(column) : desc(column);
  return database
    .select({
      id: leadsTable.id,
      userId: leadsTable.userId,
      name: leadsTable.name,
      firstName: leadsTable.firstName,
      lastName: leadsTable.lastName,
      email: leadsTable.email,
      phone: leadsTable.phone,
      company: leadsTable.company,
      companyName: leadsTable.companyName,
      jobTitle: leadsTable.role,
      source: leadsTable.source,
      status: leadsTable.status,
      score: leadsTable.score,
      createdAt: leadsTable.createdAt,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
    .from(leadsTable)
    .leftJoin(usersTable, eq(leadsTable.userId, usersTable.id))
    .where(and(...adminLeadPredicates(filter)))
    .orderBy(order, desc(leadsTable.id));
}
export async function listAdminLeads(
  filter: AdminLeadListFilter,
): Promise<AdminLeadDirectoryResponse> {
  const pageSize = filter.pageSize ?? 20;
  return db.transaction(
    async (tx: Pick<NodePgDatabase, "select" | "selectDistinct">) => {
      const [summary] = await tx
        .select({
          totalLeads: count(),
          active: sql<number>`count(*) filter (where ${leadsTable.status} in ('active', 'new', 'contacted'))::int`,
          converted: sql<number>`count(*) filter (where ${leadsTable.status} = 'converted')::int`,
          qualified: sql<number>`count(*) filter (where ${leadsTable.status} = 'qualified' or ${leadsTable.score} >= 70)::int`,
          contacted: sql<number>`count(*) filter (where ${leadsTable.status} = 'contacted')::int`,
        })
        .from(leadsTable)
        .where(and(...adminLeadPredicates(filter)));
      const total = Number(summary.totalLeads);
      const totalPages = Math.ceil(total / pageSize);
      const page = Math.min(filter.page ?? 1, Math.max(totalPages, 1));
      const items = await selectLeads(tx, filter)
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const statuses = await tx
        .selectDistinct({ value: leadsTable.status })
        .from(leadsTable)
        .where(isNull(leadsTable.deletedAt))
        .orderBy(asc(leadsTable.status));
      const sources = await tx
        .selectDistinct({ value: leadsTable.source })
        .from(leadsTable)
        .where(isNull(leadsTable.deletedAt))
        .orderBy(asc(leadsTable.source));
      return {
        items,
        pagination: { total, page, pageSize, totalPages },
        stats: {
          ...summary,
          totalLeads: total,
          conversionRate: total
            ? Math.round((Number(summary.converted) / total) * 100)
            : 0,
        },
        filters: {
          statuses: statuses.map((row) => row.value),
          sources: sources.map((row) => row.value),
        },
      };
    },
    { isolationLevel: "repeatable read", readOnly: true },
  );
}
// Escape CSV syntax and neutralize spreadsheet formulas in user-controlled fields.
export function adminLeadCsvCell(value: unknown): string {
  let text = value instanceof Date ? value.toISOString() : String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
const CSV_FIELDS = [
  "id",
  "name",
  "firstName",
  "lastName",
  "email",
  "phone",
  "company",
  "companyName",
  "jobTitle",
  "status",
  "source",
  "score",
  "userId",
  "userName",
  "userEmail",
  "createdAt",
] as const;
export async function exportAdminLeads(
  filter: AdminLeadListFilter,
  write: (chunk: string) => Promise<void>,
): Promise<void> {
  await db.transaction(
    async (tx: Pick<NodePgDatabase, "select">) => {
      await write(CSV_FIELDS.join(",") + "\r\n");
      let offset = 0;
      while (true) {
        const batch = await selectLeads(tx, filter).limit(1000).offset(offset);
        if (!batch.length) break;
        await write(
          batch
            .map((row) =>
              CSV_FIELDS.map((field) => adminLeadCsvCell(row[field])).join(","),
            )
            .join("\r\n") + "\r\n",
        );
        offset += batch.length;
        if (batch.length < 1000) break;
      }
    },
    { isolationLevel: "repeatable read", readOnly: true },
  );
}
