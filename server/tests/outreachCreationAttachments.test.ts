import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

let selections: unknown[][] = [];
let inserted: Record<string, unknown>[] = [];
const deleteFile = jest.fn<(...args: unknown[]) => Promise<boolean>>();
const database = {
  select: () => ({
    from: () => ({
      where: () => {
        const rows = selections.shift() || [];
        return Object.assign(Promise.resolve(rows), {
          limit: async () => rows,
        });
      },
    }),
  }),
  insert: () => ({
    values: (rows: Record<string, unknown>[]) => {
      inserted = rows;
      return { returning: async () => rows };
    },
  }),
  transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(database),
};
jest.unstable_mockModule("../models/db.js", () => ({ db: database }));
jest.unstable_mockModule("../services/StorageService.js", () => ({
  storageService: { deleteFile },
  StorageLimitError: class StorageLimitError extends Error {},
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));
const { outreachAttachmentService } =
  await import("../services/OutreachAttachmentService.js");
const source = {
  id: 5,
  publicId: "a0000000-0000-4000-8000-000000000001",
  messageId: 10,
  userId: 1,
  businessProfileId: 11,
  storageFileId: 500,
  fileName: "proposal.pdf",
  mimeType: "application/pdf",
  status: "ready",
  deliveryStatus: "sent",
  providerMediaId: "old-media",
  providerAttachmentId: "old-attachment",
};
beforeEach(() => {
  jest.clearAllMocks();
  selections = [];
  inserted = [];
  deleteFile.mockResolvedValue(true);
});

describe("bulk creation attachments", () => {
  it("shares private stored bytes but creates a separate attachment identity and delivery state for each recipient", async () => {
    selections = [[{ id: 10 }, { id: 20 }], [source]];
    await outreachAttachmentService.copyForMessage(1, 10, 20, [
      source.publicId,
    ]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      messageId: 20,
      userId: 1,
      businessProfileId: 11,
      storageFileId: 500,
      deliveryStatus: "pending",
      providerAttachmentId: null,
      providerMediaId: null,
    });
    expect(inserted[0].publicId).not.toBe(source.publicId);
    expect(inserted[0].id).toBeUndefined();
  });
  it("rejects a missing owned message or unavailable selected attachment before inserting a copy", async () => {
    selections = [[{ id: 20 }]];
    await expect(
      outreachAttachmentService.copyForMessage(1, 10, 20, [source.publicId]),
    ).rejects.toThrow(/do not belong to this business/);
    selections = [[{ id: 10 }, { id: 20 }], []];
    await expect(
      outreachAttachmentService.copyForMessage(1, 10, 20, [source.publicId]),
    ).rejects.toThrow(/no longer available/);
    expect(inserted).toEqual([]);
  });
  it("preserves bytes when deleting a conversation whose attachments are shared by another conversation", async () => {
    selections = [[source], [{ id: 6 }]];
    expect(
      await outreachAttachmentService.deleteFilesForMessages([10], 1),
    ).toBe(0);
    expect(deleteFile).not.toHaveBeenCalled();
  });
  it("deletes shared bytes once after the last referencing messages are deleted together", async () => {
    selections = [[source, { ...source, id: 6, messageId: 20 }], []];
    expect(
      await outreachAttachmentService.deleteFilesForMessages([10, 20], 1),
    ).toBe(1);
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(500, 1);
  });
});
