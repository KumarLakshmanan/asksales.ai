import { businessOwnerUserId } from '../tenancy/businessContext.js';
 
import type { AuthenticatedRequest as AuthRequest } from '../types/express.js';
 
import type { Response } from "express";
import { logger } from '../utils/logger.js';
import { getLeadSettingsByUserId, upsertLeadSettings } from "../models/leadSettings/functions";
import { getOutreachSettingsByUserId, upsertOutreachSettings, saveChannelFollowUpSettings } from "../models/outreachSettings/functions";
import { getUserPreferencesByUserId, upsertUserPreferences } from "../models/userPreferences/functions";
import { db } from '../models/db.js';
import { usersTable } from '../models/users/schema.js';
import { eq } from 'drizzle-orm';
import { DEFAULT_BUSINESS_TIMEZONE } from '../utils/timezone.js';

import { FOLLOW_UP_CHANNELS, isFollowUpChannel } from '../../shared/followUpChannels.js';
import { loadFollowUpTemplate, FollowUpTemplateError } from '../services/followUpTemplateService.js';
import { followUpSettingsRevision, FollowUpSettingsConflictError } from '../utils/followUpSettingsRevision.js';
import { ContentBrandContextError } from '../services/content/ContentBrandContextService.js';
import { isFollowUpStepId, type FollowUpSettingsStep } from '../../shared/followUpSettings.js';
import { EMAIL_ADDRESS_PATTERN as EMAIL_PATTERN } from '../../shared/emailAddress.js';

const DEFAULT_PREFERENCES = {
  language: 'en',
  locale: 'en-US',
  currency: 'USD',
  theme: 'system',
  timezone: DEFAULT_BUSINESS_TIMEZONE,
  dateFormat: 'MM/DD/YYYY',
  timeFormat: '12h',
};

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function serializeLeadSettings(settings: Awaited<ReturnType<typeof getLeadSettingsByUserId>>) {
  if (!settings) {
    return {
      minLeadScore: 70,
      autoQualify: false,
      enableDuplicateCheck: true,
      autoEnrich: false,
      leadSources: ["linkedin", "google", "justdial", "instagram", "facebook", "twitter"],
      notifyOnHighScore: true,
    };
  }
  return {
    minLeadScore: settings.minLeadScore ?? 70,
    autoQualify: settings.autoQualify ?? false,
    enableDuplicateCheck: settings.enableDuplicateCheck ?? true,
    autoEnrich: settings.autoEnrich ?? false,
    leadSources: settings.leadSources?.filter(source => source.trim().toLowerCase() !== 'yelp') ?? ["linkedin", "google", "justdial", "instagram", "facebook", "twitter"],
    notifyOnHighScore: settings.notifyOnHighScore ?? true,
  };
}

function serializePreferences(prefs: Awaited<ReturnType<typeof getUserPreferencesByUserId>>) {
  if (!prefs) return { ...DEFAULT_PREFERENCES, darkMode: false };
  const theme = prefs.theme === 'light' || prefs.theme === 'dark' ? prefs.theme : 'system';
  return {
    language: prefs.language ?? DEFAULT_PREFERENCES.language,
    locale: prefs.locale ?? DEFAULT_PREFERENCES.locale,
    currency: prefs.currency ?? DEFAULT_PREFERENCES.currency,
    theme,
    timezone: prefs.timezone ?? DEFAULT_PREFERENCES.timezone,
    dateFormat: prefs.dateFormat ?? DEFAULT_PREFERENCES.dateFormat,
    timeFormat: prefs.timeFormat ?? DEFAULT_PREFERENCES.timeFormat,
    // Kept only for older clients during the preference contract migration.
    darkMode: theme === 'dark',
  };
}

const OUTREACH_CHANNELS = new Set<string>(FOLLOW_UP_CHANNELS);
const supportedFollowUps = (settings: object) => Object.fromEntries(Object.entries(settings).filter(([channel]) => isFollowUpChannel(channel)));

