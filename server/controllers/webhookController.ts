/**
 * Webhook Controller
 * Handles incoming webhooks for reply detection and delivery tracking
 * Note: SendGrid and Twilio integrations have been removed
 */

import type { Request, Response } from "express";
import { logger } from '../utils/logger.js';

/**
 * POST /api/webhooks/sendgrid
 * Handle SendGrid webhook events - DEPRECATED (SendGrid integration removed)
 */
export async function handleSendGridWebhook(req: Request, res: Response) {
  try {
    logger.info('[WebhookController] SendGrid webhook received but integration has been removed');
    res.status(200).json({ success: false, error: 'SendGrid integration has been removed' });
  } catch (error) {
    logger.error({ err: error }, '[WebhookController] Error handling SendGrid webhook');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/webhooks/twilio
 * Handle Twilio webhook events - DEPRECATED (Twilio integration removed)
 */
export async function handleTwilioWebhook(req: Request, res: Response) {
  try {
    logger.info('[WebhookController] Twilio webhook received but integration has been removed');
    res.status(200).json({ success: false, error: 'Twilio integration has been removed' });
  } catch (error) {
    logger.error({ err: error }, '[WebhookController] Error handling Twilio webhook');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/webhooks/twilio/inbound
 * Handle inbound SMS messages - DEPRECATED (Twilio integration removed)
 */
export async function handleTwilioInboundSMS(req: Request, res: Response) {
  try {
    logger.info('[WebhookController] Twilio inbound SMS received but integration has been removed');
    res.status(200).json({ success: false, error: 'Twilio integration has been removed' });
  } catch (error) {
    logger.error({ err: error }, '[WebhookController] Error handling Twilio inbound SMS');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/webhooks/sendgrid/inbound
 * Handle inbound emails - DEPRECATED (SendGrid integration removed)
 */
export async function handleSendGridInboundEmail(req: Request, res: Response) {
  try {
    logger.info('[WebhookController] SendGrid inbound email received but integration has been removed');
    res.status(200).json({ success: false, error: 'SendGrid integration has been removed' });
  } catch (error) {
    logger.error({ err: error }, '[WebhookController] Error handling SendGrid inbound email');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/webhooks/health
 * Health check endpoint for webhook receivers
 */
export async function webhookHealthCheck(req: Request, res: Response) {
  try {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      note: 'SendGrid and Twilio integrations have been removed. Use Gmail for email and Instagram for messaging.',
      endpoints: [
        'POST /api/webhooks/gmail (active)',
        'POST /api/webhooks/instagram (active)',
      ]
    });
  } catch (error) {
    logger.error({ err: error }, '[WebhookController] Error in health check');
    res.status(500).json({ error: 'Internal server error' });
  }
}
