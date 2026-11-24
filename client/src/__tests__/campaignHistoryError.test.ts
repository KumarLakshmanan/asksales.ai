import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { campaignHistoryFailureReason } from "@/app/dashboard/(main)/chats/campaign-history-error";

describe("campaignHistoryFailureReason", () => {
  it("asks the user to sign in again on auth failures", () => {
    expect(campaignHistoryFailureReason(new ApiError("x", 401))).toMatch(/Sign in again/);
    expect(campaignHistoryFailureReason(new ApiError("x", 403))).toMatch(/Sign in again/);
  });

  it("names the server error code on 5xx without leaking raw server text", () => {
    const reason = campaignHistoryFailureReason(new ApiError("Unable to retrieve chat threads. relation missing", 500));
    expect(reason).toMatch(/error 500/);
    expect(reason).not.toMatch(/relation missing/);
  });

  it("explains a missing business profile", () => {
    expect(campaignHistoryFailureReason(new ApiError("Business profile not found", 404))).toMatch(/business profile/);
  });

  it("tells the user about a connection failure", () => {
    expect(campaignHistoryFailureReason(new TypeError("Failed to fetch"))).toMatch(/connection/);
  });

  it("falls back to a generic retry message", () => {
    expect(campaignHistoryFailureReason("boom")).toMatch(/Try again/);
  });
});
