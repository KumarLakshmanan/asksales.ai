import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { withBusinessScope } from "../tenancy/businessContext.js";

type Result = { rows: Record<string, unknown>[]; rowCount: number };
const execute = jest.fn<(query: unknown) => Promise<Result>>();
const info = jest.fn();
const analyze = jest.fn(async (_request: unknown, response: { json(body: Record<string, unknown>): unknown }) => {
  response.json({ success: true, data: { companyName: "Synthetic fixture" } });
});

jest.unstable_mockModule("../models/db.js", () => ({ db: { execute } }));
jest.unstable_mockModule("../controllers/setupController.js", () => ({ analyzeWebsite: analyze }));
jest.unstable_mockModule("../queues/index.js", () => ({
  QUEUE_NAMES: { GENERAL: "general" },
  queueRegistry: {},
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { info, error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const { processWorkspaceWebsiteAnalysis } = await import("../services/workspaceWebsiteAnalysisJobs.js");
const id = "af350f74-315a-43c3-bc93-b21f7bce5680";

function run() {
  return withBusinessScope({ userId: 7, businessProfileId: 26 }, () =>
    processWorkspaceWebsiteAnalysis({ data: { analysisJobId: id } }),
  );
}

function queued(affected: number) {
  execute
    .mockResolvedValueOnce({ rows: [{ id, status: "queued", url: "https://example.invalid/", force_refresh: false }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    // UPDATE without RETURNING has no result rows even when it changes a row.
    .mockResolvedValueOnce({ rows: [], rowCount: affected });
}

describe("setup job completion logging", () => {
  beforeEach(() => {
    execute.mockReset();
    info.mockClear();
    analyze.mockClear();
  });

  it("does not report completion when the conditional final update changes no row", async () => {
    queued(0);
    await run();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(info).not.toHaveBeenCalled();
  });

  it("reports completion once when UPDATE succeeds without returning rows", async () => {
    queued(1);
    await run();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      { jobId: id, businessProfileId: 26, event: "setup_analysis_completed" },
      "Website analysis completed",
    );
  });

  it("does not analyze or report completion for an already cancelled job", async () => {
    execute.mockResolvedValueOnce({ rows: [{ id, status: "cancelled" }], rowCount: 1 });
    await run();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(analyze).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
