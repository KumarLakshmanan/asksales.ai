/**
 * Credit Check Middleware
 * Blocks requests when user has insufficient credits (balance <= 0)
 */

import type { Request, Response, NextFunction } from 'express';
import { getBalance } from '../models/wallets/functions.js';
import { logger } from '../utils/logger.js';

/**
 * Middleware that checks if the user has a positive credit balance.
 * Must be used AFTER authenticateToken middleware.
 * Returns 402 Payment Required if credits are exhausted.
 */
export async function requireCredits(req: Request, res: Response, next: NextFunction) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const balance = await getBalance(userId);

    if (balance <= 0) {
      logger.warn({ userId, balance }, '[CreditCheck] Insufficient credits - request blocked');
      return res.status(402).json({
        error: 'Insufficient credits',
        message: 'Your credit balance is exhausted. Please recharge your wallet to continue using this service.',
        balance,
        code: 'INSUFFICIENT_CREDITS',
      });
    }

    // Attach balance to request for downstream use
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).creditBalance = balance;
    next();
  } catch (error) {
    logger.error({ err: error }, '[CreditCheck] Error checking credit balance');
    // Return 503 instead of allowing through — a credit DB failure is not a safe pass-through
    return res.status(503).json({
      error: 'Service temporarily unavailable',
      message: 'Unable to verify your credit balance. Please try again in a moment.',
      code: 'CREDIT_CHECK_ERROR',
    });
  }
}

/**
 * Helper to check credits programmatically (for use in services/controllers)
 * Returns { allowed: true, balance } or { allowed: false, balance, error }
 */
export async function checkUserCredits(userId: number): Promise<{
  allowed: boolean;
  balance: number;
  error?: string;
}> {
  try {
    const balance = await getBalance(userId);
    if (balance <= 0) {
      return {
        allowed: false,
        balance,
        error: 'Insufficient credits. Please recharge your wallet to continue.',
      };
    }
    return { allowed: true, balance };
  } catch (error) {
    logger.error({ err: error, userId }, '[CreditCheck] Error checking credits');
    // A failed balance lookup cannot authorize paid work.
    return { allowed: false, balance: 0, error: "Credit balance could not be verified. Please try again." };
  }
}
