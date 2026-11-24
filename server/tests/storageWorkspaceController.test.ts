import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { Readable } from "node:stream";
import {
  withBusinessScope,
  currentBusinessScope,
} from "../tenancy/businessContext.js";
import type { StorageFileRecord } from "../models/storageFiles/schema.js";
const bytes = Buffer.from("hello world");
let file: StorageFileRecord,
  denied = false;
class WorkspaceError extends Error {
  constructor(
    message: string,
    public status = 404,
  ) {
    super(message);
  }
}
const workspaceFile = jest.fn(async (owner: number, id: number) => {
  if (
    denied ||
    owner !== 9 ||
    currentBusinessScope()?.businessProfileId !== 101 ||
    id !== 1
  )
    throw new WorkspaceError("File not found");
  return file;
});
const redisValues = new Map<string, string>();
const redis = {
  set: jest.fn(async (key: string, value: string) => {
    redisValues.set(key, value);
    return "OK";
  }),
  eval: jest.fn(async (_script: string, _count: number, key: string) => {
    const value = redisValues.get(key);
    redisValues.delete(key);
    return value || null;
  }),
};
jest.unstable_mockModule("../infrastructure/redis.js", () => ({
  getRedisConnection: () => ({ duplicate: () => redis }),
}));
const openReadStream = jest.fn(
  async (_key: string, range?: { start: number; end: number }) =>
    Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]),
);
jest.unstable_mockModule("../services/ObjectStorageService.js", () => ({
  objectStorage: { openReadStream },
}));
jest.unstable_mockModule("../services/storageWorkspace.js", () => ({
  workspaceFile,
  StorageWorkspaceError: WorkspaceError,
  workspaceOverview: jest.fn(),
  listWorkspaceFiles: jest.fn(),
  publicFile: (file: unknown) => file,
  storageActivity: jest.fn(),
  actorFolders: jest.fn(),
  mutateWorkspace: jest.fn(),
  storageQuerySchema: {},
  storageMutationSchema: {},
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { error: jest.fn() },
}));
const {
  streamStorageFile,
  createStorageDownload,
  redeemStorageDownload,
  getStorageThumbnail,
} = await import("../controllers/storageWorkspaceController.js");
const app = express();
app.use(express.json());
app.get("/download-ticket", redeemStorageDownload);
app.use((req, _res, next) => {
  req.user = { id: 99, email: "member@example.test" };
  withBusinessScope(
    { userId: 9, businessProfileId: 101, actorUserId: 99 },
    next,
  );
});
app.get("/files/:fileId/content", streamStorageFile);
app.get("/files/:fileId/thumbnail", getStorageThumbnail);
app.post("/download", createStorageDownload);
beforeEach(() => {
  denied = false;
  redisValues.clear();
  jest.clearAllMocks();
  file = {
    id: 1,
    userId: 9,
    businessProfileId: 101,
    fileName: "brief.txt",
    originalName: "Campaign brief.txt",
    storageKey: "9/document/brief.txt",
    storageBackend: "local",
    mimeType: "text/plain",
    fileSizeBytes: bytes.length,
    category: "document",
    referenceType: "user_upload",
    referenceId: null,
    url: null,
    metadata: {},
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
});
describe("authenticated storage streams and shared download capabilities", () => {
  it("streams requested byte ranges with private response headers", async () => {
    const result = await request(app)
      .get("/files/1/content?inline=true")
      .set("Range", "bytes=6-");
    expect(result.status).toBe(206);
    expect(result.text).toBe("world");
    expect(result.headers["content-range"]).toBe("bytes 6-10/11");
    expect(result.headers["cache-control"]).toContain("no-store");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(openReadStream).toHaveBeenCalledWith(file.storageKey, {
      start: 6,
      end: 10,
    });
  });
  it("rejects a foreign file and an unsatisfiable range before opening storage", async () => {
    expect((await request(app).get("/files/2/content")).status).toBe(404);
    expect(
      (await request(app).get("/files/1/content").set("Range", "bytes=99-"))
        .status,
    ).toBe(416);
    expect(openReadStream).not.toHaveBeenCalled();
  });
  it("issues a scoped two-minute ticket and consumes it exactly once without browser authorization headers", async () => {
    const issued = await request(app)
      .post("/download")
      .send({ fileIds: [1] });
    expect(issued.status).toBe(200);
    expect(redis.set.mock.calls[0]).toEqual([
      expect.stringMatching(/^storage:download:/),
      expect.any(String),
      "EX",
      120,
    ]);
    const url =
      "/download-ticket" +
      new URL(issued.body.data.url, "https://test.local").search;
    const download = await request(app).get(url);
    expect(download.status).toBe(200);
    expect(download.text).toBe("hello world");
    expect(download.headers["content-disposition"]).toContain(
      "Campaign%20brief.txt",
    );
    expect((await request(app).get(url)).status).toBe(410);
  });
  it("revalidates the active file after ticket creation", async () => {
    const issued = await request(app)
      .post("/download")
      .send({ fileIds: [1] });
    denied = true;
    expect(
      (
        await request(app).get(
          "/download-ticket" +
            new URL(issued.body.data.url, "https://test.local").search,
        )
      ).status,
    ).toBe(404);
    expect(openReadStream).not.toHaveBeenCalled();
  });
  it("bounds thumbnail input before opening the object", async () => {
    file = { ...file, mimeType: "image/png", fileSizeBytes: 11 * 1024 * 1024 };
    expect((await request(app).get("/files/1/thumbnail")).status).toBe(404);
    expect(openReadStream).not.toHaveBeenCalled();
  });
});
