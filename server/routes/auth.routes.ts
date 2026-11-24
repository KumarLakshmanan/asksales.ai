/**
 * Auth Routes Module
 * Handles authentication endpoints: login, register, password reset, verification
 */

import { Router } from 'express';
import { validateBody } from '../middleware/validation.js';
import { authRateLimiter } from '../middleware/rateLimiter.js';
import {
  registerSchema,
  loginSchema,
  googleSignInSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  resendVerificationSchema,
  verifyEmailSchema,
} from '../middleware/schemas.js';
import {
  register,
  login,
  googleSignIn,
  verifyEmail,
  forgotPassword,
  resetPassword,
  getCurrentUser,
  resendVerificationEmail,
  markSetupComplete,
  logout,
} from '../controllers/authController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();

// Public auth routes (validated)
router.get('/csrf-token', (_req, res) => res.json({ ok: true }));
router.post('/register', authRateLimiter, validateBody(registerSchema), register);
router.post('/login', authRateLimiter, validateBody(loginSchema), login);
router.post('/google', authRateLimiter, validateBody(googleSignInSchema), googleSignIn);
router.post('/logout', logout);
router.post('/verify-email', authRateLimiter, validateBody(verifyEmailSchema), verifyEmail);
router.post('/forgot-password', authRateLimiter, validateBody(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', authRateLimiter, validateBody(resetPasswordSchema), resetPassword);
router.post('/resend-verification', authRateLimiter, validateBody(resendVerificationSchema), resendVerificationEmail);

// Protected auth routes
router.get('/me', authenticateToken, getCurrentUser);
router.post('/setup-complete', authenticateToken, markSetupComplete);
router.post('/mark-setup-complete', authenticateToken, markSetupComplete);

export default router;