function hasEnabledChannelFollowUp(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const config = value as Record<string, unknown>;
  return config.enabled === true && Array.isArray(config.followUps) && config.followUps.some((step) =>
    Boolean(step && typeof step === 'object' && (step as Record<string, unknown>).enabled === true),
  );
}

function optionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('must be text');
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`must be ${maxLength} characters or fewer`);
  return text;
}

function serializeOutreachSettings(settings: Awaited<ReturnType<typeof getOutreachSettingsByUserId>>) {
  const defaultChannelFollowUps = {
    email: { enabled: false, maxFollowUps: 5, followUps: [] },
    sms: { enabled: false, maxFollowUps: 5, followUps: [] },
    instagram: { enabled: false, maxFollowUps: 5, followUps: [] },
    facebook: { enabled: false, maxFollowUps: 5, followUps: [] },
    whatsapp: { enabled: false, maxFollowUps: 5, followUps: [] },
  };
  const defaultFollowUpSteps = [
    { id: 1, delayHours: 24, templateId: null, templateName: "", customSubject: "Just checking in", customBody: "Hi {{first_name}},\n\nI wanted to follow up on my previous email..." },
    { id: 2, delayHours: 72, templateId: null, templateName: "", customSubject: "Quick follow-up", customBody: "Hi {{first_name}},\n\nI know you're busy..." },
    { id: 3, delayHours: 168, templateId: null, templateName: "", customSubject: "Final reach out", customBody: "Hi {{first_name}},\n\nI wanted to try one more time..." },
  ];
  return {
    settings: {
      emailProvider: settings?.emailProvider ?? 'gmail',
      senderName: settings?.senderName ?? '',
      senderEmail: settings?.senderEmail ?? '',
      replyToEmail: settings?.replyToEmail ?? '',
      emailSignature: settings?.emailSignature ?? '',
      enableAutoFollowUp: settings?.enableAutoFollowUp ?? true,
      followUpDelay: settings?.followUpDelay ?? 3,
      followUpDelayHours: settings?.followUpDelayHours ?? 72,
      maxFollowUps: settings?.maxFollowUps ?? 3,
      enableTracking: settings?.enableTracking ?? true,
      personalizeMessages: settings?.personalizeMessages ?? true,
      sendTimeOptimization: settings?.sendTimeOptimization ?? true,
      dailyEmailLimit: settings?.dailyEmailLimit ?? 200,
      autoTicketDedupWindowMinutes: settings?.autoTicketDedupWindowMinutes ?? 30,
      blockOnZeroCredit: settings?.blockOnZeroCredit ?? false,
      followUps: supportedFollowUps(settings?.channelFollowUps ?? defaultChannelFollowUps),
      // Never return the webhook or credential-bearing configuration.
      slackWebhookConfigured: Boolean(settings?.slackWebhookUrl),
    },
    followUpSteps: Array.isArray(settings?.followUpSteps) && settings.followUpSteps.length > 0
      ? settings.followUpSteps
      : defaultFollowUpSteps,
  };
}

// Lead Settings
export async function getLeadSettings(req: AuthRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const settings = await getLeadSettingsByUserId(userId);
    res.json(serializeLeadSettings(settings));
  } catch (error) {
    logger.error({ err: error }, 'Error fetching lead settings');
    res.status(500).json({ error: "Unable to retrieve lead settings. Please try again." });
  }
}

