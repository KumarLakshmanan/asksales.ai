import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, text, integer, timestamp, serial, varchar, index, jsonb, boolean } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import { icpProfilesTable } from "../icpData/schema";

// Posts table based on Python Post model
export const postsTable = pgTable("posts", {
  businessProfileId: businessProfileColumn(),
  // Primary identification
  id: serial("id").primaryKey(),
  promptId: integer("prompt_id").references(() => icpProfilesTable.id, { onDelete: "cascade" }).notNull(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),

  // Source information
  source: varchar("source", { length: 50 }).notNull(), // facebook, instagram, twitter
  actorId: varchar("actor_id", { length: 100 }), // Apify actor ID used
  platform: varchar("platform", { length: 50 }).notNull(), // facebook, instagram, twitter

  // Post identification
  postId: varchar("post_id", { length: 100 }).notNull(), // Platform-specific post ID
  postUrl: text("post_url"), // Direct link to the post
  authorId: varchar("author_id", { length: 100 }), // Author's platform ID
  authorUsername: varchar("author_username", { length: 100 }), // Author's username/handle
  authorName: varchar("author_name", { length: 255 }), // Author's display name
  authorProfileUrl: text("author_profile_url"), // Author's profile URL

  // Post content
  text: text("text"), // Post text content
  caption: text("caption"), // Alternative field for caption
  hashtags: text("hashtags"), // Hashtags used in post (JSON array)
  mentions: text("mentions"), // User mentions (JSON array)
  mediaUrls: text("media_urls"), // Media URLs (JSON array)
  mediaTypes: text("media_types"), // Media types (JSON array)

  // Post metadata
  postType: varchar("post_type", { length: 50 }), // image, video, carousel, text, etc.
  createdAt: timestamp("created_at"), // When post was created
  timestamp: timestamp("timestamp"), // Alternative timestamp field
  scrapedAt: timestamp("scraped_at").defaultNow(), // When we scraped it

  // Engagement metrics
  likesCount: integer("likes_count").default(0),
  commentsCount: integer("comments_count").default(0),
  sharesCount: integer("shares_count").default(0), // Facebook specific
  retweetCount: integer("retweet_count").default(0), // Twitter specific
  replyCount: integer("reply_count").default(0), // Twitter specific
  quoteCount: integer("quote_count").default(0), // Twitter specific
  bookmarkCount: integer("bookmark_count").default(0), // Twitter specific
  viewCount: integer("view_count").default(0), // Video views
  reactionCount: integer("reaction_count").default(0), // Total reactions (Facebook)

  // Facebook specific fields
  topReactions: text("top_reactions"), // Top reactions (JSON)
  videoViewCount: integer("video_view_count").default(0),
  videoDuration: varchar("video_duration", { length: 20 }), // Video duration

  // Twitter specific fields
  isReply: boolean("is_reply").default(false),
  isRetweet: boolean("is_retweet").default(false),
  isQuote: boolean("is_quote").default(false),
  lang: varchar("lang", { length: 10 }), // Language code
  sourceApp: varchar("source_app", { length: 100 }), // App used to post

  // Instagram specific fields
  ownerFullName: varchar("owner_full_name", { length: 255 }),
  ownerId: varchar("owner_id", { length: 100 }),
  carouselMediaCount: integer("carousel_media_count").default(0),
  videoPlayCount: integer("video_play_count").default(0),

  // Location data (if post has location)
  locationName: varchar("location_name", { length: 255 }),
  locationLat: varchar("location_lat", { length: 50 }),
  locationLng: varchar("location_lng", { length: 50 }),

  // Search context
  searchHashtag: varchar("search_hashtag", { length: 100 }), // Hashtag used for search
  searchQuery: varchar("search_query", { length: 255 }), // Search query used
  searchLocation: varchar("search_location", { length: 100 }), // Location used for search

  // Processing status
  processedForLeads: boolean("processed_for_leads").default(false), // Whether this post was processed for leads
  leadExtractionAttempts: integer("lead_extraction_attempts").default(0), // Number of lead extraction attempts

  // Raw data storage
  rawData: jsonb("raw_data"), // Complete raw response from Apify actors (changed from text to jsonb)

  // Timestamps
  createdAtDb: timestamp("created_at_db").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  // Primary indexes
  postIdIdx: index("posts_post_id_idx").on(table.postId),
  platformIdx: index("posts_platform_idx").on(table.platform),
  
  // Foreign key indexes
  promptIdIdx: index("posts_prompt_id_idx").on(table.promptId),
  userIdIdx: index("posts_user_id_idx").on(table.userId),
  
  // Author indexes
  authorIdIdx: index("posts_author_id_idx").on(table.authorId),
  authorUsernameIdx: index("posts_author_username_idx").on(table.authorUsername),
  
  // Content indexes
  hashtagIdx: index("posts_hashtag_idx").on(table.searchHashtag),
  
  // Engagement indexes
  likesCountIdx: index("posts_likes_count_idx").on(table.likesCount),
  
  // Time indexes
  createdAtIdx: index("posts_created_at_idx").on(table.createdAt),
  scrapedAtIdx: index("posts_scraped_at_idx").on(table.scrapedAt),
  
  // Processing indexes
  processedForLeadsIdx: index("posts_processed_for_leads_idx").on(table.processedForLeads),
  
  // Composite indexes
  platformAuthorIdx: index("posts_platform_author_idx").on(table.platform, table.authorId),
  promptPlatformIdx: index("posts_prompt_platform_idx").on(table.promptId, table.platform),
}));

export type Post = typeof postsTable.$inferSelect;
export type InsertPost = typeof postsTable.$inferInsert;
