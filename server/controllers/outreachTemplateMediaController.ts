import multer from "multer";
import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/express.js";
import { businessOwnerUserId } from "../tenancy/businessContext.js";
import { whatsappApiService } from "../services/whatsappApiService.js";
import { templateMediaSignatureMatches } from "./whatsappTemplateMediaPreflightController.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 2 },
}).single("file");
const rules: Record<string, { mimes: string[]; bytes: number }> = {
  image: { mimes: ["image/jpeg", "image/png"], bytes: 5 * 1024 * 1024 },
  video: { mimes: ["video/mp4"], bytes: 10 * 1024 * 1024 },
  document: { mimes: ["application/pdf"], bytes: 10 * 1024 * 1024 },
};

export function templateMediaUpload(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  if (!req.user?.id || !businessOwnerUserId(req))
    return res.status(401).json({ error: "Unauthorized" });
  upload(req, res, (error) =>
    error
      ? res
          .status(400)
          .json({
            error:
              "Upload one supported file, up to 5 MB for images or 10 MB for video and PDF.",
          })
      : next(),
  );
}

/** Uploads to the selected WhatsApp account, without sending a customer message. */
export async function uploadOutreachTemplateMedia(
  req: AuthenticatedRequest,
  res: Response,
) {
  const userId = businessOwnerUserId(req);
  if (!req.user?.id || !userId)
    return res.status(401).json({ error: "Unauthorized" });
  const { providerAccountId, mediaType } = req.body || {};
  const rule = typeof mediaType === "string" ? rules[mediaType] : undefined;
  const file = req.file;
  if (
    typeof providerAccountId !== "string" ||
    !/^\d{1,40}$/.test(providerAccountId) ||
    !rule ||
    !file ||
    !rule.mimes.includes(file.mimetype) ||
    file.size > rule.bytes ||
    !templateMediaSignatureMatches(file.buffer, file.mimetype)
  ) {
    return res
      .status(400)
      .json({
        error:
          "Choose a valid JPG, PNG, MP4 or PDF for this template. Images must be under 5 MB; video and PDF under 10 MB.",
      });
  }
  try {
    const result = await whatsappApiService.uploadTemplateMedia({
      userId,
      phoneNumberId: providerAccountId,
      buffer: file.buffer,
      mimeType: file.mimetype,
      fileName: file.originalname,
    });
    return res.json({
      mediaId: result.id,
      fileName: file.originalname,
      mediaType,
    });
  } catch {
    return res
      .status(400)
      .json({
        error:
          "WhatsApp could not accept this upload. Check the sending account and try again.",
      });
  }
}
