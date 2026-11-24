import type { Request, Response } from "express";
import { z } from "zod";
import {
  acceptBusinessInvitation,
  BusinessProfileAccessError,
  changeBusinessStaff,
  inviteBusinessStaff,
  listBusinessInvitations,
  listBusinessStaff,
} from "../services/businessProfileStaff.js";
import { normalizeCapacityError } from "../services/billing/entitlements.js";
import { logger } from "../utils/logger.js";

const id = z.coerce.number().int().positive().safe();
const role = z.enum(["billing_admin", "member"]);
function handle(work: (req: Request) => Promise<unknown>, status = 200) {
  return async (req: Request, res: Response) => {
    try {
      return res.status(status).json(await work(req));
    } catch (error) {
      if (error instanceof BusinessProfileAccessError)
        return res
          .status(error.status)
          .json({ error: error.message, code: error.code });
      if (error instanceof z.ZodError)
        return res
          .status(400)
          .json({
            error: "Invalid staff request.",
            code: "INVALID_STAFF_REQUEST",
          });
      const capacity = normalizeCapacityError(error);
      if (capacity) return res.status(capacity.status).json(capacity.toJSON());
      logger.error({ err: error }, "Business staff request failed");
      return res
        .status(503)
        .json({ error: "Staff could not be updated. Please try again." });
    }
  };
}
export const getBusinessInvitations = handle((req) =>
  listBusinessInvitations(Number(req.user!.id)),
);
export const acceptBusinessStaffInvitation = handle((req) =>
  acceptBusinessInvitation(
    Number(req.user!.id),
    id.parse(req.params.invitationId),
  ),
);
export const getBusinessStaff = handle((req) =>
  listBusinessStaff(Number(req.user!.id), id.parse(req.params.id)),
);
export const addBusinessStaff = handle((req) => {
  const input = z
    .object({ email: z.string().trim().email().max(255), role })
    .strict()
    .parse(req.body);
  return inviteBusinessStaff(
    Number(req.user!.id),
    id.parse(req.params.id),
    input.email,
    input.role,
  );
}, 201);
export const updateBusinessStaff = handle((req) => {
  const input = z.object({ role }).strict().parse(req.body);
  return changeBusinessStaff(
    Number(req.user!.id),
    id.parse(req.params.id),
    id.parse(req.params.membershipId),
    input.role,
  );
});
export const removeBusinessStaff = handle((req) =>
  changeBusinessStaff(
    Number(req.user!.id),
    id.parse(req.params.id),
    id.parse(req.params.membershipId),
  ),
);
