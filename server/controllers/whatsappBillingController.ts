/**
 * Customer view of WhatsApp platform billing: what Meta message charges this
 * month cost the wallet, and a price quote before a WhatsApp send or outreach.
 * Both answer { platformBilled: false } for accounts that pay Meta themselves.
 */
import type { Request, Response } from 'express';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { logger } from '../utils/logger.js';
import { getWhatsAppBillingSummary, quoteWhatsAppBatch } from '../services/whatsapp/WhatsAppBillingService.js';

const MAX_QUOTE_ITEMS = 5000;

function phoneNumberIdOf(value: unknown): string | undefined {
  const id = String(value ?? '').trim();
  return /^\d{5,30}$/.test(id) ? id : undefined;
}

export async function getWhatsAppBilling(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.json(await getWhatsAppBillingSummary(userId, phoneNumberIdOf(req.query.phoneNumberId)));
  } catch (error) {
    logger.error({ err: error, userId }, '[WhatsAppBilling] Summary failed');
    return res.status(500).json({ error: 'WhatsApp message charges could not be loaded.' });
  }
}

export async function quoteWhatsAppMessages(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items?.length || items.length > MAX_QUOTE_ITEMS) {
    return res.status(400).json({ error: `Send between 1 and ${MAX_QUOTE_ITEMS.toLocaleString('en-US')} messages to price.` });
  }
  try {
    const quote = await quoteWhatsAppBatch({
      userId,
      phoneNumberId: phoneNumberIdOf(req.body?.phoneNumberId),
      items: items.map((item: Record<string, unknown>) => ({
        recipient: typeof item?.recipient === 'string' ? item.recipient.slice(0, 40) : undefined,
        templateName: typeof item?.templateName === 'string' ? item.templateName.slice(0, 512) : undefined,
        templateLanguage: typeof item?.templateLanguage === 'string' ? item.templateLanguage.slice(0, 20) : undefined,
      })),
    });
    return res.json(quote);
  } catch (error) {
    logger.error({ err: error, userId }, '[WhatsAppBilling] Quote failed');
    return res.status(500).json({ error: 'The WhatsApp message price could not be worked out.' });
  }
}
