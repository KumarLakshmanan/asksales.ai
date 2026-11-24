import { asc, eq } from 'drizzle-orm';
import { db } from '../db.js';
import { usersTable } from '../users/schema.js';
import {
  platformAccessAuditTable,
  platformModulesTable,
  platformSettingsTable,
  userModuleAccessTable,
} from './schema.js';
import { resolveModuleEnabled, type PlatformModuleKey, type PlatformModuleStatus, type UserModuleMode } from '../../utils/platformModules.js';

export interface EffectiveModuleAccess {
  key: PlatformModuleKey;
  name: string;
  description: string;
  status: string;
  message: string | null;
  mode: UserModuleMode;
  enabled: boolean;
}

let settingsCache: { expiresAt: number; value: { enabled: boolean; message: string } } | null = null;
const SETTINGS_CACHE_MS = 5_000;

export function invalidatePlatformAccessCache() {
  settingsCache = null;
}


export async function getMaintenanceSettings() {
  if (settingsCache && settingsCache.expiresAt > Date.now()) return settingsCache.value;
  const [row] = await db.select({
    maintenanceEnabled: platformSettingsTable.maintenanceEnabled,
    maintenanceMessage: platformSettingsTable.maintenanceMessage,
  }).from(platformSettingsTable).where(eq(platformSettingsTable.id, 1)).limit(1);
  const value = {
    enabled: row?.maintenanceEnabled ?? false,
    message: row?.maintenanceMessage || 'We are performing scheduled maintenance. Please try again shortly.',
  };
  settingsCache = { value, expiresAt: Date.now() + SETTINGS_CACHE_MS };
  return value;
}

export async function getPlatformModules() {
  return db.select().from(platformModulesTable).orderBy(asc(platformModulesTable.sortOrder));
}

export async function getEffectiveModuleAccess(userId: number): Promise<EffectiveModuleAccess[]> {
  const [modules, overrides] = await Promise.all([
    getPlatformModules(),
    db.select().from(userModuleAccessTable).where(eq(userModuleAccessTable.userId, userId)),
  ]);
  const overrideMap = new Map(overrides.map((item: typeof userModuleAccessTable.$inferSelect) => [item.moduleKey, item.isEnabled]));
  return modules.map((module: typeof platformModulesTable.$inferSelect) => {
    const override = overrideMap.get(module.moduleKey);
    const mode: UserModuleMode = override === undefined ? 'inherit' : override ? 'enabled' : 'disabled';
    return {
      key: module.moduleKey as PlatformModuleKey,
      name: module.name,
      description: module.description,
      status: module.status,
      message: module.statusMessage,
      mode,
      enabled: resolveModuleEnabled(module.status as PlatformModuleStatus, mode),
    };
  });
}

export async function getPlatformControls() {
  const [maintenance, modules] = await Promise.all([getMaintenanceSettings(), getPlatformModules()]);
  return { maintenance, modules };
}

export async function updatePlatformControls(input: {
  maintenance?: { enabled: boolean; message: string };
  modules?: Array<{ key: PlatformModuleKey; status: string; message: string | null }>;
  adminId: number;
}) {
  const result = await db.transaction(async (tx: typeof db) => {
    if (input.maintenance) {
      const [before] = await tx.select().from(platformSettingsTable).where(eq(platformSettingsTable.id, 1)).limit(1);
      const [after] = await tx.insert(platformSettingsTable).values({
        id: 1,
        maintenanceEnabled: input.maintenance.enabled,
        maintenanceMessage: input.maintenance.message,
        updatedBy: input.adminId,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: platformSettingsTable.id,
        set: {
          maintenanceEnabled: input.maintenance.enabled,
          maintenanceMessage: input.maintenance.message,
          updatedBy: input.adminId,
          updatedAt: new Date(),
        },
      }).returning();
      await tx.insert(platformAccessAuditTable).values({
        targetType: 'maintenance',
        targetKey: 'global',
        adminId: input.adminId,
        beforeValue: (before ?? null) as Record<string, unknown> | null,
        afterValue: after as unknown as Record<string, unknown>,
      });
    }

    for (const item of input.modules || []) {
      const [before] = await tx.select().from(platformModulesTable).where(eq(platformModulesTable.moduleKey, item.key)).limit(1);
      if (!before) throw new Error(`Platform module ${item.key} is not configured`);
      const [after] = await tx.update(platformModulesTable).set({
        status: item.status,
        statusMessage: item.message,
        updatedBy: input.adminId,
        updatedAt: new Date(),
      }).where(eq(platformModulesTable.moduleKey, item.key)).returning();
      if (before.status !== after.status || before.statusMessage !== after.statusMessage) {
        await tx.insert(platformAccessAuditTable).values({
          targetType: 'module',
          targetKey: item.key,
          adminId: input.adminId,
          beforeValue: before as unknown as Record<string, unknown>,
          afterValue: after as unknown as Record<string, unknown>,
        });
      }
    }
    return true;
  });
  invalidatePlatformAccessCache();
  return result;
}

export async function getUserModuleModes(userId: number) {
  const [user] = await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) return null;
  return { user, modules: await getEffectiveModuleAccess(userId) };
}

export async function replaceUserModuleModes(input: {
  userId: number;
  adminId: number;
  modules: Array<{ key: PlatformModuleKey; mode: UserModuleMode }>;
}) {
  return db.transaction(async (tx: typeof db) => {
    const [user] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, input.userId)).limit(1);
    if (!user) return null;
    const before = await tx.select().from(userModuleAccessTable).where(eq(userModuleAccessTable.userId, input.userId));
    await tx.delete(userModuleAccessTable).where(eq(userModuleAccessTable.userId, input.userId));
    const overrides = input.modules.filter((module) => module.mode !== 'inherit').map((module) => ({
      userId: input.userId,
      moduleKey: module.key,
      isEnabled: module.mode === 'enabled',
      updatedBy: input.adminId,
      updatedAt: new Date(),
    }));
    if (overrides.length) await tx.insert(userModuleAccessTable).values(overrides);
    await tx.insert(platformAccessAuditTable).values({
      targetType: 'user_modules',
      targetKey: String(input.userId),
      userId: input.userId,
      adminId: input.adminId,
      beforeValue: { overrides: before },
      afterValue: { overrides },
    });
    return true;
  });
}

