import { eq, and, desc, asc, sql } from "drizzle-orm";
import { db } from "../db";
import { postsTable, type Post, type InsertPost } from "./schema";

export class PostModel {
  /**
   * Create a new post
   */
  static async createPost(data: InsertPost): Promise<Post> {
    const [post] = await db.insert(postsTable).values(data).returning();
    return post;
  }

  /**
   * Create multiple posts
   */
  static async createPosts(data: InsertPost[]): Promise<Post[]> {
    if (data.length === 0) return [];
    const posts = await db.insert(postsTable).values(data).returning();
    return posts;
  }

  /**
   * Get a post by ID
   */
  static async getPostById(id: number): Promise<Post | undefined> {
    const [post] = await db.select().from(postsTable).where(eq(postsTable.id, id));
    return post;
  }

  /**
   * Get a post by post ID and platform
   */
  static async getPostByPlatformId(postId: string, platform: string): Promise<Post | undefined> {
    const [post] = await db
      .select()
      .from(postsTable)
      .where(and(eq(postsTable.postId, postId), eq(postsTable.platform, platform)));
    return post;
  }

  /**
   * Get posts by prompt ID
   */
  static async getPostsByPromptId(promptId: number, limit: number = 100, offset: number = 0): Promise<Post[]> {
    return db
      .select()
      .from(postsTable)
      .where(eq(postsTable.promptId, promptId))
      .orderBy(desc(postsTable.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /**
   * Get posts by user ID
   */
  static async getPostsByUserId(userId: number, limit: number = 100, offset: number = 0): Promise<Post[]> {
    return db
      .select()
      .from(postsTable)
      .where(eq(postsTable.userId, userId))
      .orderBy(desc(postsTable.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /**
   * Get posts by author ID
   */
  static async getPostsByAuthorId(authorId: string, platform: string, limit: number = 100): Promise<Post[]> {
    return db
      .select()
      .from(postsTable)
      .where(and(eq(postsTable.authorId, authorId), eq(postsTable.platform, platform)))
      .orderBy(desc(postsTable.createdAt))
      .limit(limit);
  }

  /**
   * Get posts by hashtag
   */
  static async getPostsByHashtag(hashtag: string, limit: number = 100): Promise<Post[]> {
    return db
      .select()
      .from(postsTable)
      .where(eq(postsTable.searchHashtag, hashtag))
      .orderBy(desc(postsTable.likesCount))
      .limit(limit);
  }

  /**
   * Get unprocessed posts for lead extraction
   */
  static async getUnprocessedPosts(limit: number = 100): Promise<Post[]> {
    return db
      .select()
      .from(postsTable)
      .where(eq(postsTable.processedForLeads, false))
      .orderBy(asc(postsTable.createdAtDb))
      .limit(limit);
  }

  /**
   * Mark post as processed for leads
   */
  static async markPostAsProcessed(id: number): Promise<Post | undefined> {
    const [post] = await db
      .update(postsTable)
      .set({ 
        processedForLeads: true,
        leadExtractionAttempts: sql`${postsTable.leadExtractionAttempts} + 1`,
        updatedAt: new Date()
      })
      .where(eq(postsTable.id, id))
      .returning();
    return post;
  }

  /**
   * Update a post
   */
  static async updatePost(id: number, data: Partial<InsertPost>): Promise<Post | undefined> {
    const [post] = await db
      .update(postsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(postsTable.id, id))
      .returning();
    return post;
  }

  /**
   * Delete a post
   */
  static async deletePost(id: number): Promise<void> {
    await db.delete(postsTable).where(eq(postsTable.id, id));
  }

  /**
   * Delete posts by prompt ID
   */
  static async deletePostsByPromptId(promptId: number): Promise<void> {
    await db.delete(postsTable).where(eq(postsTable.promptId, promptId));
  }

  /**
   * Get posts statistics by platform
   */
  static async getPostsStatsByPlatform(userId: number): Promise<Array<{ platform: string; count: number }>> {
    const result = await db
      .select({
        platform: postsTable.platform,
        count: sql<number>`count(*)::int`,
      })
      .from(postsTable)
      .where(eq(postsTable.userId, userId))
      .groupBy(postsTable.platform);
    return result;
  }

  /**
   * Get top posts by engagement
   */
  static async getTopPostsByEngagement(
    platform: string,
    limit: number = 20
  ): Promise<Post[]> {
    return db
      .select()
      .from(postsTable)
      .where(eq(postsTable.platform, platform))
      .orderBy(desc(postsTable.likesCount), desc(postsTable.commentsCount))
      .limit(limit);
  }

  /**
   * Search posts by text content
   */
  static async searchPostsByText(
    searchText: string,
    userId: number,
    limit: number = 100
  ): Promise<Post[]> {
    return db
      .select()
      .from(postsTable)
      .where(
        and(
          eq(postsTable.userId, userId),
          sql`(${postsTable.text} ILIKE ${`%${searchText}%`} OR ${postsTable.caption} ILIKE ${`%${searchText}%`})`
        )
      )
      .orderBy(desc(postsTable.createdAt))
      .limit(limit);
  }

  /**
   * Get total post count for user
   */
  static async getPostsCount(userId: number): Promise<number> {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(postsTable)
      .where(eq(postsTable.userId, userId));
    return result?.count || 0;
  }
}