export async function updateLeadSettings(req: AuthRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const body = req.body ?? {};
    const current = serializeLeadSettings(await getLeadSettingsByUserId(userId));
    const merged = { ...current, ...body };
    const minLeadScore = Number(merged.minLeadScore);
    const allowedSources = new Set(["linkedin", "google", "justdial", "instagram", "facebook", "twitter"]);
    const leadSources = Array.isArray(merged.leadSources)
      ? [...new Set(merged.leadSources.filter((source: unknown): source is string => typeof source === "string" && allowedSources.has(source)))]
      : [];

    if (!Number.isInteger(minLeadScore) || minLeadScore < 0 || minLeadScore > 100) {
      return res.status(400).json({ error: "Minimum lead score must be between 0 and 100" });
    }
    if (leadSources.length === 0 || leadSources.length !== merged.leadSources.length) {
      return res.status(400).json({ error: "Select at least one valid lead source" });
    }
    const booleanFields = ['autoQualify', 'enableDuplicateCheck', 'autoEnrich', 'notifyOnHighScore'] as const;
    if (booleanFields.some(field => !isBoolean(merged[field]))) {
      return res.status(400).json({ error: "Lead automation settings must be boolean values" });
    }

    const settings = await upsertLeadSettings(userId, {
      minLeadScore,
      leadSources: leadSources as string[],
      autoQualify: merged.autoQualify,
      enableDuplicateCheck: merged.enableDuplicateCheck,
      autoEnrich: merged.autoEnrich,
      notifyOnHighScore: merged.notifyOnHighScore,
    });
    res.json(serializeLeadSettings(settings));
  } catch (error) {
    logger.error({ err: error }, 'Error updating lead settings');
    res.status(500).json({ error: "Unable to update lead settings. Please try again." });
  }
}

// Outreach Settings
export async function getOutreachSettings(req: AuthRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const settings = await getOutreachSettingsByUserId(userId);
    res.json(serializeOutreachSettings(settings));
  } catch (error) {
    logger.error({ err: error }, 'Error fetching outreach settings');
    res.status(500).json({ error: "Unable to retrieve outreach settings. Please try again." });
  }
}

