import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/express.js";
import { businessOwnerUserId } from "../tenancy/businessContext.js";
import {
  INBOX_CHANNELS,
  type InboxChannel,
} from "../../shared/outreachInbox.js";
import {
  getCreationOptions,
  getCreationRecipients,
  getCreationTemplates,
  prepareCreationContact,
} from "../services/outreach/CreationService.js";
import { logger } from "../utils/logger.js";
import { getCreationImportSources, type ImportSourceFilter } from '../services/outreach/CreationImportSources.js';

export async function getOutreachCreationImportSources(req: AuthenticatedRequest, res: Response) {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.json(await getCreationImportSources(userId));
  } catch (error) {
    logger.error({ err: error }, '[OutreachCreation] Import sources could not be loaded');
    return res.status(503).json({ error: 'Import filters could not be loaded. Try again.' });
  }
}

export async function prepareOutreachCreationContact(
  req: AuthenticatedRequest,
  res: Response,
) {
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
  const userId = businessOwnerUserId(req);
  const { contactId, channel, providerAccountId, senderId } = req.body || {};
  if (
    !Number.isSafeInteger(contactId) ||
    contactId <= 0 ||
    !INBOX_CHANNELS.includes(channel) ||
    (providerAccountId !== undefined &&
      (typeof providerAccountId !== "string" ||
        providerAccountId.length > 255)) ||
    (senderId !== undefined &&
      (!Number.isSafeInteger(senderId) || senderId <= 0))
  )
    return res.status(400).json({
      error: "Choose a valid CRM contact, channel and sending account.",
    });
  try {
    const result = await prepareCreationContact(userId, contactId, channel, {
      providerAccountId,
      senderId,
    });
    return res.status(result.error ? 409 : 200).json(result);
  } catch (error) {
    logger.error(
      { err: error, contactId },
      "[OutreachCreation] CRM contact could not be prepared",
    );
    return res.status(503).json({
      error: "This contact could not be prepared for outreach. Try again.",
    });
  }
}

export async function getOutreachCreationOptions(
  req: AuthenticatedRequest,
  res: Response,
) {
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const channel = req.query.channel as InboxChannel;
  if (!INBOX_CHANNELS.includes(channel))
    return res
      .status(400)
      .json({ error: "Choose a supported outreach channel." });
  try {
    return res.json(await getCreationOptions(userId, channel));
  } catch (error) {
    logger.error(
      { err: error },
      "[OutreachCreation] Accounts could not be loaded",
    );
    return res
      .status(503)
      .json({ error: "Sending accounts could not be loaded. Try again." });
  }
}

export async function getOutreachCreationTemplates(
  req: AuthenticatedRequest,
  res: Response,
) {
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (
    typeof req.query.providerAccountId !== "string" ||
    !req.query.providerAccountId ||
    req.query.providerAccountId.length > 255
  )
    return res
      .status(400)
      .json({ error: "Choose a WhatsApp sending account." });
  try {
    return res.json({
      templates: await getCreationTemplates(
        userId,
        req.query.providerAccountId,
        { forSelection: true },
      ),
    });
  } catch (error) {
    logger.warn(
      { err: error },
      "[OutreachCreation] WhatsApp templates could not be loaded",
    );
    return res.status(503).json({
      error:
        "Approved templates could not be loaded from this WhatsApp account. Check the connection and try again.",
    });
  }
}

export async function getOutreachCreationRecipients(
  req: AuthenticatedRequest,
  res: Response,
) {
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const channel = req.query.channel as InboxChannel;
  if (!INBOX_CHANNELS.includes(channel))
    return res
      .status(400)
      .json({ error: "Choose a supported outreach channel." });
  const { ids, search, after, threadId, providerAccountId, senderId, importSource, importId, campaignId } =
    req.query;
  const integer = (value: unknown) =>
    typeof value === "string" &&
    /^\d+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0;
  if (
    (search !== undefined &&
      (typeof search !== "string" || search.length > 200)) ||
    (providerAccountId !== undefined &&
      (typeof providerAccountId !== "string" ||
        providerAccountId.length > 255)) ||
    [after, threadId, senderId, importId].some(
      (value) => value !== undefined && !integer(value),
    ) ||
    (campaignId !== undefined && campaignId !== 'unassigned' && !integer(campaignId)) ||
    (importSource !== undefined && (typeof importSource !== 'string' || !['crm', 'campaign', 'campaign_legacy'].includes(importSource))) ||
    ((importId !== undefined || campaignId !== undefined) && importSource === undefined) ||
    (importSource === 'crm' && campaignId !== undefined) ||
    (importSource === 'campaign_legacy' && importId !== undefined) ||
    (importSource !== undefined && (ids !== undefined || threadId !== undefined))
  )
    return res.status(400).json({ error: "Invalid recipient search." });
  const leadIds = typeof ids === "string" ? ids.split(",") : undefined;
  if (
    ids !== undefined &&
    (!leadIds?.length ||
      leadIds.some((id) => !integer(id)))
  )
    return res
      .status(400)
      .json({ error: "Choose at least one valid contact." });
  try {
    return res.json(
      await getCreationRecipients(
        userId,
        channel,
        {
          providerAccountId: providerAccountId as string | undefined,
          senderId: senderId ? Number(senderId) : undefined,
        },
        {
          ids: leadIds?.map(Number),
          search: search as string | undefined,
          after: after ? Number(after) : undefined,
          threadId: threadId ? Number(threadId) : undefined,
          importFilter: importSource ? {
            source: importSource as ImportSourceFilter['source'],
            ...(importId ? { importId: Number(importId) } : {}),
            ...(campaignId ? { campaignId: campaignId === 'unassigned' ? 'unassigned' as const : Number(campaignId) } : {}),
          } : undefined,
        },
      ),
    );
  } catch (error) {
    logger.error(
      { err: error },
      "[OutreachCreation] Recipients could not be checked",
    );
    return res.status(503).json({
      error: "Recipients could not be checked. Try again before sending.",
    });
  }
}

/** Read-only full-selection check. Keep database bind counts bounded without
 * requiring one browser request per chunk or changing the selected audience. */
export async function reviewOutreachCreationRecipients(req: AuthenticatedRequest, res: Response) {
  if (!req.user?.id) return res.status(401).json({error:'Unauthorized'});
  const userId=businessOwnerUserId(req);
  if (!userId) return res.status(401).json({error:'Unauthorized'});
  const {channel,ids,providerAccountId,senderId}=req.body || {};
  if (!INBOX_CHANNELS.includes(channel) || !Array.isArray(ids) || !ids.length
    || ids.some(id=>!Number.isSafeInteger(id) || id<=0)
    || (providerAccountId!==undefined && (typeof providerAccountId!=='string' || providerAccountId.length>255))
    || (senderId!==undefined && (!Number.isSafeInteger(senderId) || senderId<=0)))
    return res.status(400).json({error:'Choose valid contacts, channel and sending account.'});
  try {
    const uniqueIds=[...new Set<number>(ids)];
    const recipients:Awaited<ReturnType<typeof getCreationRecipients>>['recipients']=[];
    const sentTo=new Map<string,string>();
    for(let offset=0;offset<uniqueIds.length;offset+=1000) {
      const checked=await getCreationRecipients(userId,channel,{providerAccountId,senderId},{ids:uniqueIds.slice(offset,offset+1000),sentTo});
      recipients.push(...checked.recipients);
    }
    return res.json({recipients,nextCursor:null});
  } catch(error) {
    logger.error({err:error},'[OutreachCreation] Selected recipients could not be checked');
    return res.status(503).json({error:'Recipients could not be checked. Try again before sending.'});
  }
}
