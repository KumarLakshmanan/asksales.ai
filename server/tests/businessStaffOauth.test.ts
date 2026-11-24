import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Request, Response } from "express";
import {
  withBusinessScope,
  currentBusinessScope,
} from "../tenancy/businessContext.js";
const get = jest.fn<() => Promise<string | null>>(),
  set = jest.fn<(...args: unknown[]) => Promise<string>>();
const resolve = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule("../infrastructure/redis.js", () => ({
  getRedisConnection: () => ({ get, set }),
}));
jest.unstable_mockModule("../tenancy/businessScopeResolver.js", () => ({
  resolveBusinessScope: resolve,
}));
const { rememberOAuthBusinessState, oauthBusinessScope } =
  await import("../tenancy/oauthBusinessScope.js");
const scope = {
  userId: 1,
  actorUserId: 2,
  businessProfileId: 11,
  role: "billing_admin" as const,
};
const response = () => {
  const res = { status: jest.fn(), send: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
};
describe("business staff OAuth authority", () => {
  beforeEach(() => {
    get.mockReset();
    set.mockReset();
    resolve.mockReset();
    set.mockResolvedValue("OK");
  });
  it("records the initiating staff and owning business", async () => {
    await withBusinessScope(scope, () =>
      rememberOAuthBusinessState("signed-provider-state"),
    );
    expect(JSON.parse(String(set.mock.calls[0][1]))).toMatchObject(scope);
  });
  it("rejects a normal member before recording a connection state", async () => {
    await expect(
      withBusinessScope({ ...scope, role: "member" }, () =>
        rememberOAuthBusinessState("state"),
      ),
    ).rejects.toThrow("owner or billing admin");
    expect(set).not.toHaveBeenCalled();
  });
  it.each([null, { ...scope, role: "member" }, { ...scope, userId: 9 }])(
    "rejects revoked, demoted or reassigned callbacks: %j",
    async (authorized) => {
      get.mockResolvedValue(JSON.stringify(scope));
      resolve.mockResolvedValue(authorized);
      const res = response(),
        next = jest.fn();
      await oauthBusinessScope(
        { query: { state: "signed-provider-state" } } as unknown as Request,
        res,
        next,
      );
      expect(resolve).toHaveBeenCalledWith(2, 11);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    },
  );
  it("completes within the original business and actual billing admin scope", async () => {
    get.mockResolvedValue(JSON.stringify(scope));
    resolve.mockResolvedValue(scope);
    const next = jest.fn(() =>
      expect(currentBusinessScope()).toMatchObject(scope),
    );
    await oauthBusinessScope(
      { query: { state: "signed-provider-state" } } as unknown as Request,
      response(),
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});
