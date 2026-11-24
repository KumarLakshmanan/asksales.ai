import type { Request, Response } from "express";
import {
  currentBusinessScope,
  isBusinessOwner,
} from "../tenancy/businessContext.js";
import {
  analysisJobView,
  getAnalysisJob,
  enqueueAnalysis,
  cancelAnalysis,
  normalizeSetupWebsiteUrl,
} from "../services/workspaceWebsiteAnalysisJobs.js";
import { logger } from "../utils/logger.js";
export async function setupAnalysisJob(req: Request, res: Response) {
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
  if (!currentBusinessScope())
    return res
      .status(409)
      .json({
        error: "Create and select a workspace before analyzing its website.",
      });
  if (!isBusinessOwner(req))
    return res
      .status(403)
      .json({
        error: "Only the workspace owner can analyze its website during setup.",
      });
  const id = req.params.jobId;
  if (id === "latest" && req.method !== "GET")
    return res.status(400).json({ error: "Select a specific analysis job." });
  if (
    id &&
    id !== "latest" &&
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)
  )
    return res.status(400).json({ error: "Invalid analysis job ID." });
  try {
    if (req.method === "GET") {
      let job = await getAnalysisJob(id === "latest" ? undefined : id);
      // Recover the insert/enqueue gap after an API restart. BullMQ's stable job ID prevents duplicates.
      if (job?.status === "queued")
        job = await enqueueAnalysis(
          String(job.url),
          Boolean(job.force_refresh),
          typeof job.idempotency_key === "string"
            ? job.idempotency_key
            : undefined,
        );
      if (!job && id !== "latest")
        return res.status(404).json({ error: "Analysis job not found." });
      return res.json({ job: job ? analysisJobView(job) : null });
    }
    if (req.method === "DELETE") {
      const job = await cancelAnalysis(id);
      return job
        ? res.json({ job: analysisJobView(job) })
        : res.status(404).json({ error: "Analysis job not found." });
    }
    if (id) {
      const previous = await getAnalysisJob(id);
      if (!previous)
        return res.status(404).json({ error: "Analysis job not found." });
      if (!["failed", "cancelled"].includes(String(previous.status)))
        return res
          .status(409)
          .json({ error: "Only failed or cancelled analyses can be retried." });
      const job = await enqueueAnalysis(
        String(previous.url),
        Boolean(previous.force_refresh),
      );
      return res.status(202).json({ job: analysisJobView(job) });
    }
    let url: string;
    try {
      url = normalizeSetupWebsiteUrl(req.body?.url);
    } catch {
      return res
        .status(400)
        .json({ error: "Enter a valid HTTP or HTTPS website URL." });
    }
    const key = req.body?.idempotencyKey;
    if (
      key !== undefined &&
      (typeof key !== "string" || !key.trim() || key.length > 100)
    )
      return res.status(400).json({ error: "Invalid request key." });
    if (
      req.body.forceRefresh !== undefined &&
      typeof req.body.forceRefresh !== "boolean"
    )
      return res.status(400).json({ error: "Invalid refresh option." });
    const job = await enqueueAnalysis(url, req.body.forceRefresh === true, key);
    return res.status(202).json({ job: analysisJobView(job) });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    logger.error(
      { err: error, event: "setup_analysis_request_failed" },
      "Analysis request failed",
    );
    return res
      .status(status)
      .json({
        error:
          status === 409 || status === 503
            ? (error as Error).message
            : "Unable to access website analysis. Please retry.",
      });
  }
}
