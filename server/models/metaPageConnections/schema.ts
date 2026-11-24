import { sql } from 'drizzle-orm';
import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Meta Page Connections Schema
 * Maps Facebook Pages / Instagram Business Accounts to users via OAuth.
 * Admin stores the Meta App ID/Secret globally; users connect via OAuth
 * and we store their page-level tokens here.
 */

import { pgTable, serial, integer, varchar, text, timestamp, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';

export const metaPageConnectionsTable = pgTable('meta_page_connections', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),

  // Facebook Page info
  pageId: varchar('page_id', { length: 100 }).notNull(),
  pageName: varchar('page_name', { length: 255 }),
  pageAccessToken: text('page_access_token').notNull(),

  // Instagram Business Account (linked to the page)
  instagramAccountId: varchar('instagram_account_id', { length: 100 }),
  instagramUsername: varchar('instagram_username', { length: 255 }),
  instagramProfilePicture: text('instagram_profile_picture'),
  instagramFollowersCount: integer('instagram_followers_count').default(0),

  // User-level long-lived token (for ads, etc.)
  userAccessToken: text('user_access_token').notNull(),
  tokenExpiry: timestamp('token_expiry'),

  // Ad Account (optional)
  adAccountId: varchar('ad_account_id', { length: 100 }),
  adAccountName: varchar('ad_account_name', { length: 255 }),
  adAccountCurrency: varchar('ad_account_currency', { length: 10 }),
  adAccountTimezone: varchar('ad_account_timezone', { length: 100 }),

  // Permissions granted
  scopes: text('scopes').array(),

  // Status
  isActive: boolean('is_active').notNull().default(true),
  // A page can back both Facebook and Instagram. Keep their lifecycle states
  // independent so disconnecting one integration cannot break the other.
  facebookActive: boolean('facebook_active').notNull().default(true),
  instagramActive: boolean('instagram_active').notNull().default(false),
  webhookSubscribed: boolean('webhook_subscribed').notNull().default(false),
  lastUsedAt: timestamp('last_used_at'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, table => [
  uniqueIndex('meta_active_page_routing_unique').on(table.pageId).where(sql`${table.isActive}`),
  uniqueIndex('meta_active_instagram_routing_unique').on(table.instagramAccountId).where(sql`${table.isActive} AND ${table.instagramActive} AND ${table.instagramAccountId} IS NOT NULL`),
]);

export type MetaPageConnectionRecord = typeof metaPageConnectionsTable.$inferSelect;
export type InsertMetaPageConnection = typeof metaPageConnectionsTable.$inferInsert;
