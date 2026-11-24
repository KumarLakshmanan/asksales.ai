import { describe, expect, it, jest } from "@jest/globals";
import { DelayedError, type Job } from "bullmq";
import {
  delayRejectedProvider,
  metaRetryable,
  nextDailyCapacityTime,
  providerRetryAfter,
  providerRetryTime,
  WHATSAPP_APP_RATE_LIMIT,
} from "../services/outreach/providerRetry.js";

const makeJob = (data = {}) => ({
  data,
  token: "token",
  updateData: jest
    .fn<(...args: unknown[]) => Promise<void>>()
    .mockResolvedValue(undefined),
  moveToDelayed: jest
    .fn<(...args: unknown[]) => Promise<void>>()
    .mockResolvedValue(undefined),
});
describe("outreach provider retries", () => {
  it('delays app capacity on the same job without exhausting or resetting the provider retry budget', async () => {
    const job=makeJob({messageId:7,providerRateLimitRetries:4});
    const release=jest.fn<(at:string,count:number)=>Promise<void>>().mockResolvedValue(undefined);
    const due=new Date(Date.now()+61_000).toISOString();
    await expect(delayRejectedProvider(job as unknown as Job,{success:false,retryable:true,deliveryAttempted:false,outcomeUnknown:false,providerCode:WHATSAPP_APP_RATE_LIMIT,retryAt:due},release)).rejects.toBeInstanceOf(DelayedError);
    expect(job.updateData).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(due,4);
    expect(job.moveToDelayed).toHaveBeenCalledWith(Date.parse(due),'token');
  });
  it.each([4, 17, 613, 80007, 130429, 131049, 131056])(
    "recognizes explicit transient Meta code %s",
    (code) => expect(metaRetryable(code, 400)).toBe(true),
  );
  it.each([190, 10, 100, 131026, 131047, 131048, 131050])(
    "stops permanent, permission, closed-window and opt-out code %s",
    (code) => expect(metaRetryable(code, 400)).toBe(false),
  );
  it("uses four hours for a marketing restriction and honors a longer provider cooldown", () => {
    expect(providerRetryTime(0, 131049, undefined, 1000)).toBe(14_401_000);
    expect(
      providerRetryTime(2, 131049, new Date(200_000_000).toISOString(), 1000),
    ).toBe(200_000_000);
    expect(providerRetryTime(0, 130429, "bad", 1000)).toBe(31_000);
  });
  it("uses the app UTC day reset rather than labeling every delay as 24 hours", () => {
    expect(
      new Date(
        nextDailyCapacityTime(Date.parse("2026-10-29T23:50:00Z")),
      ).toISOString(),
    ).toBe("2026-10-30T00:00:01.000Z");
  });
  it("parses Retry-After seconds and HTTP dates", () => {
    expect(providerRetryAfter("120", 1000)).toBe(
      new Date(121_000).toISOString(),
    );
    expect(providerRetryAfter("Thu, 29 Oct 2026 14:00:00 GMT", 1000)).toBe(
      "2026-10-29T14:00:00.000Z",
    );
    expect(providerRetryAfter("invalid", 1000)).toBeUndefined();
  });
  it("releases the durable claim before delaying the same job", async () => {
    const job = makeJob({ messageId: 7 });
    const release = jest
      .fn<(at: string, count: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    await expect(
      delayRejectedProvider(
        job as unknown as Job,
        {
          success: false,
          retryable: true,
          outcomeUnknown: false,
          providerCode: 131049,
        },
        release,
      ),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(job.updateData).toHaveBeenCalledWith({
      messageId: 7,
      providerRateLimitRetries: 1,
    });
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(
      job.moveToDelayed.mock.invocationCallOrder[0],
    );
  });
  it.each([4,5,40])("keeps marketing-limit retry %s on the original job", async count => {
    const job = makeJob({messageId:7,providerRateLimitRetries:count});
    const release = jest.fn<(at:string,count:number)=>Promise<void>>().mockResolvedValue(undefined);
    const now = Date.now();
    await expect(delayRejectedProvider(job as unknown as Job,{
      success:false,retryable:true,outcomeUnknown:false,providerCode:131049,
    },release,new Date(now+30*86_400_000))).rejects.toBeInstanceOf(DelayedError);
    expect(job.updateData).toHaveBeenCalledWith({messageId:7,providerRateLimitRetries:count+1});
    expect(Date.parse(release.mock.calls[0][0])).toBeGreaterThanOrEqual(now+14_400_000);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
  });
  it.each([
    { success: false, retryable: true },
    { success: false, retryable: true, outcomeUnknown: true },
    { success: false, retryable: false, outcomeUnknown: false },
    { success: true, retryable: true, outcomeUnknown: false },
  ])(
    "does not repeat uncertain, permanent, or accepted delivery: %j",
    async (evidence) => {
      const job = makeJob();
      await delayRejectedProvider(
        job as unknown as Job,
        evidence,
        async () => {},
      );
      expect(job.moveToDelayed).not.toHaveBeenCalled();
    },
  );
  it.each([4, -1, "invalid"])(
    "bounds the persisted retry counter: %s",
    async (count) => {
      const job = makeJob({ providerRateLimitRetries: count });
      await delayRejectedProvider(
        job as unknown as Job,
        { success: false, retryable: true, outcomeUnknown: false },
        async () => {},
      );
      expect(job.moveToDelayed).not.toHaveBeenCalled();
    },
  );
  it("does not schedule beyond the reviewed queue lifetime", async () => {
    const job = makeJob();
    expect(
      await delayRejectedProvider(
        job as unknown as Job,
        {
          success: false,
          retryable: true,
          outcomeUnknown: false,
          providerCode: 131049,
        },
        async () => {},
        new Date(Date.now() + 60_000),
      ),
    ).toBe("confirmation_expired");
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
