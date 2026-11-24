import { randomUUID } from 'node:crypto';
import { db } from "../db";
import { outreachSettings, type OutreachSettings, type NewOutreachSettings, type ChannelFollowUps, type ChannelFollowUpSettings } from "./schema";
import { and, eq } from "drizzle-orm";
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import { FOLLOW_UP_CHANNELS, isFollowUpChannel, type FollowUpChannel } from '../../../shared/followUpChannels.js';
import { followUpSettingsRevision, FollowUpSettingsConflictError } from '../../utils/followUpSettingsRevision.js';

/** Legacy whole-map saves must not restore an old channel fence, including omitted channels. */
function fenceChannelFollowUps(settings: ChannelFollowUps): ChannelFollowUps {
  const fenced = { ...settings };
  for (const channel of FOLLOW_UP_CHANNELS) {
    const value = settings[channel];
    fenced[channel] = { ...(value && typeof value === 'object' && !Array.isArray(value)
      ? value : { enabled: false, maxFollowUps: 5, followUps: [] }), revision: randomUUID() };
  }
  return fenced;
}

/** Serialize channel patches and reject stale edits without overwriting other channels. */
export async function saveChannelFollowUpSettings(userId: number, channel: FollowUpChannel, config: ChannelFollowUpSettings, expectedRevision?: string): Promise<OutreachSettings & { followUpFenceAdvanced: boolean }> {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new Error('Invalid follow-up settings scope');
  return db.transaction(async (tx: typeof db) => {
    // Concurrent first saves converge on the same scoped row before taking its lock.
    await tx.insert(outreachSettings).values({ userId, businessProfileId: scope.businessProfileId, enableAutoFollowUp: false })
      .onConflictDoNothing({ target: [outreachSettings.businessProfileId, outreachSettings.userId] });
    const filter = and(eq(outreachSettings.userId, userId), eq(outreachSettings.businessProfileId, scope.businessProfileId));
    const [current]: OutreachSettings[] = await tx.select().from(outreachSettings).where(filter).for('update');
    if (!current) throw new Error('Follow-up settings were not found');
    const merged: ChannelFollowUps = {
      ...Object.fromEntries(Object.entries(current.channelFollowUps ?? {}).filter(([key]) => isFollowUpChannel(key))),
      [channel]: config,
    };
    const enableAutoFollowUp = Object.values(merged).some(value => value?.enabled === true && Array.isArray(value.followUps) && value.followUps.some((step: ChannelFollowUpSettings['followUps'][number]) => step?.enabled === true));
    const currentRevision = followUpSettingsRevision(current.channelFollowUps?.[channel]);
    const stored = current.channelFollowUps?.[channel];
    const comparable = stored ? { ...stored, revision: undefined } : undefined;
    const identical = followUpSettingsRevision(comparable) === followUpSettingsRevision(config);
    // Retrying a committed identical save is safe even if its first response was lost.
    if (identical && expectedRevision !== currentRevision && current.enableAutoFollowUp === enableAutoFollowUp
      && Object.keys(current.channelFollowUps ?? {}).every(isFollowUpChannel)) return { ...current, followUpFenceAdvanced: false };
    if (!identical && expectedRevision !== undefined && expectedRevision !== currentRevision) {
      throw new FollowUpSettingsConflictError();
    }
    // A new confirmed intent advances the fence even when its values are unchanged.
    // Old same-body retries are harmless; old differing intents cannot survive an ABA cycle.
    merged[channel] = { ...config, revision: randomUUID() };
    const [saved] = await tx.update(outreachSettings).set({
      channelFollowUps: merged,
      enableAutoFollowUp,
      updatedAt: new Date(),
    }).where(filter).returning();
    return { ...saved, followUpFenceAdvanced: true };
  });
}

export async function getOutreachSettingsByUserId(userId: number): Promise<OutreachSettings | undefined> {
  const [settings] = await db.select().from(outreachSettings).where(eq(outreachSettings.userId, userId));
  return settings;
}

export async function updateOutreachSettings(userId: number, data: Partial<NewOutreachSettings>): Promise<OutreachSettings> {
  const [settings] = await db
    .update(outreachSettings)
    .set({ ...data, ...(data.channelFollowUps ? { channelFollowUps: fenceChannelFollowUps(data.channelFollowUps) } : {}), updatedAt: new Date() })
    .where(eq(outreachSettings.userId, userId))
    .returning();
  return settings;
}

interface OutreachSettingsInput extends Partial<NewOutreachSettings> {
  followUps?: ChannelFollowUps;
}

export async function upsertOutreachSettings(userId: number, data: OutreachSettingsInput): Promise<OutreachSettings> {
  // Map followUps to channelFollowUps if provided
  const mappedData: Partial<NewOutreachSettings> = { ...data };
  if (data.followUps) {
    mappedData.channelFollowUps = data.followUps;
    delete (mappedData as OutreachSettingsInput).followUps;
  }

  if (mappedData.channelFollowUps) mappedData.channelFollowUps = fenceChannelFollowUps(mappedData.channelFollowUps);

  // Ensure enableAutoFollowUp is set when channel follow-ups exist
  if (mappedData.channelFollowUps && mappedData.enableAutoFollowUp === undefined) {
    const hasAnyEnabled = Object.values(mappedData.channelFollowUps).some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ch: any) => ch?.enabled && Array.isArray(ch?.followUps) && ch.followUps.length > 0
    );
    mappedData.enableAutoFollowUp = hasAnyEnabled;
  }
  
  const values = { ...mappedData, userId, updatedAt: new Date() };
  const [settings] = await db
    .insert(outreachSettings)
    .values(values)
    .onConflictDoUpdate({
      target: [outreachSettings.businessProfileId, outreachSettings.userId],
      set: { ...mappedData, updatedAt: values.updatedAt },
    })
    .returning();
  return settings;
}
