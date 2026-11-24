/**
 * Admin User Service
 *
 * Centralises the business logic for admin-side user, wallet, and
 * overview operations. The two controllers (`adminManagementController`,
 * `adminCreditController`) used to be 1.7k lines of copy-pasted
 * try/catch + drizzle select logic; this service moves the data layer
 * to one place, and the controllers become thin response-shaping
 * wrappers.
 *
 * Design goals:
 *  - Service functions throw structured `AdminServiceError` instead of
 *    writing to `res` themselves; the controller decides how to render.
 *  - Pagination is the only DTO shape we expose (`Paginated<T>`).
 *  - No Drizzle types leak — the service returns plain shapes.
 */

import { eq, or, inArray, desc, and, sql, count, SQL, ilike, isNull } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db } from '../models/db';
import { DEFAULT_BUSINESS_TIMEZONE } from '../utils/timezone.js';
import { adminUserCreateSchema, adminUserUpdateSchema } from '../utils/adminManagementValidation.js';
import { z } from 'zod';
import { usersTable } from '../models/users/schema';
import { leadsTable } from '../models/leads/schema';
import { chatThreadsTable } from '../models/chatThreads/schema';
import { chatMessagesTable } from '../models/chatMessages/schema';
import { outreachCampaignsTable } from '../models/outreachCampaigns/schema';
import { outreachConversationsTable, outreachMessagesTable } from '../models/outreachConversations/schema';
import { icpProfilesTable } from '../models/icpData/schema';
import { contentAssetsTable } from '../models/contentAssets/schema';
import { brandToolkitsTable } from '../models/brandToolkits/schema';
import { contentTemplatesTable, contentTemplateVersionsTable } from '../models/contentTemplates/schema';
import { contentPlansTable } from '../models/contentPlans/schema';
import { campaignsTable } from '../models/campaigns/schema';
import { adsTable } from '../models/ads/schema';
import { performanceAdCampaignsTable } from '../models/performanceAdCampaigns/schema';
import { knowledgeBaseTable } from '../models/knowledgeBase/schema';
import { walletsTable } from '../models/wallets/schema';
import { systemIntegrationsTable } from '../models/systemIntegrations/schema';
import {
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getAllUsers,
  // @ts-expect-error -- legacy model helper does not export its inferred record type yet
  type UserRecord,
} from '../models/users/functions';
import {
  getAdminById,
  updateAdmin as updateAdminRecord,
} from '../models/admins/functions';
import { getOrCreateWallet } from '../models/wallets/functions';
import { getTransactionsByUserId } from '../models/walletTransactions/functions';
import { creditService } from './CreditService';
import { razorpayService } from './RazorpayService';
import { encryptValue } from './SecretsManager';
import { logger } from '../utils/logger.js';
import { getAllCreditEventLogs } from '../models/creditEventLogs/functions';
import { passwordSchema } from '../middleware/schemas.js';
import { maskSensitiveIntegrationConfig } from '../utils/integrationSecrets.js';
import {
  canonicalizeTemplateVariable,
  extractTemplateVariables,
  sanitizeEmailHtml,
} from '../utils/contentTemplateRendering.js';

export class AdminServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'admin_error',
  ) {
    super(message);
    this.name = 'AdminServiceError';
  }
}

export interface Paginated<T> {
  items: T[];
  pagination: {
    total: number;
    page?: number;
    pageSize?: number;
    totalPages?: number;
  };
}

export interface UserDetail {
  user: SafeUserRecord;
  chatHistory: unknown[];
  outreachCampaigns: unknown[];
  leads: unknown[];
  icps: unknown[];
  contentAssets: unknown[];
  brandToolkits: unknown[];
  emailConversations: unknown[];
  contentTemplates: unknown[];
  campaigns: unknown[];
  ads: Array<{ ad: unknown; campaignName: string | null }>;
}

export type SafeUserRecord = Pick<UserRecord,
  'id' | 'name' | 'email' | 'role' | 'isVerified' | 'isSetupComplete' | 'isApproved'
  | 'avatar' | 'bio' | 'phone' | 'timezone' | 'notificationPreferences'
  | 'createdAt' | 'updatedAt' | 'lastLoginAt'>;

export function sanitizeUserRecord(user: UserRecord): SafeUserRecord {
  const {
    id, name, email, role, isVerified, isSetupComplete, isApproved,
    avatar, bio, phone, timezone, notificationPreferences, createdAt, updatedAt, lastLoginAt,
  } = user;
  return { id, name, email, role, isVerified, isSetupComplete, isApproved,
    avatar, bio, phone, timezone, notificationPreferences, createdAt, updatedAt, lastLoginAt };
}

export interface UserStats {
  leads: number;
  campaigns: number;
  outreachCampaigns: number;
  chatThreads: number;
  contentAssets: number;
  brandToolkits: number;
  contentTemplates: number;
}

export interface ContentStats {
  totals: {
    contentAssets: number;
    brandToolkits: number;
    contentTemplates: number;
    outreachConversations: number;
    ads: number;
  };
  assetsByType: Record<string, number>;
  templatesByType: Record<string, number>;
  conversationsByChannel: Record<string, number>;
  adsByPlatform: Record<string, number>;
}

export interface ListUsersFilters {
  limit?: number;
  offset?: number;
}

const DEFAULT_PAGE_SIZE = 50;

function parseIntParam(value: string | number | undefined, name: string): number {
  if (value === undefined) {
    throw new AdminServiceError(400, `Missing required param: ${name}`);
  }
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(parsed) || parsed > 2147483647) {
    throw new AdminServiceError(400, `Invalid ${name}: must be a positive integer in the supported range`);
  }
  return parsed;
}

function parseIntQuery(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function countOccurrences<T extends Record<K, string>>(
  rows: T[],
  key: K,
): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const value = row[key];
    if (typeof value === 'string') {
      acc[value] = (acc[value] || 0) + 1;
    }
    return acc;
  }, {});
}

type K = string;

// ─── User CRUD ────────────────────────────────────────────────────────

export async function listAllUsers(): Promise<SafeUserRecord[]> {
  const users = await getAllUsers();
  return users.filter((user) => !user.deletedAt).map(sanitizeUserRecord);
}

export async function getUserOrThrow(userId: number): Promise<UserRecord> {
  const user = await getUserById(userId);
  if (!user) throw new AdminServiceError(404, 'User not found');
  return user;
}

function validatedUserInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new AdminServiceError(400, result.error.issues[0]?.message || 'Invalid user request');
  return result.data;
}

