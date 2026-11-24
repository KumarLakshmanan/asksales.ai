import type { Request, Response } from "express";
import { randomBytes, createHash } from "node:crypto";
import { getRedisConnection } from "../infrastructure/redis.js";
import type Redis from "ioredis";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { z } from "zod";
import {
  businessOwnerUserId,
  requireBusinessScope,
  withBusinessScope,
  type BusinessScope,
} from "../tenancy/businessContext.js";
import { objectStorage } from "../services/ObjectStorageService.js";
import {
  actorFolders,
  listWorkspaceFiles,
  mutateWorkspace,
  publicFile,
  storageActivity,
  storageMutationSchema,
  storageQuerySchema,
  StorageWorkspaceError,
  workspaceFile,
  workspaceOverview,
} from "../services/storageWorkspace.js";
import { storageByteRange, storageZip } from "../utils/storageZip.js";
import { logger } from "../utils/logger.js";

function fileId(req: Request) {
  return z.coerce.number().int().positive().parse(req.params.fileId);
}
function failure(res: Response, error: unknown) {
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  if (error instanceof z.ZodError)
    return res
      .status(400)
      .json({ error: error.issues[0]?.message || "Invalid storage request" });
  if (error instanceof StorageWorkspaceError)
    return res.status(error.status).json({ error: error.message });
  logger.error({ err: error }, "[Storage workspace] Request failed");
  return res
    .status(500)
    .json({ error: "Storage operation failed. Refresh and try again." });
}
const ok = (res: Response, data: unknown) => res.json({ success: true, data });
export async function getStorageWorkspace(req: Request, res: Response) {
  try {
    return ok(res, await workspaceOverview(businessOwnerUserId(req)));
  } catch (error) {
    return failure(res, error);
  }
}
export async function getStorageWorkspaceFiles(req: Request, res: Response) {
  try {
    return ok(
      res,
      await listWorkspaceFiles(
        businessOwnerUserId(req),
        storageQuerySchema.parse(req.query),
      ),
    );
  } catch (error) {
    return failure(res, error);
  }
}
export async function getStorageWorkspaceFile(req: Request, res: Response) {
  try {
    return ok(
      res,
      publicFile(
        await workspaceFile(businessOwnerUserId(req), fileId(req), true),
      ),
    );
  } catch (error) {
    return failure(res, error);
  }
}
export async function changeStorageWorkspace(req: Request, res: Response) {
  try {
    return ok(
      res,
      await mutateWorkspace(
        businessOwnerUserId(req),
        storageMutationSchema.parse(req.body),
      ),
    );
  } catch (error) {
    return failure(res, error);
  }
}
export async function getStorageActorFolders(req: Request, res: Response) {
  try {
    const query = z
      .object({
        search: z.string().max(255).default(""),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .parse(req.query);
    return ok(
      res,
      await actorFolders(businessOwnerUserId(req), query.search, query.offset),
    );
  } catch (error) {
    return failure(res, error);
  }
}
export async function getStorageActivity(req: Request, res: Response) {
  try {
    return ok(
      res,
      await storageActivity(
        businessOwnerUserId(req),
        z.coerce
          .number()
          .int()
          .min(0)
          .max(1000000)
          .default(0)
          .parse(req.query.offset),
      ),
    );
  } catch (error) {
    return failure(res, error);
  }
}
async function open(
  file: { storageKey: string },
  range?: { start: number; end: number },
) {
  if (!objectStorage.openReadStream)
    throw new Error("Storage streaming is unavailable");
  return objectStorage.openReadStream(file.storageKey, range);
}
export async function streamStorageFile(req: Request, res: Response) {
  try {
    const file = await workspaceFile(businessOwnerUserId(req), fileId(req));
    let range;
    try {
      range = storageByteRange(req.headers.range, file.fileSizeBytes);
    } catch {
      res.setHeader("Content-Range", `bytes */${file.fileSizeBytes}`);
      return res.status(416).end();
    }
    const stream = await open(file, range);
    const name = file.originalName || file.fileName;
    const inline =
      req.query.inline === "true" &&
      /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm)|audio\/(mpeg|wav)|application\/pdf|text\/plain|application\/json)$/.test(
        file.mimeType || "",
      );
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    res.setHeader(
      "Content-Length",
      range ? range.end - range.start + 1 : file.fileSizeBytes,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'",
    );
    res.setHeader("Accept-Ranges", "bytes");
    if (range) {
      res.status(206);
      res.setHeader(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${file.fileSizeBytes}`,
      );
    }
    await pipeline(stream, res);
  } catch (error) {
    failure(res, error);
  }
}
// Cached thumbnails remain private: ownership and active state are checked before
// every cache hit, and the bounded cache holds only resized pixels.
const thumbnails = new Map<string, Buffer>();
export async function getStorageThumbnail(req: Request, res: Response) {
  try {
    const file = await workspaceFile(businessOwnerUserId(req), fileId(req));
    if (
      !/^image\/(png|jpeg|gif|webp)$/.test(file.mimeType || "") ||
      file.fileSizeBytes > 10 * 1024 * 1024
    )
      throw new StorageWorkspaceError("No thumbnail available", 404);
    const key = `${file.businessProfileId}:${file.userId}:${file.id}:${file.updatedAt.toISOString()}`;
    let pixels = thumbnails.get(key);
    if (!pixels) {
      const stream = await open(file);
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for await (const chunk of stream) {
          bytes += chunk.length;
          if (bytes > 10 * 1024 * 1024) throw new Error("Image is too large");
          chunks.push(Buffer.from(chunk));
        }
      } finally {
        stream.destroy();
      }
      pixels = await sharp(Buffer.concat(chunks), {
        limitInputPixels: 40_000_000,
        animated: false,
      })
        .rotate()
        .resize(400, 240, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();
      if (thumbnails.size >= 100)
        thumbnails.delete(thumbnails.keys().next().value!);
      thumbnails.set(key, pixels);
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.type("image/webp").send(pixels);
  } catch (error) {
    failure(res, error);
  }
}
type DownloadTicket = {
  scope: Omit<BusinessScope, "kind">;
  ids: number[];
  expires: number;
};
let downloadRedis: Redis | undefined;
function ticketStore() {
  // Use the existing shared Redis deployment, with bounded request failure.
  downloadRedis ||= getRedisConnection().duplicate({
    maxRetriesPerRequest: 1,
    commandTimeout: 5000,
    enableOfflineQueue: true,
  });
  return downloadRedis;
}
const ticketKey = (ticket: string) =>
  `storage:download:${createHash("sha256").update(ticket).digest("hex")}`;
export async function createStorageDownload(req: Request, res: Response) {
  try {
    const { fileIds } = z
      .object({ fileIds: z.array(z.number().int().positive()).min(1).max(200) })
      .parse(req.body);
    const ids = [...new Set(fileIds)],
      owner = businessOwnerUserId(req);
    let total = 0;
    for (const id of ids)
      total += (await workspaceFile(owner, id)).fileSizeBytes;
    if (ids.length > 1 && total > 500 * 1024 * 1024)
      throw new StorageWorkspaceError("Select up to 500 MB per ZIP download.");
    const scope = requireBusinessScope(),
      ticket = randomBytes(32).toString("base64url");
    const value: DownloadTicket = {
      scope: {
        userId: scope.userId,
        businessProfileId: scope.businessProfileId,
        actorUserId: scope.actorUserId,
        role: scope.role,
      },
      ids,
      expires: Date.now() + 120000,
    };
    try {
      await ticketStore().set(
        ticketKey(ticket),
        JSON.stringify(value),
        "EX",
        120,
      );
    } catch {
      throw new StorageWorkspaceError(
        "Downloads are temporarily unavailable. Try again shortly.",
        503,
      );
    }
    res.setHeader("Cache-Control", "no-store");
    return ok(res, {
      url: `/api/settings/storage/download-ticket?ticket=${ticket}`,
      expiresIn: 120,
    });
  } catch (error) {
    return failure(res, error);
  }
}
/** One-use, two-minute bearer capability, issued only by the authenticated API.
 * This route precedes auth because ordinary browser downloads cannot attach the
 * selected business header or the stored bearer token. It never accepts IDs. */
export async function redeemStorageDownload(req: Request, res: Response) {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "private, no-store");
  const key = typeof req.query.ticket === "string" ? req.query.ticket : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(key))
    return res
      .status(410)
      .json({ error: "Download expired. Start the download again." });
  try {
    let value: unknown;
    try {
      value = await ticketStore().eval(
        "local v=redis.call('GET',KEYS[1]); redis.call('DEL',KEYS[1]); return v",
        1,
        ticketKey(key),
      );
    } catch {
      throw new StorageWorkspaceError(
        "Downloads are temporarily unavailable. Try again shortly.",
        503,
      );
    }
    const ticket: DownloadTicket | null =
      typeof value === "string" ? JSON.parse(value) : null;
    if (!ticket || ticket.expires <= Date.now())
      return res
        .status(410)
        .json({ error: "Download expired. Start the download again." });
    res.setHeader("X-Content-Type-Options", "nosniff");
    await withBusinessScope(ticket.scope, async () => {
      const files = [];
      for (const id of ticket.ids)
        files.push(await workspaceFile(ticket.scope.userId, id));
      // A generated output may have been replaced since this ticket was issued.
      // Revalidate the current sizes before opening objects or sending ZIP bytes.
      if (
        files.length > 1 &&
        files.reduce((total, file) => total + file.fileSizeBytes, 0) >
          500 * 1024 * 1024
      )
        throw new StorageWorkspaceError("Select up to 500 MB per ZIP download.");
      if (files.length === 1) {
        const file = files[0],
          stream = await open(file);
        res.setHeader(
          "Content-Type",
          file.mimeType || "application/octet-stream",
        );
        res.setHeader("Content-Length", file.fileSizeBytes);
        res.setHeader(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName || file.fileName)}`,
        );
        await pipeline(stream, res);
      } else {
        res.setHeader("Content-Type", "application/zip");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="AskSales-files.zip"',
        );
        await pipeline(
          Readable.from(
            storageZip(
              files.map((file) => ({
                id: file.id,
                name: file.originalName || file.fileName,
                size: file.fileSizeBytes,
                open: () => open(file),
              })),
            ),
          ),
          res,
        );
      }
    });
  } catch (error) {
    failure(res, error);
  }
}
