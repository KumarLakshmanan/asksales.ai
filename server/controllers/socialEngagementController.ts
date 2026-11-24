import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../models/db.js";
import { assertCustomerDeliveryReady, deliverySetupFailure } from '../services/assistants/CustomerDeliveryGate.js';
import {
  createMetaInsightsClient,
  MetaInsightsError,
  record,
} from "../services/social/MetaInsightsClient.js";

export function commentCapabilities(platform: string, scopes: unknown) {
  const granted = Array.isArray(scopes) ? scopes : [];
  const required =
    platform === "instagram"
      ? "instagram_business_manage_comments"
      : "pages_manage_engagement";
  const allowed = granted.includes(required) || (platform === "instagram" && granted.includes("instagram_manage_comments"));
  return {
    reply: allowed,
    moderate: allowed,
    reason: allowed
      ? null
      : `Reconnect with ${required} permission to reply or moderate comments.`,
  };
}

export async function socialCommentAction(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const { credentialId, platform, action, message, idempotencyKey } =
    req.body || {};
  const postId = String(req.params.id || ""),
    commentId = String(req.params.commentId || "");
  if (
    !Number.isSafeInteger(Number(credentialId)) ||
    Number(credentialId) <= 0 ||
    !["facebook", "instagram"].includes(platform) ||
    !/^[\d_]+$/.test(postId) ||
    !/^[\d_]+$/.test(commentId) ||
    !["reply", "hide", "unhide", "follow_up", "escalate", "resolve"].includes(
      action,
    )
  )
    return res.status(400).json({ error: "Invalid comment action." });
  const write = ["reply", "hide", "unhide"].includes(action);
  if (
    write &&
    (typeof idempotencyKey !== "string" ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(idempotencyKey))
  )
    return res
      .status(400)
      .json({ error: "A valid action receipt is required." });
  if (
    action === "reply" &&
    (typeof message !== "string" || !message.trim() || message.length > 2000)
  )
    return res
      .status(400)
      .json({ error: "Enter a reply between 1 and 2,000 characters." });
  try {
    const graph = await createMetaInsightsClient(userId, Number(credentialId));
    if (graph.platform !== platform)
      return res.status(404).json({ error: "Social account not found." });
    if (action === 'reply') await assertCustomerDeliveryReady({ userId, channel: graph.platform,
      accountId: graph.credential.accountIdentifier || '', surface: 'public_comment' });
    const item = (
      await db.execute(
        sql`SELECT provider_id FROM social_content_items WHERE user_id=${userId} AND credential_id=${Number(credentialId)} AND provider_id=${postId} LIMIT 1`,
      )
    ).rows[0];
    if (!item)
      return res.status(404).json({ error: "Social content not found." });
    // Query the provider relationship rather than trusting a client supplied comment ID.
    const comment = await graph.request(commentId, {
      fields:
        platform === "instagram"
          ? "id,media,hidden"
          : "id,object,can_comment,can_hide,is_hidden",
    });
    const parent = record(
      platform === "instagram" ? comment.media : comment.object,
    );
    if (String(parent.id || "") !== postId)
      return res
        .status(404)
        .json({ error: "This comment does not belong to the selected post." });
    if (!write) {
      const status =
        action === "follow_up"
          ? "follow_up"
          : action === "escalate"
            ? "escalated"
            : "resolved";
      await db.execute(
        sql`INSERT INTO social_comment_workflows(user_id,credential_id,post_id,comment_id,status) VALUES(${userId},${Number(credentialId)},${postId},${commentId},${status}) ON CONFLICT(business_profile_id, user_id,credential_id,comment_id) DO UPDATE SET status=EXCLUDED.status,updated_at=NOW()`,
      );
      return res.json({ status });
    }
    const capabilities = commentCapabilities(
      platform,
      graph.credential.grantedScopes,
    );
    if (
      !capabilities.reply ||
      (platform === "facebook" &&
        (action === "reply"
          ? comment.can_comment === false
          : comment.can_hide === false))
    )
      return res
        .status(422)
        .json({
          error:
            capabilities.reason ||
            "Meta does not allow this action on the selected comment.",
        });
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          Number(credentialId),
          postId,
          commentId,
          action,
          action === "reply" ? message.trim() : "",
        ]),
      )
      .digest("hex");
    // An unfinished identical reply survives browser reloads and cannot be sent
    // again under a new key. A provider timeout never becomes a blind retry.
    const receipt = await db.transaction(async (tx: { execute: (query: SQL) => Promise<{rows: Record<string,unknown>[]}> }) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${userId}:${credentialId}:${commentId}`}))`,
      );
      const prior = (
        await tx.execute(
          sql`SELECT * FROM social_comment_actions WHERE user_id=${userId} AND (idempotency_key=${idempotencyKey} OR (credential_id=${Number(credentialId)} AND comment_id=${commentId} AND request_hash=${hash} AND (status IN ('pending','uncertain') OR (action='reply' AND status='succeeded')))) ORDER BY created_at DESC LIMIT 1`,
        )
      ).rows[0];
      if (prior) return { prior };
      await tx.execute(
        sql`INSERT INTO social_comment_actions(user_id,credential_id,idempotency_key,post_id,comment_id,action,request_hash) VALUES(${userId},${Number(credentialId)},${idempotencyKey},${postId},${commentId},${action},${hash})`,
      );
      return { prior: null };
    });
    if (receipt.prior) {
      if (receipt.prior.request_hash !== hash)
        return res
          .status(409)
          .json({
            error:
              "This action receipt was already used for a different request.",
          });
      if (receipt.prior.status === "succeeded")
        return res.json(receipt.prior.result);
      return res
        .status(409)
        .json({
          error:
            "This action was already attempted. Check the original post before submitting another action.",
          code: "SOCIAL_ACTION_UNCERTAIN",
        });
    }
    try {
      const result = await graph.mutate(
        action === "reply"
          ? `${commentId}/${platform === "instagram" ? "replies" : "comments"}`
          : commentId,
        action === "reply"
          ? { message: message.trim() }
          : {
              [platform === "instagram" ? "hide" : "is_hidden"]: String(
                action === "hide",
              ),
            },
      );
      let hidden: boolean | null = null;
      if (action !== "reply") {
        try {
          const verified = await graph.request(commentId, {
            fields: platform === "instagram" ? "hidden" : "is_hidden",
          });
          const actual =
            verified[platform === "instagram" ? "hidden" : "is_hidden"];
          if (typeof actual === "boolean") hidden = actual;
        } catch {
          /* The write succeeded; a failed verification must not resend it. */
        }
      }
      const value = {
        success: true,
        action,
        providerId: result.id || null,
        ...(action === "reply"
          ? { body: message.trim(), publishedAt: new Date().toISOString() }
          : {}),
        hidden,
      };
      await db.execute(
        sql`UPDATE social_comment_actions SET status='succeeded',result=${JSON.stringify(value)}::jsonb,updated_at=NOW() WHERE user_id=${userId} AND idempotency_key=${idempotencyKey}`,
      );
      return res.json(value);
    } catch (error) {
      const setupFailure = deliverySetupFailure(error);
      await db.execute(
        sql`UPDATE social_comment_actions SET status=${setupFailure || error instanceof MetaInsightsError && error.code === "SOCIAL_ACTION_REJECTED" ? "rejected" : "uncertain"},updated_at=NOW() WHERE user_id=${userId} AND idempotency_key=${idempotencyKey}`,
      );
      throw error;
    }
  } catch (error) {
    const setupFailure = deliverySetupFailure(error);
    if (setupFailure) return res.status(409).json(setupFailure);
    return res
      .status(error instanceof MetaInsightsError ? error.status : 503)
      .json({
        error:
          error instanceof MetaInsightsError
            ? error.message
            : "The action could not be confirmed. Check the original post before retrying.",
        code:
          error instanceof MetaInsightsError
            ? error.code
            : "SOCIAL_ACTION_UNCERTAIN",
      });
  }
}
