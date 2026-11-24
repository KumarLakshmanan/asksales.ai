import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
  getBusinessJourneyReadiness,
  listProviderVerificationStatus,
  runProviderVerification,
} from '../controllers/providerVerificationController.js';

const router = Router();
router.use(authenticateToken);
router.get('/', listProviderVerificationStatus);
router.get('/business-journeys', getBusinessJourneyReadiness);
router.post('/:platform/verify', runProviderVerification);

export default router;