export async function updateOutreachSettings(req: AuthRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const body = req.body ?? {};
    const allowedProviders = new Set(['gmail', 'smtp', 'sendgrid', 'mailgun', 'ses']);
    const update: Record<string, unknown> = {};

    if ('emailProvider' in body) {
      if (typeof body.emailProvider !== 'string' || !allowedProviders.has(body.emailProvider)) {
        return res.status(400).json({ error: 'Select a valid email provider' });
      }
      update.emailProvider = body.emailProvider;
    }
    for (const [field, maxLength] of [
      ['senderName', 150],
      ['senderEmail', 320],
      ['replyToEmail', 320],
      ['emailSignature', 5000],
    ] as const) {
      if (field in body) {
        try {
          update[field] = optionalText(body[field], maxLength);
        } catch (error) {
          return res.status(400).json({ error: `${field} ${(error as Error).message}` });
        }
      }
    }
    for (const field of ['senderEmail', 'replyToEmail'] as const) {
      const value = update[field];
      if (typeof value === 'string' && value && !EMAIL_PATTERN.test(value)) {
        return res.status(400).json({ error: `${field} must be a valid email address` });
      }
    }
    for (const field of ['enableAutoFollowUp', 'enableTracking', 'personalizeMessages', 'sendTimeOptimization', 'blockOnZeroCredit'] as const) {
      if (field in body) {
        if (!isBoolean(body[field])) return res.status(400).json({ error: `${field} must be a boolean value` });
        update[field] = body[field];
      }
    }
    for (const [field, min, max] of [
      ['followUpDelay', 0, 365],
      ['followUpDelayHours', 0, 8760],
      ['maxFollowUps', 0, 10],
      ['dailyEmailLimit', 1, 100000],
      ['autoTicketDedupWindowMinutes', 1, 10080],
    ] as const) {
      if (field in body) {
        const value = Number(body[field]);
        if (!Number.isInteger(value) || value < min || value > max) {
          return res.status(400).json({ error: `${field} must be an integer between ${min} and ${max}` });
        }
        update[field] = value;
      }
    }
    if ('slackWebhookUrl' in body) {
      if (body.slackWebhookUrl === null || body.slackWebhookUrl === '') {
        update.slackWebhookUrl = null;
      } else {
        try {
          const webhook = new URL(String(body.slackWebhookUrl));
          if (webhook.protocol !== 'https:' || webhook.username || webhook.password || webhook.toString().length > 2000) {
            throw new Error();
          }
          update.slackWebhookUrl = webhook.toString();
        } catch {
          return res.status(400).json({ error: 'Slack webhook must be a valid HTTPS URL' });
        }
      }
    }

    if ('followUpSteps' in body) {
      if (!Array.isArray(body.followUpSteps) || body.followUpSteps.length > 10) {
        return res.status(400).json({ error: 'Follow-up steps must contain no more than 10 entries' });
      }
      let previousHours = 0;
      for (let index = 0; index < body.followUpSteps.length; index += 1) {
        const step = body.followUpSteps[index] as Record<string, unknown>;
        const delayHours = Number(step?.delayHours);
        if (!step || !Number.isFinite(delayHours) || delayHours <= previousHours || delayHours > 8760) {
          return res.status(400).json({ error: `Follow-up step ${index + 1} must have a later valid delay` });
        }
        previousHours = delayHours;
      }
      update.followUpSteps = body.followUpSteps;
    }

    const followUps = body.followUps ?? body.channelFollowUps;
    if (followUps !== undefined) {
      if (!followUps || typeof followUps !== 'object' || Array.isArray(followUps)) {
        return res.status(400).json({ error: 'Channel follow-ups must be an object' });
      }
      const normalizedChannels: Record<string, unknown> = {};
      for (const [channel, rawConfig] of Object.entries(followUps)) {
        if (!OUTREACH_CHANNELS.has(channel) || !rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
          return res.status(400).json({ error: `Invalid follow-up channel: ${channel}` });
        }
        const config = rawConfig as Record<string, unknown>;
        if (!isBoolean(config.enabled) || !Array.isArray(config.followUps) || config.followUps.length > 10) {
          return res.status(400).json({ error: `${channel} follow-up configuration is invalid` });
        }
        const maxFollowUps = Number(config.maxFollowUps);
        if (!Number.isInteger(maxFollowUps) || maxFollowUps < 0 || maxFollowUps > 10 || config.followUps.length > maxFollowUps) {
          return res.status(400).json({ error: `${channel} max follow-ups must be between 0 and 10` });
        }
        let previousMinutes = 0;
        const steps = config.followUps.map((rawStep, index) => {
          if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
            throw new Error(`${channel} follow-up step ${index + 1} is invalid`);
          }
          const step = rawStep as Record<string, unknown>;
          const delayDays = Number(step.delayDays ?? 0);
          const delayHours = Number(step.delayHours ?? 0);
          const delayMinutes = Number(step.delayMinutes ?? 0);
          if (![delayDays, delayHours, delayMinutes].every(Number.isInteger) ||
              delayDays < 0 || delayHours < 0 || delayMinutes < 0 || delayHours > 23 || delayMinutes > 59 ||
              !isBoolean(step.enabled)) {
            throw new Error(`${channel} follow-up step ${index + 1} has an invalid delay`);
          }
          const totalMinutes = delayDays * 1440 + delayHours * 60 + delayMinutes;
          if (step.enabled && (totalMinutes <= previousMinutes || totalMinutes > 525600)) {
            throw new Error(`${channel} follow-up step ${index + 1} must have a later valid delay`);
          }
          if (step.enabled) previousMinutes = totalMinutes;
          return {
            id: String(step.id ?? index + 1).slice(0, 100),
            delayDays,
            delayHours,
            delayMinutes,
            enabled: step.enabled,
            templateId: step.templateId === null || step.templateId === undefined ? null : Number(step.templateId),
            templateName: typeof step.templateName === 'string' ? step.templateName.slice(0, 200) : '',
          };
        });
        for (const step of steps) {
          if (step.templateId !== null && (!Number.isSafeInteger(step.templateId) || (step.templateId < 1 && step.templateId !== -1))) {
            return res.status(400).json({ error: 'Invalid follow-up template' });
          }
          if (config.enabled && step.enabled && step.templateId && step.templateId > 0 && isFollowUpChannel(channel)) {
            await loadFollowUpTemplate(userId, channel, step.templateId);
          }
        }
        normalizedChannels[channel] = { enabled: config.enabled, maxFollowUps, followUps: steps };
      }
      update.channelFollowUps = normalizedChannels;
    }

    const settings = await upsertOutreachSettings(userId, update);
    res.json(serializeOutreachSettings(settings));
  } catch (error) {
    if (error instanceof FollowUpSettingsConflictError) return res.status(409).json({ error: error.message, code: 'FOLLOW_UP_SETTINGS_CONFLICT' });
    if (error instanceof ContentBrandContextError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof FollowUpTemplateError) return res.status(400).json({ error: error.message });
    if (error instanceof Error && error.message.includes('follow-up step')) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, 'Error updating outreach settings');
    res.status(500).json({ error: "Unable to update outreach settings. Please try again." });
  }
}

