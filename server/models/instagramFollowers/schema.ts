import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Instagram Followers Schema
 * Stores the list of a user's Instagram followers fetched via microservice
 * to detect new followers for welcome messages.
 */

import { pgTable, serial, integer, varchar, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema.js';

export const instagramFollowersTable = pgTable('instagram_followers', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  followerUsername: varchar('follower_username', { length: 255 }).notNull(),
  followerId: varchar('follower_id', { length: 255 }),
  fullName: varchar('full_name', { length: 255 }),
  profilePicUrl: text('profile_pic_url'),
  followedAt: timestamp('followed_at').notNull().defaultNow(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => {
  return {
    userFollowerIdx: uniqueIndex('instagram_user_follower_idx').on(table.businessProfileId, table.userId, table.followerUsername),
  };
});

export type InstagramFollowerRecord = typeof instagramFollowersTable.$inferSelect;
export type InsertInstagramFollower = typeof instagramFollowersTable.$inferInsert;
