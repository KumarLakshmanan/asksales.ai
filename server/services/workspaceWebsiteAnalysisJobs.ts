import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../models/db.js";
import { requireBusinessScope } from "../tenancy/businessContext.js";
import { queueRegistry, QUEUE_NAMES } from "../queues/index.js";
import {
  SetupAnalysisCancelled,
  withSetupAnalysisProgress,
} from "./setupAnalysisProgress.js";
import { logger } from "../utils/logger.js";

export function analysisJobView(row: Record<string, unknown>) {
  return {
    id: row.id,
    url: row.url,
    status: row.status,
    stage: row.stage,
    detail: row.detail,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    progress: row.progress ?? {},
    result: row.result ?? undefined,
    error: row.error ?? undefined,
  };
}
export async function getAnalysisJob(id?: string) {
  const { userId, businessProfileId } = requireBusinessScope();
  const result =
    await db.execute(sql`SELECT * FROM workspace_website_analysis_jobs WHERE user_id=${userId} AND business_profile_id=${businessProfileId}
    ${id ? sql`AND id=${id}::uuid` : sql``} ORDER BY created_at DESC LIMIT 1`);
  return result.rows[0] as Record<string, unknown> | undefined;
}
export function normalizeSetupWebsiteUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4096 || !value.trim())
    throw new Error("Enter a valid website URL.");
  if (value.includes("://") && !/^https?:\/\//i.test(value.trim()))
    throw new Error("Only HTTP and HTTPS website URLs are supported.");
  const parsed = new URL(
    /^https?:\/\//i.test(value.trim())
      ? value.trim()
      : `https://${value.trim()}`,
  );
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Enter a valid public HTTP or HTTPS website URL.");
  parsed.hash = "";
  return parsed.href;
}
export async function enqueueAnalysis(
  url: string,
  forceRefresh = false,
  idempotencyKey?: string,
) {
  const { userId, businessProfileId } = requireBusinessScope();
  const row = await db.transaction(async (tx: typeof db) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(740320,${businessProfileId})`,
    );
    // A request receipt wins over a newer active job. Every key accepted while
    // coalescing stays attached to that original job after it becomes terminal.
    const receipt = idempotencyKey
      ? await tx.execute(sql`SELECT * FROM workspace_website_analysis_jobs
        WHERE user_id=${userId} AND business_profile_id=${businessProfileId}
        AND (idempotency_key=${idempotencyKey} OR accepted_request_keys @> ARRAY[${idempotencyKey}]::text[])
        ORDER BY created_at DESC LIMIT 1`)
      : { rows: [] };
    const existing = receipt.rows[0] ? receipt
      : await tx.execute(sql`SELECT * FROM workspace_website_analysis_jobs WHERE user_id=${userId} AND business_profile_id=${businessProfileId}
        AND status IN('queued','running') ORDER BY created_at DESC LIMIT 1`);
    if (existing.rows[0]) {
      if (
        existing.rows[0].url !== url ||
        existing.rows[0].force_refresh !== forceRefresh
      )
        throw Object.assign(
          new Error(
            "A different analysis is already running, or this request key belongs to another website. Cancel the running analysis or use a new request key.",
          ),
          { status: 409 },
        );
      if (idempotencyKey && !receipt.rows[0]) {
        await tx.execute(sql`UPDATE workspace_website_analysis_jobs
          SET accepted_request_keys=array_append(accepted_request_keys,${idempotencyKey})
          WHERE id=${existing.rows[0].id}::uuid AND user_id=${userId} AND business_profile_id=${businessProfileId}`);
      }
      return existing.rows[0];
    }
    const created =
      await tx.execute(sql`INSERT INTO workspace_website_analysis_jobs(id,user_id,business_profile_id,url,force_refresh,idempotency_key,accepted_request_keys,status)
      VALUES(${randomUUID()}::uuid,${userId},${businessProfileId},${url},${forceRefresh},${idempotencyKey ?? null},${idempotencyKey ? sql`ARRAY[${idempotencyKey}]::text[]` : sql`ARRAY[]::text[]`},'queued') RETURNING *`);
    return created.rows[0];
  });
  if (row.status === "queued") {
    try {
      await queueRegistry.initialize();
      await queueRegistry.addJob(
        QUEUE_NAMES.GENERAL,
        "workspace-website-analysis",
        {
          userId,
          businessProfileId,
          type: "workspace-website-analysis",
          analysisJobId: row.id,
          createdAt: new Date().toISOString(),
        },
        {
          jobId: row.id,
          attempts: 3,
          backoff: { type: "exponential", delay: 3000 },
          removeOnComplete: { age: 86400 },
          removeOnFail: { age: 604800 },
        },
      );
    } catch (error) {
      await db.execute(sql`UPDATE workspace_website_analysis_jobs SET status='failed',stage='failed',error='Website analysis could not be queued. Please retry.',updated_at=now()
        WHERE id=${row.id}::uuid AND user_id=${userId} AND business_profile_id=${businessProfileId} AND status='queued'`);
      logger.error(
        { err: error, jobId: row.id, event: "setup_analysis_enqueue_failed" },
        "Website analysis queue failed",
      );
      throw Object.assign(
        new Error("Website analysis could not be queued. Please retry."),
        { status: 503 },
      );
    }
  }
  return row;
}
export async function cancelAnalysis(id: string) {
  const { userId, businessProfileId } = requireBusinessScope();
  const result = await db.transaction(async (tx: typeof db) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(740322,${businessProfileId})`,
    );
    return tx.execute(sql`UPDATE workspace_website_analysis_jobs SET status='cancelled',stage='cancelled',detail='Analysis cancelled',updated_at=now()
    WHERE id=${id}::uuid AND user_id=${userId} AND business_profile_id=${businessProfileId} AND status IN('queued','running') RETURNING *`);
  });
  return result.rows[0] ?? getAnalysisJob(id);
}
/** Executed only by the standalone BullMQ worker. Progress/checkpoints are durable. */
export async function processWorkspaceWebsiteAnalysis(job: {
  data: Record<string, unknown>;
  attemptsMade?: number;
  opts?: { attempts?: number };
}) {
  const id = String(job.data.analysisJobId),
    scope = requireBusinessScope();
  const row = await getAnalysisJob(id);
  if (!row || ["cancelled", "completed", "failed"].includes(String(row.status)))
    return;
  await db.execute(sql`UPDATE workspace_website_analysis_jobs SET status='running',error=NULL,updated_at=now() WHERE id=${id}::uuid
    AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND status IN('queued','running')`);
  let response: Record<string, unknown> = {};
  let status = 200;
  const capture = {
    status: (code: number) => {
      status = code;
      return capture;
    },
    json: (body: Record<string, unknown>) => {
      response = body;
      return capture;
    },
  };
  try {
    const { analyzeWebsite } =
      await import("../controllers/setupController.js");
    await withSetupAnalysisProgress(
      async (stage, detail, extra) => {
        const updated =
          await db.execute(sql`UPDATE workspace_website_analysis_jobs SET stage=${stage},detail=${detail},progress=progress || ${JSON.stringify(extra ?? {})}::jsonb,updated_at=now()
        WHERE id=${id}::uuid AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND status='running' RETURNING id`);
        if (!updated.rows[0])
          throw new SetupAnalysisCancelled("Analysis cancelled");
      },
      () =>
        analyzeWebsite(
          {
            user: { id: scope.actorUserId ?? scope.userId },
            body: { url: row.url, forceRefresh: row.force_refresh },
          } as Request,
          capture as unknown as Response,
        ),
      async (work) =>
        db.transaction(async (tx: typeof db) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(740322,${scope.businessProfileId})`,
          );
          const latest = await tx.execute(
            sql`SELECT status FROM workspace_website_analysis_jobs WHERE id=${id}::uuid AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}`,
          );
          if (latest.rows[0]?.status !== "running")
            throw new SetupAnalysisCancelled("Analysis cancelled");
          return work(tx);
        }),
    );
    if (status >= 400 || response.success !== true)
      throw new Error(String(response.error ?? "Website analysis failed."));
    const completed = await db.execute(sql`UPDATE workspace_website_analysis_jobs SET status='completed',stage='complete',detail='Analysis complete',result=${JSON.stringify(response)}::jsonb,error=NULL,updated_at=now()
      WHERE id=${id}::uuid AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND status='running'`);
    if (!completed.rowCount) return;
    logger.info(
      {
        jobId: id,
        businessProfileId: scope.businessProfileId,
        event: "setup_analysis_completed",
      },
      "Website analysis completed",
    );
  } catch (error) {
    const latest = await getAnalysisJob(id);
    if (
      latest?.status === "cancelled" ||
      error instanceof SetupAnalysisCancelled
    )
      return;
    const terminal = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
    await db.execute(sql`UPDATE workspace_website_analysis_jobs SET status=${terminal ? "failed" : "queued"},stage=${terminal ? "failed" : "retrying"},
      detail=${terminal ? "Analysis needs a retry" : "Retrying interrupted analysis"},error='Website analysis was interrupted. Retry or enter your details manually.',updated_at=now()
      WHERE id=${id}::uuid AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND status<>'cancelled'`);
    throw error;
  }
}
