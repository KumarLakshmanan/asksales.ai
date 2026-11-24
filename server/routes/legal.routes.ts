import { Router } from "express";
import { validateBody } from "../middleware/validation.js";
import { accountDeletionRequestSchema } from "../middleware/schemas.js";
import {
  listPublishedPolicies,
  getPublishedPolicyBySlug,
  submitAccountDeletionRequest,
} from "../controllers/legalController.js";

const router = Router();

router.get("/policies", listPublishedPolicies);
router.get("/policies/:slug", getPublishedPolicyBySlug);
router.post("/account-deletion-requests", validateBody(accountDeletionRequestSchema), submitAccountDeletionRequest);

export default router;
