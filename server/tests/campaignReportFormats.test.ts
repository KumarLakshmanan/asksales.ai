import { describe, expect, it } from "@jest/globals";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import * as XLSX from "@e965/xlsx";
import mammoth from "mammoth";
import { syntheticCampaignSnapshot } from "./helpers/campaignSnapshotFixture.js";
import {
  campaignReportExcel,
  campaignReportWord,
  campaignReportHtml,
  campaignHistoryHtml,
  renderCampaignReport,
} from "../services/outreach/CampaignReportFormats.js";
describe("campaign formats from a single fixed snapshot", () => {
  it("keeps receipt counts, typed cells and full long conversation text in the workbook", () => {
    const snapshot = syntheticCampaignSnapshot();
    snapshot.customers[0].name = '=HYPERLINK("https://example.test")';
    snapshot.history[0].content = "x".repeat(35000);
    const workbook = XLSX.read(campaignReportExcel(snapshot), {
      type: "buffer",
    });
    expect(workbook.SheetNames).toEqual([
      "Summary",
      "Channels",
      "Failures",
      "Customers",
      "Conversation history",
      "Definitions",
    ]);
    const summary = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets.Summary,
      { header: 1 },
    );
    expect(summary).toContainEqual(["Provider accepted", 2]);
    expect(summary).toContainEqual(["Confirmed delivered", 1]);
    expect(summary).toContainEqual(["Awaiting delivery confirmation", 1]);
    const customers = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets.Customers,
      { header: 1 },
    );
    expect(customers[1][1]).toBe('\'=HYPERLINK("https://example.test")');
    const history = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["Conversation history"],
      { header: 1 },
    );
    expect(
      history
        .filter((row) => row[0] === "message-1")
        .map((row) => row[12])
        .join(""),
    ).toBe("x".repeat(35000));
  });
  it("produces an actual OOXML Word package readable by a document parser", async () => {
    const snapshot = syntheticCampaignSnapshot(),
      bytes = campaignReportWord(snapshot);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    const extracted = await mammoth.extractRawText({ buffer: bytes });
    expect(extracted.value).toContain("Campaign delivery report");
    expect(extracted.value).toContain(snapshot.checkedAt);
    expect(extracted.value).toContain("Confirmed delivered");
    expect(extracted.value).toContain("Awaiting delivery confirmation");
    expect(
      extracted.messages.filter((message) => message.type === "error"),
    ).toHaveLength(0);
  });
  it("escapes customer text and keeps protected history self-contained", () => {
    const snapshot = syntheticCampaignSnapshot();
    snapshot.name = "<script>alert(1)</script>";
    snapshot.history[1].content =
      '<img src="https://example.test/pixel" onerror="alert(1)">';
    for (const html of [
      campaignReportHtml(snapshot),
      campaignHistoryHtml(snapshot),
    ]) {
      expect(html).not.toMatch(/<script\b|<img\b/i);
      expect(html).toContain("default-src");
    }
    expect(campaignHistoryHtml(snapshot)).toContain("&lt;img");
    expect(campaignReportHtml(snapshot)).toContain("&lt;script&gt;");
  });
  (process.env.OUTREACH_REPORT_RENDER_QA === "1" ? it : it.skip)(
    "renders the actual PDF and writes only synthetic QA artifacts for visual verification",
    async () => {
      const configured = process.env.CAMPAIGN_REPORT_QA_DIR;
      const workspace = resolve(process.cwd(), ".."),
        directory = resolve(configured || "");
      if (
        !configured ||
        !directory.startsWith(workspace + sep) ||
        !directory.includes(`${sep}.local${sep}`)
      )
        throw new Error(
          "An explicit local QA artifact directory inside this workspace is required",
        );
      await mkdir(directory, { recursive: true });
      const snapshot = syntheticCampaignSnapshot();
      for (const format of ["pdf", "docx", "xlsx", "html"] as const) {
        const bytes = await renderCampaignReport(snapshot, format);
        if (format === "pdf")
          expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
        await writeFile(resolve(directory, `campaign-report.${format}`), bytes);
      }
      await writeFile(
        resolve(directory, "snapshot.json"),
        JSON.stringify(snapshot, null, 2),
      );
    },
    60000,
  );
});
