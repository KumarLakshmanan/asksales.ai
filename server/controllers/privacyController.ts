/**
 * Privacy Controller (Phase 4.7 / SEC-009)
 * Endpoints for GDPR-style data subject rights:
 *   - POST /api/privacy/opt-out   — opt out of one or more outreach channels
 *   - POST /api/privacy/opt-in    — re-enable outreach channels
 *   - GET  /api/privacy/consents  — list current consent state
 *   - POST /api/privacy/data-export — request a copy of all PII (NDJSON stream)
 *
 * The opt-out writes a row to user_consents (audit trail) and marks leads as
 * do_not_contact = true. The data-export endpoint prepares a declared, reviewed subset of owned
 * data as versioned NDJSON so the request can be terminated early on large
 * datasets without OOM.
 */
import { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { logger } from "../utils/logger.js";
import { preparePrivacyExport } from '../services/privacy/PrivacyDataExport.js';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  createUserConsent,
  getLatestConsent,
  listConsentsForUser,
} from "../models/userConsents/functions.js";
import { db } from "../models/db.js";
import { leadsTable } from "../models/leads/schema.js";
import { optOutSchema, dataExportRequestSchema } from "../middleware/privacySchemas.js";
import { withSystemScope } from '../tenancy/businessContext.js';

function clientMeta(req: Request) {
  return {
    ipAddress: (req.ip ?? "").toString().slice(0, 64) || undefined,
    userAgent: (req.headers["user-agent"] ?? "").toString().slice(0, 500) || undefined,
  };
}

export const privacyController = {
  /**
   * POST /api/privacy/opt-out
   * Body: { channels: ["email","sms",...], reason?: "..." }
   */
  async optOut(req: Request, res: Response): Promise<Response> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id as number | undefined;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const parsed = optOutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid request", errors: parsed.error.flatten() });
    }

    const { channels, reason } = parsed.data;
    const allChannels = channels.includes("all");
    const channelsToDisable = allChannels
      ? ["email", "sms", "whatsapp", "instagram", "facebook"]
      : channels.filter((c) => c !== "all");

    try {
      // Start the transaction inside the existing account-wide scope. Audit
      // history must not claim success when the owned lead update rolls back.
      await withSystemScope('Account owner opted out across their businesses', () => db.transaction(async (tx: typeof db) => {
        await createUserConsent({ userId,
          consentType: allChannels ? "all_channels" : channels.join(","),
          granted: false, reason, ...clientMeta(req),
        }, tx);
        if (channelsToDisable.length > 0) await tx.update(leadsTable)
          .set({ doNotContact: true }).where(eq(leadsTable.userId, userId));
      }));

      logger.info({ userId, channels: channelsToDisable }, "[privacy] user opted out");
      return res.json({ success: true, channelsDisabled: channelsToDisable });
    } catch (err) {
      logger.error({ err, userId }, "[privacy] optOut failed");
      return res.status(500).json({ message: "Opt-out failed" });
    }
  },

  /**
   * POST /api/privacy/opt-in
   * Body: { channels: ["email","sms",...], reason?: "..." }
   */
  async optIn(req: Request, res: Response): Promise<Response> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id as number | undefined;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const parsed = optOutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid request", errors: parsed.error.flatten() });
    }
    const { channels, reason } = parsed.data;
    const allChannels = channels.includes("all");
    const channelsToEnable = allChannels
      ? ["email", "sms", "whatsapp", "instagram", "facebook"]
      : channels.filter((c) => c !== "all");

    try {
      await createUserConsent({
        userId,
        consentType: allChannels ? "all_channels" : channels.join(","),
        granted: true,
        reason,
        ...clientMeta(req),
      });
      // We don't auto-clear do_not_* flags on opt-in: a human-readable
      // confirmation is expected instead so the user is aware they're
      // re-subscribing.
      return res.json({ success: true, channelsEnabled: channelsToEnable, requiresConfirmation: true });
    } catch (err) {
      logger.error({ err, userId }, "[privacy] optIn failed");
      return res.status(500).json({ message: "Opt-in failed" });
    }
  },

  /**
   * GET /api/privacy/consents
   */
  async listConsents(req: Request, res: Response): Promise<Response> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id as number | undefined;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const rows = await listConsentsForUser(userId);
    return res.json({ consents: rows });
  },

  /**
   * POST /api/privacy/data-export
   * Streams NDJSON with one record per owned table. Header `X-Data-Export-User`
   * contains the user id so the request can be traced.
   */
  async dataExport(req: Request, res: Response): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id as number | undefined;
    if (!userId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const parsed = dataExportRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request", errors: parsed.error.flatten() });
      return;
    }

    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted',cancel);
    res.once('close',cancel);
    let prepared: Awaited<ReturnType<typeof preparePrivacyExport>> | undefined;
    try {
      await createUserConsent({ userId, consentType: 'data_export_request', granted: true,
        reason: parsed.data.reason, ...clientMeta(req) });
      prepared = await preparePrivacyExport(userId,controller.signal);
      if (controller.signal.aborted) return;
      res.setHeader('Content-Type','application/x-ndjson');
      res.setHeader('Content-Disposition',`attachment; filename="user-${userId}-export.ndjson"`);
      res.setHeader('Content-Length',String(prepared.bytes));
      res.setHeader('X-Data-Export-User',String(userId));
      res.setHeader('X-Data-Export-Version','2');
      res.setHeader('X-Data-Export-Coverage','declared-sections-only');
      res.setHeader('Cache-Control','no-store');
      await pipeline(createReadStream(prepared.path),res,{ signal: controller.signal });
    } catch (err) {
      logger.error({ err, userId }, '[privacy] data export failed');
      if (!res.headersSent && !res.destroyed) res.status(500).json({ message: 'Data export failed. No completed export was produced.' });
      else if (!res.destroyed) res.destroy();
    } finally {
      req.off('aborted',cancel);
      res.off('close',cancel);
      await prepared?.dispose();
    }
  },

  /**
   * GET /api/privacy/status — convenience: is the user opted out of all?
   */
  async status(req: Request, res: Response): Promise<Response> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id as number | undefined;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const allOptOut = await getLatestConsent(userId, "all_channels");
    return res.json({
      allChannelsOptedOut: allOptOut ? !allOptOut.granted : false,
      lastAllChannelsChange: allOptOut?.createdAt ?? null,
    });
  },
};
