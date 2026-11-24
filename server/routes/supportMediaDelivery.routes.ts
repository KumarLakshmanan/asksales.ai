import { Router } from 'express';
import { getSupportMediaDeliveryAsset } from '../controllers/supportMediaDeliveryController.js';

const router = Router();

router.get('/:assetId/image.jpg', getSupportMediaDeliveryAsset);

export default router;
