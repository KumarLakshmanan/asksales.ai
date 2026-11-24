import * as XLSX from "@e965/xlsx";
import type {
  CampaignExportFormat,
  CampaignReportSnapshot,
} from "../../../shared/campaignExports.js";
import { launchSystemChromium } from "../../utils/browserAutomation.js";
import { withPromiseTimeout } from "../../utils/promiseTimeout.js";
function cleanText(value:unknown) {
  // XML 1.0 forbids these controls, including in OOXML worksheet text.
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
}
const xml = (value: unknown) =>
  cleanText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const metrics = (snapshot: CampaignReportSnapshot) => {
  const { report } = snapshot,
    c = report.counts;
  return [
    ["Selected customers", report.uniqueRecipients],
    ["Messages", c.total],
    ["Provider accepted", c.accepted],
    ["Confirmed delivered", c.delivered],
    ["Awaiting delivery confirmation", c.awaitingConfirmation],
    ["Queued", c.queued],
    ["Retrying (included in queued)", c.retrying],
    ["Processing", c.processing],
    ["Failed", c.failed],
    ["Needs review", c.review],
    ["Cancelled", c.cancelled],
    ["Responding customers", report.engagement.respondingCustomers],
    ["Typed replies", report.engagement.typedReplies],
    ["Quick replies", report.engagement.quickReplies],
    ["Menu selections", report.engagement.menuSelections],
    ["Other inbound responses", report.engagement.otherResponses],
    ["AI replies", report.engagement.assistantReplies],
  ] as Array<[string, number]>;
};
const filters = (snapshot: CampaignReportSnapshot) =>
  Object.entries(snapshot.report.filters)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" | ") || "All saved outreach";
