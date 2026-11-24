import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { Request, Response } from "express";
import { parseIntQuery } from '../utils/paramParsers.js';
import { eq, desc, sql } from "drizzle-orm";
import { db } from "../models/db";
import { postsTable } from "../models/posts/schema";
import { icpProfilesTable } from "../models/icpData/schema";
import { logger } from "../utils/logger";

/**
 * Get all posts for the authenticated user
 */
export const getPosts = async (req: Request, res: Response) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const limit = parseIntQuery(req.query.limit as string, 100, 1, 200);
    const offset = parseIntQuery(req.query.offset as string, 0, 0);
    const platform = req.query.platform as string | undefined;

    const conditions = [eq(postsTable.userId, userId)];
    if (platform) {
      conditions.push(eq(postsTable.platform, platform));
    }

    const posts = await db
      .select()
      .from(postsTable)
      .where(conditions.length === 1 ? conditions[0] : sql`${conditions[0]} AND ${conditions[1]}`)
      .orderBy(desc(postsTable.createdAtDb))
      .limit(limit)
      .offset(offset);

    return res.json(posts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[getPosts] Error fetching posts");
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
};

/**
 * Get posts linked to a specific thread (via ICP promptId)
 */
export const getPostsByThread = async (req: Request, res: Response) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const threadId = parseInt(req.params.threadId);
    if (isNaN(threadId)) return res.status(400).json({ error: "Invalid threadId" });

    const limit = parseIntQuery(req.query.limit as string, 200, 1, 500);

    // Find ICP profile linked to this thread
    const [icp] = await db
      .select({ id: icpProfilesTable.id })
      .from(icpProfilesTable)
      .where(sql`${icpProfilesTable.userId} = ${userId} AND ${icpProfilesTable.threadId} = ${threadId}`)
      .limit(1);

    if (!icp) {
      return res.json([]);
    }

    const posts = await db
      .select()
      .from(postsTable)
      .where(eq(postsTable.promptId, icp.id))
      .orderBy(desc(postsTable.createdAtDb))
      .limit(limit);

    return res.json(posts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error, threadId: req.params.threadId }, "[getPostsByThread] Error fetching posts");
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
};