export async function createNewUser(input: z.input<typeof adminUserCreateSchema>): Promise<SafeUserRecord> {
  const data = validatedUserInput(adminUserCreateSchema, input);
  const hashed = await bcrypt.hash(data.password, 10);
  return sanitizeUserRecord(await createUser({
    email: data.email,
    password: hashed,
    name: data.name,
    role: data.role,
    phone: data.phone ?? null,
    bio: data.bio ?? null,
    timezone: data.timezone || DEFAULT_BUSINESS_TIMEZONE,
  }));
}

export async function updateExistingUser(
  userId: number,
  patch: z.input<typeof adminUserUpdateSchema>,
): Promise<SafeUserRecord> {
  parseIntParam(userId, 'user ID');
  const data = validatedUserInput(adminUserUpdateSchema, patch);
  const updateData = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
  const user = await updateUser(userId, updateData);
  if (!user) throw new AdminServiceError(404, 'User not found');
  return sanitizeUserRecord(user);
}

export async function deleteUserById(userId: number): Promise<void> {
  const retained = await db.execute(sql`SELECT id FROM billing_organizations
    WHERE owner_user_id=${userId} OR default_for_user_id=${userId} LIMIT 1`);
  if (retained.rows.length) throw new AdminServiceError(409,
    'This account owns retained billing records. Revoke approval to restrict business operations and request an account-closure retention review. Financial history cannot be hard-deleted here.',
    'ACCOUNT_CLOSURE_REVIEW_REQUIRED');
  const ok = await deleteUser(userId);
  if (!ok) throw new AdminServiceError(404, 'User not found');
}

export async function setUserVerified(userId: number): Promise<UserRecord> {
  await getUserOrThrow(userId);
  return updateUser(userId, { isVerified: true });
}

export async function setUserApproved(
  userId: number,
  approved: boolean,
): Promise<UserRecord> {
  const user = await getUserOrThrow(userId);
  if (approved && user.isApproved) {
    throw new AdminServiceError(400, 'User is already approved');
  }
  return updateUser(userId, { isApproved: approved });
}

export const approveUser = (userId: number) => setUserApproved(userId, true);
export const rejectUser = (userId: number) => setUserApproved(userId, false);

export async function setUserPassword(userId: number, newPassword: string): Promise<void> {
  parseIntParam(userId, 'user ID');
  const passwordResult = passwordSchema.safeParse(newPassword);
  if (!passwordResult.success) {
    throw new AdminServiceError(400, passwordResult.error.issues[0]?.message || 'Invalid password');
  }
  await getUserOrThrow(userId);
  const hashed = await bcrypt.hash(newPassword, 10);
  await updateUser(userId, {
    password: hashed,
    passwordChangedAt: new Date(),
    resetPasswordToken: null,
    resetPasswordTokenExpiry: null,
  });
}

export async function changeAdminPassword(
  adminId: number,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (!currentPassword) {
    throw new AdminServiceError(400, 'Current password is required');
  }
  const passwordResult = passwordSchema.safeParse(newPassword);
  if (!passwordResult.success) {
    throw new AdminServiceError(400, passwordResult.error.issues[0]?.message || 'Invalid password');
  }
  const admin = await getAdminById(adminId);
  if (!admin) throw new AdminServiceError(404, 'Admin not found');
  const isMatch = await bcrypt.compare(currentPassword, admin.password);
  if (!isMatch) throw new AdminServiceError(401, 'Current password is incorrect');
  const hashed = await bcrypt.hash(newPassword, 10);
  await updateAdminRecord(adminId, {
    password: hashed,
    passwordChangedAt: new Date(),
    resetPasswordToken: null,
    resetPasswordTokenExpiry: null,
  });
}

// ─── User detail (the big aggregation) ───────────────────────────────

export async function getUserDetail(userId: number): Promise<UserDetail> {
  const user = await getUserOrThrow(userId);

  const [chatHistory, outreachCampaigns, icps, contentAssets, brandToolkits, emailConversations, contentTemplates, campaigns] = await Promise.all([
    db.select().from(chatThreadsTable).where(eq(chatThreadsTable.userId, userId)),
    db.select().from(outreachCampaignsTable).where(eq(outreachCampaignsTable.userId, userId)),
    db.select().from(icpProfilesTable).where(eq(icpProfilesTable.userId, userId)),
    db.select().from(contentAssetsTable).where(eq(contentAssetsTable.userId, userId)).orderBy(desc(contentAssetsTable.createdAt)),
    db.select().from(brandToolkitsTable).where(eq(brandToolkitsTable.userId, userId)).orderBy(desc(brandToolkitsTable.createdAt)),
    db.select().from(outreachConversationsTable).where(eq(outreachConversationsTable.userId, userId)).orderBy(desc(outreachConversationsTable.lastMessageAt)),
    db.select().from(contentTemplatesTable).where(eq(contentTemplatesTable.userId, userId)).orderBy(desc(contentTemplatesTable.createdAt)),
    db.select().from(campaignsTable).where(eq(campaignsTable.userId, userId)).orderBy(desc(campaignsTable.createdAt)),
  ]);

  const leads = icps.length > 0
    ? await db.select().from(leadsTable).where(
        or(
          eq(leadsTable.userId, userId),
          eq(leadsTable.createdBy, userId),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          inArray(leadsTable.promptId, icps.map((i: any) => i.id)),
        ),
      )
    : await db.select().from(leadsTable).where(
        or(eq(leadsTable.userId, userId), eq(leadsTable.createdBy, userId)),
      );

  const ads: Array<{ ad: unknown; campaignName: string | null }> = [];
  if (campaigns.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const campaignIds = campaigns.map((c: any) => c.id);
    const rows = await db
      .select({ ad: adsTable, campaignName: campaignsTable.name })
      .from(adsTable)
      .leftJoin(campaignsTable, eq(adsTable.campaignId, campaignsTable.id))
      .where(inArray(adsTable.campaignId, campaignIds))
      .orderBy(desc(adsTable.createdAt));
    ads.push(...rows);
  }

  return {
    user: sanitizeUserRecord(user),
    chatHistory,
    outreachCampaigns,
    leads,
    icps,
    contentAssets,
    brandToolkits,
    emailConversations,
    contentTemplates,
    campaigns,
    ads,
  };
}

export async function getUserStats(userId: number): Promise<UserStats> {
  const [leads, campaigns, outreachCampaigns, chatThreads, contentAssets, brandToolkits, contentTemplates] = await Promise.all([
    db.select({ id: leadsTable.id }).from(leadsTable).where(eq(leadsTable.userId, userId)),
    db.select({ id: campaignsTable.id }).from(campaignsTable).where(eq(campaignsTable.userId, userId)),
    db.select({ id: outreachCampaignsTable.id }).from(outreachCampaignsTable).where(eq(outreachCampaignsTable.userId, userId)),
    db.select({ id: chatThreadsTable.id }).from(chatThreadsTable).where(eq(chatThreadsTable.userId, userId)),
    db.select({ id: contentAssetsTable.id }).from(contentAssetsTable).where(eq(contentAssetsTable.userId, userId)),
    db.select({ id: brandToolkitsTable.id }).from(brandToolkitsTable).where(eq(brandToolkitsTable.userId, userId)),
    db.select({ id: contentTemplatesTable.id }).from(contentTemplatesTable).where(eq(contentTemplatesTable.userId, userId)),
  ]);
  return {
    leads: leads.length,
    campaigns: campaigns.length,
    outreachCampaigns: outreachCampaigns.length,
    chatThreads: chatThreads.length,
    contentAssets: contentAssets.length,
    brandToolkits: brandToolkits.length,
    contentTemplates: contentTemplates.length,
  };
}

