import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { validateBody } from "../middleware/validation.js";
import { optOutSchema, dataExportRequestSchema } from "../middleware/privacySchemas.js";
import { privacyController } from "../controllers/privacyController.js";

const router = Router();

// All privacy endpoints require a valid session token.
router.use(authenticateToken);

router.get("/consents", privacyController.listConsents);
router.get("/status", privacyController.status);
router.post("/opt-out", validateBody(optOutSchema), privacyController.optOut);
router.post("/opt-in", validateBody(optOutSchema), privacyController.optIn);
router.post("/data-export", validateBody(dataExportRequestSchema), privacyController.dataExport);

export default router;
