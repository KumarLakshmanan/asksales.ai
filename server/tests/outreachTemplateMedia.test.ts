import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/express.js";
const upload = jest.fn<(...args: any[]) => Promise<{ id: string }>>();
jest.unstable_mockModule("../services/whatsappApiService.js", () => ({
  whatsappApiService: { uploadTemplateMedia: upload },
}));
jest.unstable_mockModule("../tenancy/businessContext.js", () => ({
  businessOwnerUserId: (req: AuthenticatedRequest) => req.user?.id,
}));
const { uploadOutreachTemplateMedia } =
  await import("../controllers/outreachTemplateMediaController.js");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const req = () =>
  ({
    user: { id: 9 },
    body: { providerAccountId: "1095711443622725", mediaType: "image" },
    file: {
      buffer: png,
      mimetype: "image/png",
      originalname: "photo.png",
      size: png.length,
    },
  }) as AuthenticatedRequest;
const response = () => {
  const r = { status: jest.fn(), json: jest.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response;
};
beforeEach(() => {
  jest.clearAllMocks();
  upload.mockResolvedValue({ id: "123456789" });
});
describe("outreach template file uploads", () => {
  it("uploads validated bytes against the exact authenticated sender without sending a message", async () => {
    const res = response();
    await uploadOutreachTemplateMedia(req(), res);
    expect(upload).toHaveBeenCalledWith({
      userId: 9,
      phoneNumberId: "1095711443622725",
      buffer: png,
      mimeType: "image/png",
      fileName: "photo.png",
    });
    expect(res.json).toHaveBeenCalledWith({
      mediaId: "123456789",
      fileName: "photo.png",
      mediaType: "image",
    });
  });
  it("requires authentication", async () => {
    const request = req();
    delete request.user;
    const res = response();
    await uploadOutreachTemplateMedia(request, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(upload).not.toHaveBeenCalled();
  });
  it.each(["signature", "size", "type", "account"])(
    "rejects invalid %s before provider upload",
    async (problem) => {
      const request = req();
      if (problem === "signature")
        request.file!.buffer = Buffer.from("not an image");
      if (problem === "size") request.file!.size = 6 * 1024 * 1024;
      if (problem === "type") request.file!.mimetype = "text/html";
      if (problem === "account") request.body.providerAccountId = "";
      const res = response();
      await uploadOutreachTemplateMedia(request, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(upload).not.toHaveBeenCalled();
    },
  );
  it("returns a retryable error without reporting a completed upload", async () => {
    upload.mockRejectedValue(new Error("private provider detail"));
    const res = response();
    await uploadOutreachTemplateMedia(req(), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.stringContaining("could not accept"),
    });
  });
});