// ─── Per-user sub-resources ───────────────────────────────────────────

export async function getUserCampaigns(userId: number): Promise<{
  outreachCampaigns: unknown[];
  marketingCampaigns: unknown[];
  total: number;
}> {
  await getUserOrThrow(userId);
  const [outreachCampaigns, marketingCampaigns] = await Promise.all([
    db.select().from(outreachCampaignsTable).where(eq(outreachCampaignsTable.userId, userId)).orderBy(desc(outreachCampaignsTable.createdAt)),
    db.select().from(campaignsTable).where(eq(campaignsTable.userId, userId)).orderBy(desc(campaignsTable.createdAt)),
  ]);
  return {
    outreachCampaigns,
    marketingCampaigns,
    total: outreachCampaigns.length + marketingCampaigns.length,
  };
}

export async function getUserChats(userId: number): Promise<unknown[]> {
  await getUserOrThrow(userId);
  return db.select({
    id: chatThreadsTable.id,
    title: chatThreadsTable.title,
    selectedAgent: chatThreadsTable.selectedAgent,
    createdAt: chatThreadsTable.createdAt,
    updatedAt: chatThreadsTable.updatedAt,
    messageCount: sql<number>`(
      SELECT COUNT(*)::integer FROM ${chatMessagesTable} message_count
      WHERE message_count.thread_id = ${chatThreadsTable.id}
        AND message_count.user_id = ${userId}
        AND message_count.deleted_at IS NULL
    )`,
    lastMessage: sql<string | null>`(
      SELECT LEFT(last_message.content, 500) FROM ${chatMessagesTable} last_message
      WHERE last_message.thread_id = ${chatThreadsTable.id}
        AND last_message.user_id = ${userId}
        AND last_message.deleted_at IS NULL
      ORDER BY last_message.created_at DESC
      LIMIT 1
    )`,
  }).from(chatThreadsTable).where(and(
    eq(chatThreadsTable.userId, userId),
    isNull(chatThreadsTable.deletedAt),
  )).orderBy(desc(chatThreadsTable.updatedAt));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function removeHeavyFields(obj: any): any {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(removeHeavyFields);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clean: any = {};
  for (const key of Object.keys(obj)) {
    if (key === 'websiteContent' || key === 'extractedText' || key === 'imageData' || key === 'videoData') {
      continue;
    }
    clean[key] = removeHeavyFields(obj[key]);
  }
  return clean;
}

export async function getUserChatMessages(userId: number, threadId: number): Promise<unknown[]> {
  await getUserOrThrow(userId);
  const [thread] = await db.select({ id: chatThreadsTable.id }).from(chatThreadsTable).where(and(
    eq(chatThreadsTable.id, threadId),
    eq(chatThreadsTable.userId, userId),
    isNull(chatThreadsTable.deletedAt),
  )).limit(1);
  if (!thread) {
    throw new AdminServiceError(404, 'Chat thread not found', 'chat_thread_not_found');
  }
  const messages = await db.select().from(chatMessagesTable).where(and(
    eq(chatMessagesTable.threadId, threadId),
    eq(chatMessagesTable.userId, userId),
    isNull(chatMessagesTable.deletedAt),
  )).orderBy(chatMessagesTable.createdAt);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return messages.map((msg: any) => ({
    ...msg,
    metadata: maskSensitiveIntegrationConfig(removeHeavyFields(msg.metadata)),
  }));
}

export async function getAdminChatMessages(threadId: number): Promise<unknown[]> {
  const [thread] = await db.select({ userId: chatThreadsTable.userId }).from(chatThreadsTable).where(and(
    eq(chatThreadsTable.id, threadId),
    isNull(chatThreadsTable.deletedAt),
  )).limit(1);
  if (!thread) {
    throw new AdminServiceError(404, 'Chat thread not found', 'chat_thread_not_found');
  }
  return getUserChatMessages(thread.userId, threadId);
}

export async function getUserLeads(userId: number): Promise<unknown[]> {
  return db.select().from(leadsTable).where(or(eq(leadsTable.userId, userId), eq(leadsTable.createdBy, userId))).orderBy(desc(leadsTable.createdAt));
}

export async function getUserICPs(userId: number): Promise<unknown[]> {
  return db.select().from(icpProfilesTable).where(eq(icpProfilesTable.userId, userId)).orderBy(desc(icpProfilesTable.createdAt));
}

export async function getUserContent(userId: number): Promise<unknown[]> {
  return db.select().from(contentAssetsTable).where(eq(contentAssetsTable.userId, userId)).orderBy(desc(contentAssetsTable.createdAt));
}

export async function getUserKnowledgeBase(userId: number): Promise<unknown[]> {
  return db.select().from(knowledgeBaseTable).where(eq(knowledgeBaseTable.userId, userId)).orderBy(desc(knowledgeBaseTable.createdAt));
}

export async function getUserBrandToolkits(userId: number): Promise<unknown[]> {
  return db.select().from(brandToolkitsTable).where(eq(brandToolkitsTable.userId, userId)).orderBy(desc(brandToolkitsTable.createdAt));
}

export async function getUserTemplates(userId: number): Promise<unknown[]> {
  return db.select().from(contentTemplatesTable).where(eq(contentTemplatesTable.userId, userId)).orderBy(desc(contentTemplatesTable.createdAt));
}

export async function getUserAds(userId: number): Promise<unknown[]> {
  await getUserOrThrow(userId);
  const [legacyAds, performanceCampaigns] = await Promise.all([
    db
      .select({
        id: adsTable.id,
        platform: adsTable.platform,
        adName: adsTable.adName,
        campaignName: campaignsTable.name,
        status: adsTable.status,
        impressions: adsTable.impressions,
        clicks: adsTable.clicks,
        conversions: adsTable.conversions,
        ctr: adsTable.ctr,
        spend: adsTable.spend,
        currency: sql<string | null>`NULL`,
        createdAt: adsTable.createdAt,
        source: sql<string>`'legacy_ad'`,
      })
      .from(adsTable)
      .innerJoin(campaignsTable, eq(adsTable.campaignId, campaignsTable.id))
      .where(eq(campaignsTable.userId, userId))
      .orderBy(desc(adsTable.createdAt)),
    db
      .select({
        id: performanceAdCampaignsTable.id,
        platform: performanceAdCampaignsTable.adPlatform,
        adName: performanceAdCampaignsTable.name,
        campaignName: performanceAdCampaignsTable.name,
        status: performanceAdCampaignsTable.status,
        impressions: performanceAdCampaignsTable.impressions,
        clicks: performanceAdCampaignsTable.clicks,
        conversions: performanceAdCampaignsTable.conversions,
        ctr: performanceAdCampaignsTable.ctr,
        spend: performanceAdCampaignsTable.spentAmount,
        currency: performanceAdCampaignsTable.currency,
        createdAt: performanceAdCampaignsTable.createdAt,
        source: sql<string>`'performance_campaign'`,
      })
      .from(performanceAdCampaignsTable)
      .where(eq(performanceAdCampaignsTable.userId, userId))
      .orderBy(desc(performanceAdCampaignsTable.createdAt)),
  ]);

  return [...legacyAds, ...performanceCampaigns].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

export async function getUserOutreachConversations(
  userId: number,
  channel?: string,
): Promise<unknown[]> {
  const conditions: SQL[] = [eq(outreachConversationsTable.userId, userId)];
  if (channel) {
    conditions.push(sql`LOWER(${outreachConversationsTable.channel}) = LOWER(${channel})`);
  }
  return db
    .select()
    .from(outreachConversationsTable)
    .where(and(...conditions))
    .orderBy(desc(outreachConversationsTable.lastMessageAt));
}

// ─── Global overviews (with filters + pagination) ────────────────────

export interface ContentAssetsFilter {
  userId?: number;
  type?: string;
  limit?: number;
  offset?: number;
}

export async function listAllContentAssets(filter: ContentAssetsFilter): Promise<Paginated<unknown>> {
  const limit = filter.limit ?? DEFAULT_PAGE_SIZE;
  const offset = filter.offset ?? 0;

  const conditions: SQL[] = [];
  if (filter.userId !== undefined) conditions.push(eq(contentAssetsTable.userId, filter.userId));
  if (filter.type !== undefined) conditions.push(eq(contentAssetsTable.type, filter.type));

  const baseQuery = db
    .select({
      id: contentAssetsTable.id,
      userId: contentAssetsTable.userId,
      type: contentAssetsTable.type,
      title: contentAssetsTable.title,
      content: contentAssetsTable.content,
      channel: contentAssetsTable.channel,
      status: contentAssetsTable.status,
      imageUrl: contentAssetsTable.imageUrl,
      videoUrl: contentAssetsTable.videoUrl,
      createdAt: contentAssetsTable.createdAt,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
    .from(contentAssetsTable)
    .leftJoin(usersTable, eq(contentAssetsTable.userId, usersTable.id))
    .orderBy(desc(contentAssetsTable.createdAt))
    .$dynamic();

  const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
  const items = await filtered.limit(limit).offset(offset);
  const [{ totalCount }] = await db.select({ totalCount: count() }).from(contentAssetsTable);
  // @ts-expect-error -- legacy offset pagination uses limit/offset instead of page/pageSize
  return { items, pagination: { total: Number(totalCount), limit, offset } };
}

export async function listAllBrandToolkits(filter: ListUsersFilters & { userId?: number }): Promise<Paginated<unknown>> {
  const limit = filter.limit ?? DEFAULT_PAGE_SIZE;
  const offset = filter.offset ?? 0;

  const baseQuery = db
    .select({
      id: brandToolkitsTable.id,
      userId: brandToolkitsTable.userId,
      name: brandToolkitsTable.name,
      description: brandToolkitsTable.description,
      tagline: brandToolkitsTable.tagline,
      logoUrl: brandToolkitsTable.logoUrl,
      primaryBrandColor: brandToolkitsTable.primaryBrandColor,
      secondaryBrandColor: brandToolkitsTable.secondaryBrandColor,
      accentColor: brandToolkitsTable.accentColor,
      voiceType: brandToolkitsTable.voiceType,
      createdAt: brandToolkitsTable.createdAt,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
    .from(brandToolkitsTable)
    .leftJoin(usersTable, eq(brandToolkitsTable.userId, usersTable.id))
    .orderBy(desc(brandToolkitsTable.createdAt))
    .$dynamic();

  const filtered = filter.userId !== undefined
    ? baseQuery.where(eq(brandToolkitsTable.userId, filter.userId))
    : baseQuery;
  const items = await filtered.limit(limit).offset(offset);
  const [{ totalCount }] = await db.select({ totalCount: count() }).from(brandToolkitsTable);
  // @ts-expect-error -- legacy offset pagination uses limit/offset instead of page/pageSize
  return { items, pagination: { total: Number(totalCount), limit, offset } };
}

export interface OutreachListFilter {
  userId?: number;
  channel?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function listAllOutreachConversations(filter: OutreachListFilter): Promise<Paginated<unknown>> {
  const limit = filter.limit ?? DEFAULT_PAGE_SIZE;
  const offset = filter.offset ?? 0;

  const conditions: SQL[] = [];
  if (filter.userId !== undefined) conditions.push(eq(outreachConversationsTable.userId, filter.userId));
  if (filter.channel !== undefined) conditions.push(eq(outreachConversationsTable.channel, filter.channel));
  if (filter.status !== undefined) conditions.push(eq(outreachConversationsTable.status, filter.status));

  const baseQuery = db
    .select({
      id: outreachConversationsTable.id,
      userId: outreachConversationsTable.userId,
      leadId: outreachConversationsTable.leadId,
      channel: outreachConversationsTable.channel,
      leadName: outreachConversationsTable.leadName,
      leadEmail: outreachConversationsTable.leadEmail,
      leadInstagram: outreachConversationsTable.leadInstagram,
      leadCompany: outreachConversationsTable.leadCompany,
      status: outreachConversationsTable.status,
      totalMessages: outreachConversationsTable.totalMessages,
      unreadCount: outreachConversationsTable.unreadCount,
      lastMessageAt: outreachConversationsTable.lastMessageAt,
      lastMessageBy: outreachConversationsTable.lastMessageBy,
      lastMessagePreview: outreachConversationsTable.lastMessagePreview,
      createdAt: outreachConversationsTable.createdAt,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
    .from(outreachConversationsTable)
    .leftJoin(usersTable, eq(outreachConversationsTable.userId, usersTable.id))
    .orderBy(desc(outreachConversationsTable.lastMessageAt))
    .$dynamic();

  const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
  const items = await filtered.limit(limit).offset(offset);
  const [{ totalCount }] = await db.select({ totalCount: count() }).from(outreachConversationsTable);
  // @ts-expect-error -- legacy offset pagination uses limit/offset instead of page/pageSize
  return { items, pagination: { total: Number(totalCount), limit, offset } };
}

export async function getOutreachByChannel(channel?: string): Promise<unknown[]> {
  const conditions: SQL[] = [];
  if (channel) {
    conditions.push(sql`LOWER(${outreachConversationsTable.channel}) = LOWER(${channel})`);
  }
  const baseQuery = db
    .select({
      id: outreachConversationsTable.id,
      userId: outreachConversationsTable.userId,
      leadId: outreachConversationsTable.leadId,
      channel: outreachConversationsTable.channel,
      status: outreachConversationsTable.status,
      lastMessageAt: outreachConversationsTable.lastMessageAt,
      userName: usersTable.name,
    })
    .from(outreachConversationsTable)
    .leftJoin(usersTable, eq(outreachConversationsTable.userId, usersTable.id))
    .orderBy(desc(outreachConversationsTable.lastMessageAt))
    .$dynamic();
  const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
  return filtered;
}

export async function getOutreachConversationMessages(conversationId: number): Promise<{ conversation: unknown; messages: unknown[] } | null> {
  const [conversation] = await db.select().from(outreachConversationsTable).where(eq(outreachConversationsTable.id, conversationId));
  if (!conversation) return null;
  const messages = await db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.conversationId, conversationId)).orderBy(outreachMessagesTable.createdAt);
  return { conversation, messages };
}

export interface TemplatesFilter {
  userId?: number;
  type?: string;
  limit?: number;
  offset?: number;
}

export async function listAllContentTemplates(filter: TemplatesFilter): Promise<Paginated<unknown>> {
  const limit = filter.limit ?? DEFAULT_PAGE_SIZE;
  const offset = filter.offset ?? 0;

  const conditions: SQL[] = [];
  if (filter.userId !== undefined) conditions.push(eq(contentTemplatesTable.userId, filter.userId));
  if (filter.type !== undefined) conditions.push(eq(contentTemplatesTable.type, filter.type));

  const baseQuery = db
    .select({
      id: contentTemplatesTable.id,
      userId: contentTemplatesTable.userId,
      name: contentTemplatesTable.name,
      type: contentTemplatesTable.type,
      subject: contentTemplatesTable.subject,
      category: contentTemplatesTable.category,
      tags: contentTemplatesTable.tags,
      usageCount: contentTemplatesTable.usageCount,
      isApproved: contentTemplatesTable.isApproved,
      createdAt: contentTemplatesTable.createdAt,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
    .from(contentTemplatesTable)
    .leftJoin(usersTable, eq(contentTemplatesTable.userId, usersTable.id))
    .orderBy(desc(contentTemplatesTable.createdAt))
    .$dynamic();

  const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
  const items = await filtered.limit(limit).offset(offset);
  const [{ totalCount }] = await db.select({ totalCount: count() }).from(contentTemplatesTable);
  // @ts-expect-error -- legacy offset pagination uses limit/offset instead of page/pageSize
  return { items, pagination: { total: Number(totalCount), limit, offset } };
}

export interface AdsFilter {
  userId?: number;
  status?: string;
  platform?: string;
  limit?: number;
  offset?: number;
}

export async function listAllAds(filter: AdsFilter): Promise<Paginated<unknown>> {
  const limit = filter.limit ?? DEFAULT_PAGE_SIZE;
  const offset = filter.offset ?? 0;

  const conditions: SQL[] = [];
  if (filter.userId !== undefined) conditions.push(eq(campaignsTable.userId, filter.userId));
  if (filter.status !== undefined) conditions.push(eq(adsTable.status, filter.status));
  if (filter.platform !== undefined) conditions.push(eq(adsTable.platform, filter.platform));

  const baseQuery = db
    .select({
      id: adsTable.id,
      campaignId: adsTable.campaignId,
      platform: adsTable.platform,
      adName: adsTable.adName,
      status: adsTable.status,
      impressions: adsTable.impressions,
      clicks: adsTable.clicks,
      conversions: adsTable.conversions,
      spend: adsTable.spend,
      ctr: adsTable.ctr,
      cpc: adsTable.cpc,
      creativeUrl: adsTable.creativeUrl,
      startDate: adsTable.startDate,
      endDate: adsTable.endDate,
      createdAt: adsTable.createdAt,
      campaignName: campaignsTable.name,
      campaignUserId: campaignsTable.userId,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
    .from(adsTable)
    .leftJoin(campaignsTable, eq(adsTable.campaignId, campaignsTable.id))
    .leftJoin(usersTable, eq(campaignsTable.userId, usersTable.id))
    .orderBy(desc(adsTable.createdAt))
    .$dynamic();

  const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
  const items = await filtered.limit(limit).offset(offset);
  const [{ totalCount }] = await db.select({ totalCount: count() }).from(adsTable);
  // @ts-expect-error -- legacy offset pagination uses limit/offset instead of page/pageSize
  return { items, pagination: { total: Number(totalCount), limit, offset } };
}

export async function getContentStats(): Promise<ContentStats> {
  const [contentAssets, brandToolkits, contentTemplates, outreachConversations, ads] = await Promise.all([
    db.select().from(contentAssetsTable),
    db.select().from(brandToolkitsTable),
    db.select().from(contentTemplatesTable),
    db.select().from(outreachConversationsTable),
    db.select().from(adsTable),
  ]);

  return {
    totals: {
      contentAssets: contentAssets.length,
      brandToolkits: brandToolkits.length,
      contentTemplates: contentTemplates.length,
      outreachConversations: outreachConversations.length,
      ads: ads.length,
    },
    assetsByType: countOccurrences(contentAssets as Array<Record<string, string>>, 'type'),
    templatesByType: countOccurrences(contentTemplates as Array<Record<string, string>>, 'type'),
    conversationsByChannel: countOccurrences(outreachConversations as Array<Record<string, string>>, 'channel'),
    adsByPlatform: countOccurrences(ads as Array<Record<string, string>>, 'platform'),
  };
}

// ─── Lead / campaign admin CRUD ───────────────────────────────────────

export { listAdminLeads, type AdminLeadListFilter } from './AdminLeadDirectoryService.js';

export async function listAdminCampaigns(): Promise<unknown[]> {
  return db
    .select({
      id: campaignsTable.id,
      name: campaignsTable.name,
      goal: campaignsTable.goal,
      status: campaignsTable.status,
      budget: campaignsTable.budget,
      spent: campaignsTable.spent,
      startDate: campaignsTable.startDate,
      endDate: campaignsTable.endDate,
      userId: campaignsTable.userId,
      createdAt: campaignsTable.createdAt,
      userName: usersTable.name,
      userEmail: usersTable.email,
      leadsCount: sql<number>`(
        SELECT count(*)::int
        FROM ${leadsTable} campaign_lead
        WHERE campaign_lead.user_id = ${campaignsTable.userId}
          AND campaign_lead.deleted_at IS NULL
          AND campaign_lead.campaign_data->>'campaignId' ~ '^[0-9]+$'
          AND (campaign_lead.campaign_data->>'campaignId')::int = ${campaignsTable.id}
      )`,
    })
    .from(campaignsTable)
    .leftJoin(usersTable, eq(campaignsTable.userId, usersTable.id))
    .orderBy(desc(campaignsTable.createdAt));
}

export async function createAdminCampaign(data: {
  userId: number;
  name: string;
  goal: string;
  status?: 'draft' | 'planned' | 'active' | 'paused' | 'completed';
  budget: number;
  startDate: string;
  endDate?: string | null;
}): Promise<unknown> {
  await getUserOrThrow(data.userId);

  const [campaign] = await db.insert(campaignsTable).values({
    userId: data.userId,
    name: data.name,
    goal: data.goal,
    status: data.status ?? 'draft',
    budget: data.budget,
    spent: 0,
    metrics: {},
    startDate: new Date(data.startDate),
    endDate: data.endDate ? new Date(data.endDate) : null,
  }).returning();
  return campaign;
}

export async function deleteAdminCampaign(id: number): Promise<void> {
  const [campaign] = await db
    .update(campaignsTable)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(campaignsTable.id, id))
    .returning({ id: campaignsTable.id });
  if (!campaign) throw new AdminServiceError(404, 'Campaign not found');
}

export async function createAdminLead(data: Record<string, unknown>): Promise<unknown> {
  const { LeadModel } = await import('../models/leads/functions.js');
  return LeadModel.create(data as never);
}

export async function deleteAdminLead(id: number): Promise<void> {
  await db.delete(leadsTable).where(eq(leadsTable.id, id));
}

// ─── Templates: admin/global contentTemplates overviews ──────────────

export async function listAdminContentTemplates(): Promise<unknown[]> {
  return db
    .select({
      id: contentTemplatesTable.id,
      userId: contentTemplatesTable.userId,
      name: contentTemplatesTable.name,
      type: contentTemplatesTable.type,
      subject: contentTemplatesTable.subject,
      category: contentTemplatesTable.category,
      content: contentTemplatesTable.content,
      createdAt: contentTemplatesTable.createdAt,
      userName: usersTable.name,
    })
    .from(contentTemplatesTable)
    .leftJoin(usersTable, eq(contentTemplatesTable.userId, usersTable.id))
    .orderBy(desc(contentTemplatesTable.createdAt));
}

export async function listAdminBrandToolkits(): Promise<unknown[]> {
  return db
    .select({
      id: brandToolkitsTable.id,
      userId: brandToolkitsTable.userId,
      name: brandToolkitsTable.name,
      description: brandToolkitsTable.description,
      tagline: brandToolkitsTable.tagline,
      logoUrl: brandToolkitsTable.logoUrl,
      primaryBrandColor: brandToolkitsTable.primaryBrandColor,
      isDefault: brandToolkitsTable.isDefault,
      createdAt: brandToolkitsTable.createdAt,
      userName: usersTable.name,
    })
    .from(brandToolkitsTable)
    .leftJoin(usersTable, eq(brandToolkitsTable.userId, usersTable.id))
    .orderBy(desc(brandToolkitsTable.createdAt));
}

export async function listAdminContentCalendar(): Promise<unknown[]> {
  return db
    .select({
      id: contentPlansTable.id,
      userId: contentPlansTable.userId,
      name: contentPlansTable.name,
      description: contentPlansTable.description,
      contentType: contentPlansTable.contentType,
      status: contentPlansTable.status,
      contentCalendar: contentPlansTable.contentCalendar,
      createdAt: contentPlansTable.createdAt,
      userName: usersTable.name,
    })
    .from(contentPlansTable)
    .leftJoin(usersTable, eq(contentPlansTable.userId, usersTable.id))
    .orderBy(desc(contentPlansTable.createdAt));
}

// ─── Predefined templates ─────────────────────────────────────────────

const VALID_PREDEFINED_TYPES = [
  'email', 'sms', 'ad_copy', 'social', 'social_message', 'landing_page', 'blog',
] as const;

function normalizePredefinedType(
  type: string,
  category?: string | null,
): { type: typeof VALID_PREDEFINED_TYPES[number]; category: string | null } {
  const legacyPlatforms: Record<string, string> = {
    instagram_dm: 'instagram',
    linkedin_dm: 'linkedin',
    twitter_dm: 'twitter',
    facebook_dm: 'facebook',
  };
  if (legacyPlatforms[type]) {
    return { type: 'social_message', category: category || legacyPlatforms[type] };
  }
  if (!VALID_PREDEFINED_TYPES.includes(type as never)) {
    throw new AdminServiceError(400, `Invalid type. Must be one of: ${VALID_PREDEFINED_TYPES.join(', ')}`);
  }
  return { type: type as typeof VALID_PREDEFINED_TYPES[number], category: category || null };
}

function normalizePredefinedVariables(parts: string[]): string[] {
  const variables = new Set<string>();
  for (const token of parts.flatMap(extractTemplateVariables)) {
    const canonical = canonicalizeTemplateVariable(token);
    if (!canonical) throw new AdminServiceError(400, `Unsupported template variable: {{${token}}}`);
    variables.add(`{{${canonical}}}`);
  }
  return [...variables];
}

export async function createPredefinedTemplate(input: {
  name: string;
  type: string;
  content: string;
  subject?: string | null;
  htmlContent?: string | null;
  description?: string | null;
  variables?: string[];
  category?: string | null;
  tags?: string[];
}): Promise<unknown> {
  if (!input.name || !input.type || !input.content) {
    throw new AdminServiceError(400, 'Name, type, and content are required');
  }
  const taxonomy = normalizePredefinedType(input.type, input.category);
  if (input.htmlContent && taxonomy.type !== 'email') {
    throw new AdminServiceError(400, 'HTML content is supported only for email templates');
  }
  const htmlContent = input.htmlContent ? sanitizeEmailHtml(input.htmlContent) : null;
  const variables = normalizePredefinedVariables([
    input.subject || '',
    input.content,
    htmlContent || '',
    ...(input.variables || []).map(variable => variable.includes('{{') ? variable : `{{${variable}}}`),
  ]);
  return db.transaction(async (tx: typeof db) => {
    const [template] = await tx.insert(contentTemplatesTable).values({
      userId: null,
      name: input.name,
      type: taxonomy.type,
      content: input.content,
      subject: input.subject ?? null,
      htmlContent,
      description: input.description ?? null,
      variables,
      category: taxonomy.category,
      tags: input.tags ?? [],
      isPredefined: true,
      isApproved: true,
      approvedAt: new Date(),
    }).returning();
    await tx.insert(contentTemplateVersionsTable).values({
      templateId: template.id,
      userId: null,
      version: template.version,
      snapshot: {
        name: template.name,
        type: template.type,
        subject: template.subject,
        content: template.content,
        htmlContent: template.htmlContent,
        variables: template.variables,
        category: template.category,
        tags: template.tags,
        description: template.description,
        isApproved: true,
      },
      createdBy: null,
    });
    return template;
  });
}

export async function updatePredefinedTemplate(
  id: number,
  patch: Partial<{
    name: string;
    type: string;
    content: string;
    subject: string;
    htmlContent: string;
    description: string;
    variables: string[];
    category: string;
    tags: string[];
  }>,
): Promise<unknown> {
  const [existing] = await db.select().from(contentTemplatesTable)
    .where(eq(contentTemplatesTable.id, id)).limit(1);
  if (!existing || !existing.isPredefined) {
    throw new AdminServiceError(404, 'Predefined template not found');
  }
  const taxonomy = normalizePredefinedType(patch.type || existing.type, patch.category ?? existing.category);
  const resultingHtml = patch.htmlContent === undefined ? existing.htmlContent : patch.htmlContent;
  if (resultingHtml && taxonomy.type !== 'email') {
    throw new AdminServiceError(400, 'HTML content is supported only for email templates');
  }
  const sanitizedHtml = resultingHtml ? sanitizeEmailHtml(resultingHtml) : null;
  const variables = normalizePredefinedVariables([
    patch.subject ?? existing.subject ?? '',
    patch.content ?? existing.content,
    sanitizedHtml || '',
    ...(patch.variables ?? existing.variables ?? [])
      .map((variable: string) => variable.includes('{{') ? variable : `{{${variable}}}`),
  ]);
  const updates: Record<string, unknown> = {
    type: taxonomy.type,
    category: taxonomy.category,
    htmlContent: sanitizedHtml,
    variables,
    isApproved: true,
    approvedAt: new Date(),
    version: existing.version + 1,
    updatedAt: new Date(),
  };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && !['type', 'category', 'htmlContent', 'variables'].includes(k)) updates[k] = v;
  }
  return db.transaction(async (tx: typeof db) => {
    const [template] = await tx.update(contentTemplatesTable)
      .set(updates as never)
      .where(eq(contentTemplatesTable.id, id))
      .returning();
    await tx.insert(contentTemplateVersionsTable).values({
      templateId: template.id,
      userId: null,
      version: template.version,
      snapshot: {
        name: template.name,
        type: template.type,
        subject: template.subject,
        content: template.content,
        htmlContent: template.htmlContent,
        variables: template.variables,
        category: template.category,
        tags: template.tags,
        description: template.description,
        isApproved: true,
      },
      createdBy: null,
    });
    return template;
  });
}

export async function deletePredefinedTemplate(id: number): Promise<void> {
  const [existing] = await db.select().from(contentTemplatesTable)
    .where(eq(contentTemplatesTable.id, id)).limit(1);
  if (!existing || !existing.isPredefined) {
    throw new AdminServiceError(404, 'Predefined template not found');
  }
  await db.delete(contentTemplatesTable).where(eq(contentTemplatesTable.id, id));
}

export async function listPredefinedTemplates(type?: string): Promise<unknown[]> {
  const conditions: SQL[] = [eq(contentTemplatesTable.isPredefined, true)];
  if (typeof type === 'string' && type.length > 0) {
    conditions.push(eq(contentTemplatesTable.type, type));
  }
  return db.select()
    .from(contentTemplatesTable)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(contentTemplatesTable.updatedAt));
}

// ─── Support tickets (admin overview) ─────────────────────────────────

// ─── Wallets (admin side) ─────────────────────────────────────────────

function parseNumericFields<T extends { balance: string | number; totalCreditsAdded: string | number; totalCreditsUsed: string | number }>(w: T) {
  return {
    ...w,
    balance: parseFloat(w.balance as string),
    totalCreditsAdded: parseFloat(w.totalCreditsAdded as string),
    totalCreditsUsed: parseFloat(w.totalCreditsUsed as string),
  };
}

export async function listAllWallets(options?: { page?: number; pageSize?: number; search?: string }) {
  const page = Math.max(1, Math.floor(Number(options?.page) || 1));
  const pageSize = Math.min(100, Math.max(10, Math.floor(Number(options?.pageSize) || 25)));
  const search = options?.search?.trim().slice(0, 100);
  const defaultWallet = sql`EXISTS (SELECT 1 FROM billing_organizations o
    WHERE o.id=${walletsTable.organizationId} AND o.default_for_user_id=${walletsTable.userId})`;
  const whereClause = and(defaultWallet, search
    ? or(ilike(usersTable.name, `%${search}%`), ilike(usersTable.email, `%${search}%`))
    : undefined);

  const [countRow] = await db.select({ total: count() })
    .from(walletsTable)
    .leftJoin(usersTable, eq(walletsTable.userId, usersTable.id))
    .where(whereClause);
  const total = Number(countRow?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);

  const rows = await db
    .select({ wallet: walletsTable, userName: usersTable.name, userEmail: usersTable.email })
    .from(walletsTable)
    .leftJoin(usersTable, eq(walletsTable.userId, usersTable.id))
    .where(whereClause)
    .orderBy(desc(walletsTable.updatedAt))
    .limit(pageSize)
    .offset((safePage - 1) * pageSize);

  const [summary] = await db.select({
    totalWallets: count(),
    totalBalance: sql<string>`COALESCE(SUM(${walletsTable.balance}), 0)`,
    totalCreditsAdded: sql<string>`COALESCE(SUM(${walletsTable.totalCreditsAdded}), 0)`,
  }).from(walletsTable).where(defaultWallet);

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: rows.map((w: any) => ({ ...parseNumericFields(w.wallet), userName: w.userName, userEmail: w.userEmail })),
    pagination: { page: safePage, pageSize, total, totalPages },
    summary: {
      totalWallets: Number(summary?.totalWallets || 0),
      totalBalance: Number(summary?.totalBalance || 0),
      totalCreditsAdded: Number(summary?.totalCreditsAdded || 0),
    },
  };
}

export async function getUserWalletDetail(userId: number): Promise<{
  wallet: ReturnType<typeof parseNumericFields>;
  recentTransactions: unknown[];
  totalTransactions: number;
}> {
  const wallet = await getOrCreateWallet(userId);
  const { transactions, total } = await getTransactionsByUserId(userId, { limit: 20 });
  return {
    wallet: parseNumericFields(wallet),
    recentTransactions: transactions,
    totalTransactions: total,
  };
}

export async function addCreditsToUser(
  userId: number,
  amount: number,
  reason: string,
  admin?: { id: number; email?: string },
): Promise<number> {
  if (!amount || amount <= 0) {
    throw new AdminServiceError(400, 'Invalid credit amount');
  }
  const user = await getUserById(userId);
  if (!user) throw new AdminServiceError(404, 'User not found');
  return creditService.addBonusCredits(userId, amount, reason, {
    source: 'admin_console',
    adminId: admin?.id,
    adminEmail: admin?.email,
  });
}

// ─── Top credit users ─────────────────────────────────────────────────

export async function listTopCreditUsers(limit: number): Promise<Array<{
  userId: number;
  balance: number;
  totalCreditsAdded: number;
  totalCreditsUsed: number;
  userName: string | null;
  userEmail: string | null;
}>> {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  const rows = await db
    .select({
      userId: walletsTable.userId,
      balance: walletsTable.balance,
      totalCreditsAdded: walletsTable.totalCreditsAdded,
      totalCreditsUsed: walletsTable.totalCreditsUsed,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
    .from(walletsTable)
    .leftJoin(usersTable, eq(walletsTable.userId, usersTable.id))
    .where(sql`EXISTS (SELECT 1 FROM billing_organizations o
      WHERE o.id=${walletsTable.organizationId} AND o.default_for_user_id=${walletsTable.userId})`)
    .orderBy(desc(walletsTable.totalCreditsUsed))
    .limit(boundedLimit);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => ({
    userId: r.userId,
    balance: parseFloat(r.balance as string),
    totalCreditsAdded: parseFloat(r.totalCreditsAdded as string),
    totalCreditsUsed: parseFloat(r.totalCreditsUsed as string),
    userName: r.userName,
    userEmail: r.userEmail,
  }));
}

// ─── Credit events (with user enrichment) ─────────────────────────────

export interface EnrichedCreditEventLog {
  [key: string]: unknown;
  userId: number;
  userName: string | null;
  userEmail: string | null;
}

export async function getEnrichedCreditEventLogs(filter: {
  limit: number;
  offset: number;
  userId?: number;
  eventKey?: string;
  service?: string;
  apiProvider?: string;
}): Promise<{ logs: EnrichedCreditEventLog[]; total: number }> {
  const result = await getAllCreditEventLogs(filter);
  const userIds = [...new Set(result.logs.map((l) => l.userId))];
  const usersMap = new Map<number, { name: string | null; email: string | null }>();
  if (userIds.length > 0) {
    const users = await db
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(sql`${usersTable.id} IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`);
    for (const u of users) {
      usersMap.set(u.id, { name: u.name, email: u.email });
    }
  }
  return {
    logs: result.logs.map((l) => ({
      ...l,
      userName: usersMap.get(l.userId)?.name ?? null,
      userEmail: usersMap.get(l.userId)?.email ?? null,
    })),
    total: result.total,
  };
}

// ─── Razorpay integration ─────────────────────────────────────────────

export interface RazorpayConfig {
  isConfigured: boolean;
  integration: Record<string, unknown> | null;
}

export async function getRazorpayIntegration(): Promise<RazorpayConfig> {
  const [integration] = await db
    .select()
    .from(systemIntegrationsTable)
    .where(eq(systemIntegrationsTable.integrationId, 'razorpay'));
  const isConfigured = await razorpayService.isConfigured();
  return { isConfigured, integration: (integration as Record<string, unknown> | undefined) ?? null };
}

export async function saveRazorpayIntegration(keyId: string, keySecret: string): Promise<void> {
  if (!keyId || !keySecret) {
    throw new AdminServiceError(400, 'Key ID and Key Secret are required');
  }
  const encryptedSecret = encryptValue(keySecret);
  const [existing] = await db
    .select()
    .from(systemIntegrationsTable)
    .where(eq(systemIntegrationsTable.integrationId, 'razorpay'));
  if (existing) {
    await db
      .update(systemIntegrationsTable)
      .set({ defaultConfig: { keyId, keySecret: encryptedSecret }, isEnabled: true, updatedAt: new Date() })
      .where(eq(systemIntegrationsTable.integrationId, 'razorpay'));
  } else {
    await db.insert(systemIntegrationsTable).values({
      integrationId: 'razorpay',
      name: 'Razorpay',
      description: 'Razorpay payment gateway for wallet recharges',
      category: 'payment',
      type: 'official',
      status: 'available',
      isEnabled: true,
      defaultConfig: { keyId, keySecret: encryptedSecret },
      iconName: 'CreditCard',
      features: ['wallet_recharge', 'payment_verification'],
    });
  }
}

export async function testRazorpayConnection(): Promise<{ ok: boolean; publicKey?: string; message: string }> {
  const isConfigured = await razorpayService.isConfigured();
  if (!isConfigured) {
    throw new AdminServiceError(503, 'Razorpay is not configured. Please add your API credentials.');
  }
  try {
    const publicKey = await razorpayService.getPublicKey();
    // @ts-expect-error -- provider helper may return null while this DTO omits null
    return { ok: true, publicKey, message: 'Razorpay connection successful' };
  } catch (err) {
    logger.warn({ err }, 'testRazorpayConnection failed');
    throw new AdminServiceError(502, 'Unable to connect to Razorpay. Please verify your API credentials.');
  }
}

// ─── Controller-facing helper ─────────────────────────────────────────
//
// Run a service function and render a 200 / service-error response.
// Returns the JSON body. Use this from the controllers so the
// try/catch/500 boilerplate lives in one place.

export interface ServiceRunResult<T> {
  status: number;
  body: T;
}

export async function runService<T>(
  fn: () => Promise<T>,
  options: { successStatus?: number } = {},
): Promise<ServiceRunResult<T>> {
  const successStatus = options.successStatus ?? 200;
  try {
    const body = await fn();
    return { status: successStatus, body };
  } catch (err) {
    if (err instanceof AdminServiceError) {
      const body = { message: err.message, error: err.message,
        ...(/^[A-Z][A-Z0-9_]{0,100}$/.test(err.code) ? { code: err.code } : {}),
      };
      return { status: err.status, body: body as T };
    }
    // Allow ad-hoc controllers to throw `{ status, message }` style errors.
    const status = (err as { status?: number })?.status;
    if (typeof status === 'number' && status >= 400 && status < 600) {
      const message = (err as Error).message || 'Bad request';
      return { status, body: { message, error: message } as T };
    }
    logger.error({ err }, 'admin service error');
    return { status: 500, body: { message: 'An unexpected error occurred. Please try again.', error: 'internal_error' } as T };
  }
}

export { parseIntParam, parseIntQuery };