// User Preferences
export async function getUserPreferences(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const prefs = await getUserPreferencesByUserId(userId);
    
    res.json(serializePreferences(prefs));
  } catch (error) {
    logger.error({ err: error }, 'Error fetching user preferences');
    res.status(500).json({ error: "Unable to retrieve user preferences. Please try again." });
  }
}

export async function updateUserPreferences(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const body = req.body ?? {};
    const language = String(body.language ?? '');
    const locale = String(body.locale ?? '');
    const currency = String(body.currency ?? '').toUpperCase();
    const theme = String(body.theme ?? '');
    const requestedTimezone = String(body.timezone ?? '');
    const timezone = ['India/Kolkata', 'Asia/Calcutta'].includes(requestedTimezone)
      ? DEFAULT_BUSINESS_TIMEZONE
      : requestedTimezone;
    const dateFormat = String(body.dateFormat ?? '');
    const timeFormat = String(body.timeFormat ?? '');
    const allowedLanguages = new Set(['en', 'es', 'fr', 'de', 'hi', 'ta']);
    const allowedLocales = new Set(['en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'hi-IN', 'ta-IN']);
    const allowedCurrencies = new Set(['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'SGD']);
    const allowedThemes = new Set(['light', 'dark', 'system']);
    const allowedDateFormats = new Set(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'MMM D, YYYY']);
    const allowedTimeFormats = new Set(['12h', '24h']);

    let timezoneIsValid = true;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    } catch {
      timezoneIsValid = false;
    }
    if (!allowedLanguages.has(language) || !allowedLocales.has(locale) ||
        !allowedCurrencies.has(currency) || !allowedThemes.has(theme) || !timezoneIsValid ||
        !allowedDateFormats.has(dateFormat) || !allowedTimeFormats.has(timeFormat)) {
      return res.status(400).json({ error: "One or more preferences are invalid" });
    }

    const prefs = await db.transaction(async (tx: typeof db) => {
      // Both timezone writers lock the user first, then update preferences.
      await tx.update(usersTable).set({ timezone, updatedAt: new Date() }).where(eq(usersTable.id, userId));
      return upsertUserPreferences(userId, {
        language,
        locale,
        currency,
        theme,
        timezone,
        dateFormat,
        timeFormat,
        // Mirror the legacy field until all deployed clients understand `theme`.
        darkMode: theme === 'dark',
      }, tx);
    });
    res.json(serializePreferences(prefs));
  } catch (error) {
    logger.error({ err: error }, 'Error updating user preferences');
    res.status(500).json({ error: "Unable to update user preferences. Please try again." });
  }
}

// ─── Integration-specific Follow-up Settings ───────────────────────────────
// GET /api/settings/integrations/:integrationKey/follow-ups
export async function getIntegrationFollowUpSettings(req: AuthRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    const { integrationKey } = req.params;
    if (!OUTREACH_CHANNELS.has(integrationKey)) {
      return res.status(400).json({ error: 'Unsupported outreach integration' });
    }
    
    const settings = await getOutreachSettingsByUserId(userId);
    
    type ReturnedFollowUpStep = FollowUpSettingsStep & { enabled: boolean; delayHours: number };
    const defaultFollowUpSteps: ReturnedFollowUpStep[] = [
      { id: 1, enabled: true, delayValue: 1, delayUnit: "days", delayHours: 24, templateId: null, templateName: "" },
      { id: 2, enabled: true, delayValue: 3, delayUnit: "days", delayHours: 72, templateId: null, templateName: "" },
      { id: 3, enabled: true, delayValue: 7, delayUnit: "days", delayHours: 168, templateId: null, templateName: "" },
    ];
    
    // The scheduler only runs configured, enabled channel steps behind the global master flag.
    // Keep defaults visible for setup, but never imply that an unconfigured schedule is active.
    const allChannelSettings = settings?.channelFollowUps as Record<string, unknown> | undefined;
    const rawChannelSettings = allChannelSettings?.[integrationKey];
    const chSettings = rawChannelSettings && typeof rawChannelSettings === 'object'
      ? rawChannelSettings as Record<string, unknown>
      : undefined;
    let followUpStepsToReturn: ReturnedFollowUpStep[] = defaultFollowUpSteps;

    if (Array.isArray(chSettings?.followUps) && chSettings.followUps.length > 0) {
      followUpStepsToReturn = chSettings.followUps.map<ReturnedFollowUpStep>((rawStep, idx) => {
        const step = rawStep && typeof rawStep === 'object' ? rawStep as Record<string, unknown> : {};
        const delayDays = Number(step.delayDays) || 0;
        const delayHours = Number(step.delayHours) || 0;
        const delayMinutes = Number(step.delayMinutes) || 0;
        // Legacy schedules can combine units or store fractional hours. Return
        // the complete duration as a whole value, using the largest exact unit.
        const rawMinutes = (delayDays * 1440) + (delayHours * 60) + delayMinutes;
        const totalMinutes = Math.abs(rawMinutes - Math.round(rawMinutes)) < 1e-7 ? Math.round(rawMinutes) : rawMinutes;
        const delayUnit: ReturnedFollowUpStep['delayUnit'] = totalMinutes > 0 && totalMinutes % 1440 === 0
          ? 'days' : totalMinutes > 0 && totalMinutes % 60 === 0 ? 'hours' : 'minutes';
        const delayValue = totalMinutes / (delayUnit === 'days' ? 1440 : delayUnit === 'hours' ? 60 : 1);

        return {
          id: isFollowUpStepId(step.id) ? step.id : idx + 1,
          enabled: step.enabled === true,
          delayValue,
          delayUnit,
          delayHours: totalMinutes / 60,
          templateId: typeof step.templateId === 'number' && Number.isSafeInteger(step.templateId)
            ? step.templateId
            : null,
          templateName: typeof step.templateName === 'string' ? step.templateName : '',
        };
      });
    }

    const enableAutoFollowUp = settings?.enableAutoFollowUp === true && hasEnabledChannelFollowUp(rawChannelSettings);
    
    res.json({
      integrationKey,
      revision: followUpSettingsRevision(rawChannelSettings),
      fenced: typeof chSettings?.revision === 'string',
      enableAutoFollowUp,
      followUpSteps: followUpStepsToReturn,
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching integration follow-up settings');
    res.status(500).json({ error: "Unable to retrieve follow-up settings. Please try again." });
  }
}

// PUT /api/settings/integrations/:integrationKey/follow-ups
export async function updateIntegrationFollowUpSettings(req: AuthRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    const { integrationKey } = req.params;
    const { enableAutoFollowUp, followUpSteps, expectedRevision } = req.body;
    if (!isFollowUpChannel(integrationKey)) {
      return res.status(400).json({ error: 'Unsupported outreach integration' });
    }
    if (expectedRevision !== undefined && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision))) {
      return res.status(400).json({ error: 'Invalid follow-up settings revision' });
    }
    if (!isBoolean(enableAutoFollowUp)) {
      return res.status(400).json({ error: 'Auto follow-up must be a boolean value' });
    }
    if (!Array.isArray(followUpSteps) || followUpSteps.length < 1 || followUpSteps.length > 10) {
      return res.status(400).json({ error: 'Provide between 1 and 10 follow-up steps' });
    }

    let previousMinutes = 0;
    const normalizedSteps = [];
    const channelFollowUps = [];
    const stepIds = new Set<string>();
    for (let index = 0; index < followUpSteps.length; index += 1) {
      const step = followUpSteps[index];
      if (!step || typeof step !== 'object' || !['minutes', 'hours', 'days'].includes(step.delayUnit)) {
        return res.status(400).json({ error: `Follow-up step ${index + 1} is invalid` });
      }
      const delayValue = Number(step.delayValue);
      const multiplier = step.delayUnit === 'days' ? 1440 : step.delayUnit === 'hours' ? 60 : 1;
      const totalMinutes = delayValue * multiplier;
      const enabled = step.enabled === undefined ? true : step.enabled;
      if (!isBoolean(enabled)) return res.status(400).json({ error: `Follow-up step ${index + 1} enabled must be a boolean` });
      if (!Number.isInteger(delayValue) || delayValue < (enabled ? 1 : 0) || (enabled && totalMinutes <= previousMinutes) || totalMinutes > 525600) {
        return res.status(400).json({ error: `Follow-up step ${index + 1} must occur later than the previous step` });
      }
      const templateId = step.templateId === null || step.templateId === undefined ? null : Number(step.templateId);
      if (templateId !== null && (!Number.isSafeInteger(templateId) || (templateId < 1 && templateId !== -1))) {
        return res.status(400).json({ error: `Follow-up step ${index + 1} has an invalid template` });
      }
      const templateName = typeof step.templateName === 'string' ? step.templateName.trim().slice(0, 200) : '';
      const id = step.id === undefined ? index + 1 : step.id;
      if (!isFollowUpStepId(id)) return res.status(400).json({ error: 'Follow-up step IDs must be valid identifiers' });
      if (stepIds.has(String(id))) return res.status(400).json({ error: 'Follow-up step IDs must be unique' });
      stepIds.add(String(id));
      if (enabled) previousMinutes = totalMinutes;
      normalizedSteps.push({
        id,
        enabled,
        delayValue,
        delayUnit: step.delayUnit,
        delayHours: totalMinutes / 60,
        templateId,
        templateName,
      });
      channelFollowUps.push({
        id: String(id),
        delayDays: Math.floor(totalMinutes / 1440),
        delayHours: Math.floor((totalMinutes % 1440) / 60),
        delayMinutes: totalMinutes % 60,
        enabled,
        templateId,
        templateName,
      });
    }

    if (enableAutoFollowUp && isFollowUpChannel(integrationKey)) {
      for (const templateId of new Set(normalizedSteps.filter(step => step.enabled).map(step => step.templateId))) {
        if (templateId && templateId > 0) await loadFollowUpTemplate(userId, integrationKey, templateId);
      }
    }
    const config = { enabled: enableAutoFollowUp, maxFollowUps: channelFollowUps.length, followUps: channelFollowUps };
    const saved = await saveChannelFollowUpSettings(userId, integrationKey, config, expectedRevision);
    
    res.json({
      success: true,
      integrationKey,
      fenced: typeof saved?.channelFollowUps?.[integrationKey]?.revision === 'string',
      advanced: saved.followUpFenceAdvanced,
      enableAutoFollowUp,
      revision: followUpSettingsRevision(saved?.channelFollowUps?.[integrationKey] ?? config),
      followUpSteps: normalizedSteps,
    });
  } catch (error) {
    if (error instanceof FollowUpSettingsConflictError) return res.status(409).json({ error: error.message, code: 'FOLLOW_UP_SETTINGS_CONFLICT' });
    if (error instanceof ContentBrandContextError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof FollowUpTemplateError) return res.status(400).json({ error: error.message });
    logger.error({ err: error }, 'Error updating integration follow-up settings');
    res.status(500).json({ error: "Unable to update follow-up settings. Please try again." });
  }
}