const css = `@page{size:A4;margin:18mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#142034;font-size:11px;line-height:1.5;margin:0}h1{font-size:25px;line-height:1.2;margin:0 0 8px;color:#111}h2{font-size:15px;margin:24px 0 10px;break-after:avoid}p{margin:8px 0}.muted{color:#526078;font-size:10px}table{width:100%;border-collapse:collapse;margin:10px 0 18px;table-layout:fixed}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #dbe1eb;vertical-align:top;overflow-wrap:anywhere}th{background:#f1f4f8;font-weight:600}thead{display:table-header-group}tr{break-inside:avoid}.metric td:last-child{width:24%;font-weight:600}.notes{font-size:10px;color:#526078}article{border:1px solid #dbe1eb;border-radius:6px;padding:14px;margin:12px 0;break-inside:avoid}.content{white-space:pre-wrap;overflow-wrap:anywhere}details{margin:16px 0}summary{font-weight:bold;cursor:pointer}.history{max-width:960px;margin:32px auto;padding:0 20px}`;
function document(title: string, body: string, extra = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${xml(title)}</title><style>${css}${extra}</style></head><body>${body}</body></html>`;
}
export function campaignReportHtml(snapshot: CampaignReportSnapshot) {
  const { report } = snapshot;
  return document(
    "Campaign delivery report",
    `<h1>Campaign delivery report</h1><p>${xml(snapshot.name)}</p><p class="muted">Snapshot ${xml(snapshot.checkedAt)} | Business ${snapshot.businessProfileId}</p>
    <p>Selected customers: ${report.uniqueRecipients}. Total messages: ${report.counts.total}. Confirmed delivery receipts: ${report.counts.delivered}. Awaiting delivery confirmation: ${report.counts.awaitingConfirmation}.</p>
    <p class="muted">${xml(filters(snapshot))}</p><h2>Delivery and responses</h2><table class="metric"><thead><tr><th>Measurement</th><th>Count</th></tr></thead><tbody>${metrics(
      snapshot,
    )
      .map(
        ([label, count]) =>
          `<tr><td>${xml(label)}</td><td>${count.toLocaleString("en-US")}</td></tr>`,
      )
      .join("")}</tbody></table>
    <p class="notes">${xml(report.definitions.accepted)} ${xml(report.definitions.delivered)}</p><h2>Delivery by channel</h2><table><thead><tr>${["Channel", "Accepted", "Delivered", "Queued", "Failed"].map((label) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${report.channels.map((row) => `<tr><td>${xml(row.channel)}</td><td>${row.accepted}</td><td>${row.delivered}</td><td>${row.queued}</td><td>${row.failed}</td></tr>`).join("") || '<tr><td colspan="5">No messages matched these filters.</td></tr>'}</tbody></table>
    <h2>Failures and next attempts</h2><p>Next queued attempt: ${xml(report.nextAttemptAt || "No exact retry time is recorded")}</p>${report.failures.length ? report.failures.map((failure) => `<p><strong>${failure.count} ${xml(failure.channel)}${failure.code ? ` | ${xml(failure.code)}` : ""}</strong><br>${xml(failure.reason.slice(0, 600))}${failure.reason.length > 600 ? "… Full reason is in the Excel report." : ""}</p>`).join("") : "<p>No failed messages or review items in this snapshot.</p>"}
    <h2>Reading this report</h2><div class="notes">${[report.definitions.responseRate, report.definitions.attribution, report.definitions.clicks, ...snapshot.notes].map((note) => `<p>${xml(note)}</p>`).join("")}</div>`,
  );
}
export function campaignHistoryHtml(snapshot: CampaignReportSnapshot) {
  const customers = new Map(
    snapshot.customers.map((customer) => [customer.key, customer]),
  );
  const grouped = new Map<string, typeof snapshot.history>();
  for (const message of snapshot.history) {
    const rows = grouped.get(message.customerKey) || [];
    rows.push(message);
    grouped.set(message.customerKey, rows);
  }
  return document(
    "Campaign conversation history",
    `<main class="history"><h1>Campaign conversation history</h1><p>${xml(snapshot.name)} | Snapshot ${xml(snapshot.checkedAt)}</p><p>${snapshot.history.length} saved messages for ${grouped.size} customers in the selected audience. Protected values are masked.</p><p class="notes">${xml(snapshot.report.definitions.attribution)} No external resources are loaded by this report.</p>
    ${[...grouped].map(([key, messages]) => `<details open><summary>${xml(customers.get(key)?.name || key)} | ${xml(customers.get(key)?.phone || customers.get(key)?.email || key)} | ${messages.length} messages</summary>${messages.map((message) => `<article><p class="muted">${xml(message.createdAt)} | ${xml(message.channel)} | ${xml(message.direction === "inbound" ? "Customer" : "Business")} | ${xml(message.status)} | ${xml(message.id)}</p>${message.subject ? `<h2>${xml(message.subject)}</h2>` : ""}<p class="content">${xml(message.content || "No text content recorded.")}</p>${message.selection ? `<p class="notes">Selection ${xml(message.selection.kind)}: ${xml(message.selection.title)}</p>` : ""}</article>`).join("")}</details>`).join("") || "<p>No saved conversation history matched this snapshot.</p>"}</main>`,
  );
}
function safeCell(value: unknown) {
  if (typeof value !== "string") return value ?? "";
  const text = cleanText(value);
  return /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
}
export function campaignReportExcel(snapshot: CampaignReportSnapshot): Buffer {
  const workbook = XLSX.utils.book_new();
  function sheet(name: string, rows: unknown[][], widths: number[]) {
    const data = XLSX.utils.aoa_to_sheet(rows.map((row) => row.map(safeCell)));
    data["!cols"] = widths.map((wch) => ({ wch }));
    if (data["!ref"]) data["!autofilter"] = { ref: data["!ref"] };
    XLSX.utils.book_append_sheet(workbook, data, name);
  }
  sheet(
    "Summary",
    [
      ["Campaign delivery report", snapshot.name],
      ["Snapshot UTC", snapshot.checkedAt],
      ["Business ID", snapshot.businessProfileId],
      ["Filters", filters(snapshot)],
      [],
      ["Measurement", "Count"],
      ...metrics(snapshot),
    ],
    [42, 55],
  );
  sheet(
    "Channels",
    [
      [
        "Channel",
        "Accepted",
        "Confirmed delivered",
        "Awaiting confirmation",
        "Queued",
        "Retrying",
        "Failed",
        "Next attempt",
      ],
      ...snapshot.report.channels.map((row) => [
        row.channel,
        row.accepted,
        row.delivered,
        row.awaitingConfirmation,
        row.queued,
        row.retrying,
        row.failed,
        row.nextAttemptAt,
      ]),
    ],
    [18, 14, 20, 22, 14, 14, 14, 28],
  );
  sheet(
    "Failures",
    [
      ["Channel", "Code", "Count", "Reason"],
      ...snapshot.report.failures.flatMap((failure) => {
        const rows = [];
        for (
          let start = 0;
          start < Math.max(1, failure.reason.length);
          start += 30000
        )
          rows.push([
            failure.channel,
            failure.code,
            failure.count,
            failure.reason.slice(start, start + 30000),
          ]);
        return rows;
      }),
    ],
    [18, 18, 14, 90],
  );
  sheet(
    "Customers",
    [
      [
        "Customer key",
        "Name",
        "Email",
        "Phone",
        "Channels",
        "Messages",
        "Accepted",
        "Delivered",
        "Awaiting confirmation",
        "Queued",
        "Failed",
        "Responded",
        "Typed replies",
        "Quick replies",
        "Menus",
        "Other responses",
        "Tracked link events",
        "Verified booking actions",
        "Last reply UTC",
      ],
      ...snapshot.customers.map((row) => [
        row.key,
        row.name,
        row.email,
        row.phone,
        row.channels.join(", "),
        row.messages,
        row.accepted,
        row.delivered,
        row.awaitingConfirmation,
        row.queued,
        row.failed,
        row.responded,
        row.typedReplies,
        row.quickReplies,
        row.menuSelections,
        row.otherResponses,
        row.trackedLinkClicks,
        row.verifiedBookingActions,
        row.lastReplyAt,
      ]),
    ],
    [
      22, 28, 32, 22, 22, 14, 14, 14, 22, 14, 14, 14, 14, 14, 14, 18, 22, 24,
      28,
    ],
  );
  sheet(
    "Conversation history",
    [
      [
        "Message ID",
        "Customer key",
        "Conversation ID",
        "Channel",
        "Account",
        "Direction",
        "Type",
        "Status",
        "Time UTC",
        "Subject",
        "Text part",
        "Part count",
        "Protected message text",
        "Selection kind",
        "Selection title",
      ],
      ...snapshot.history.flatMap((row) => {
        const count = Math.max(1, Math.ceil(row.content.length / 30000));
        return Array.from({ length: count }, (_, part) => [
          row.id,
          row.customerKey,
          row.conversationId,
          row.channel,
          row.accountId,
          row.direction,
          row.type,
          row.status,
          row.createdAt,
          row.subject,
          part + 1,
          count,
          row.content.slice(part * 30000, (part + 1) * 30000),
          row.selection?.kind,
          row.selection?.title,
        ]);
      }),
    ],
    [24, 22, 20, 18, 24, 16, 18, 18, 28, 35, 14, 14, 95, 22, 30],
  );
  sheet(
    "Definitions",
    [
      ["Measurement", "Meaning"],
      ...Object.entries(snapshot.report.definitions),
      ...snapshot.notes.map((note, index) => [`Note ${index + 1}`, note]),
      ["WhatsApp URL clicks without tracking", "Unavailable"],
      ["Phone call button clicks", "Unavailable"],
      [
        "Long message text",
        "Messages longer than Excel cell capacity are split into numbered parts without truncation.",
      ],
    ],
    [40, 110],
  );
  return Buffer.from(
    XLSX.write(workbook, {
      bookType: "xlsx",
      type: "buffer",
      compression: true,
    }),
  );
}
/** Small deterministic OOXML report, packaged with the existing XLSX ZIP
 * implementation. No HTML masquerading as a Word document or external links. */
export function campaignReportWord(snapshot: CampaignReportSnapshot): Buffer {
  const paragraph = (text: unknown, style = "Normal") =>
    `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  const table = (rows: unknown[][]) =>
    `<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblBorders><w:bottom w:val="single" w:sz="4" w:color="DCE2EB"/><w:insideH w:val="single" w:sz="4" w:color="DCE2EB"/></w:tblBorders><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${rows[0].map(() => `<w:gridCol w:w="${Math.floor(9638 / rows[0].length)}"/>`).join("")}</w:tblGrid>${rows.map((row, index) => `<w:tr>${index === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${row.map((cell) => `<w:tc><w:tcPr>${index === 0 ? '<w:shd w:fill="F1F4F8"/>' : ""}</w:tcPr>${paragraph(cell, index === 0 ? "TableHeader" : "Normal")}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
  const body = [
    paragraph("Campaign delivery report", "Title"),
    paragraph(snapshot.name, "Subtitle"),
    paragraph(
      `Snapshot ${snapshot.checkedAt} | Business ${snapshot.businessProfileId}`,
      "Caption",
    ),
    paragraph(
      `Selected customers: ${snapshot.report.uniqueRecipients}. Total messages: ${snapshot.report.counts.total}. Confirmed delivery receipts: ${snapshot.report.counts.delivered}. Awaiting delivery confirmation: ${snapshot.report.counts.awaitingConfirmation}.`,
    ),
    paragraph(filters(snapshot), "Caption"),
    paragraph("Delivery and responses", "Heading1"),
    table([["Measurement", "Count"], ...metrics(snapshot)]),
    paragraph("Delivery by channel", "Heading1"),
    table([
      ["Channel", "Accepted", "Delivered", "Queued", "Failed"],
      ...snapshot.report.channels.map((row) => [
        row.channel,
        row.accepted,
        row.delivered,
        row.queued,
        row.failed,
      ]),
    ]),
    paragraph("Failures and next attempts", "Heading1"),
    paragraph(
      `Next queued attempt: ${snapshot.report.nextAttemptAt || "No exact retry time is recorded"}`,
    ),
    ...snapshot.report.failures.map((failure) =>
      paragraph(
        `${failure.count} ${failure.channel}${failure.code ? ` | ${failure.code}` : ""}: ${failure.reason.slice(0, 600)}${failure.reason.length > 600 ? "… Full reason is in the Excel report." : ""}`,
      ),
    ),
    ...(!snapshot.report.failures.length
      ? [paragraph("No failed messages or review items in this snapshot.")]
      : []),
    paragraph("Reading this report", "Heading1"),
    ...[
      snapshot.report.definitions.accepted,
      snapshot.report.definitions.delivered,
      snapshot.report.definitions.responseRate,
      snapshot.report.definitions.attribution,
      snapshot.report.definitions.clicks,
      ...snapshot.notes,
    ].map((note) => paragraph(note, "Caption")),
  ].join("");
  const zip = XLSX.CFB.utils.cfb_new();
  const add = (name: string, data: string) =>
    XLSX.CFB.utils.cfb_add(zip, name, Buffer.from(data, "utf8"));
  add(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  );
  add(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  add(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  );
  add(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1020" w:right="1134" w:bottom="1020" w:left="1134"/></w:sectPr></w:body></w:document>`,
  );
  add(
    "word/styles.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="21"/><w:color w:val="142034"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="180"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/><w:color w:val="111111"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="300" w:after="140"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="19"/><w:color w:val="526078"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Header"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/></w:rPr></w:style></w:styles>',
  );
  return Buffer.from(
    XLSX.CFB.write(zip, { type: "buffer", fileType: "zip", compression: true }),
  );
}
export async function renderCampaignReport(
  snapshot: CampaignReportSnapshot,
  format: CampaignExportFormat,
): Promise<Buffer> {
  if (format === "xlsx") return campaignReportExcel(snapshot);
  if (format === "docx") return campaignReportWord(snapshot);
  if (format === "html")
    return Buffer.from(campaignHistoryHtml(snapshot), "utf8");
  const browser = await launchSystemChromium();
  try {
    // Every variable is escaped text in a static template; no customer HTML,
    // scripts, external assets or provider URLs enter the rendering browser.
    const context = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(campaignReportHtml(snapshot), {
      waitUntil: "load",
      timeout: 30000,
    });
    return await withPromiseTimeout(
      page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: "<span></span>",
        footerTemplate:
          '<div style="font-size:9px;color:#526078;text-align:right;width:100%;padding:0 18mm"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      }),
      30000,
      "Campaign report rendering timed out.",
    );
  } finally {
    await browser.close();
  }
}
