import { Router } from 'express';
import { getCurrentPlatformAccess } from '../controllers/platformAccessController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();

router.get('/access', authenticateToken, getCurrentPlatformAccess);

export default router;
