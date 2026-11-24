import * as xlsx from "@e965/xlsx";

export class HotelRateImportError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly row?: number,
  ) {
    super(message);
  }
}
function calendarDay(year: number, month: number, day: number): string | null {
  if (
    year < 1000 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  )
    return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : null;
}
/** Spreadsheet dates are calendar days, independent of the server timezone. */
export function hotelImportDay(
  value: unknown,
  date1904 = false,
): string | null {
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      (!date1904 && Math.floor(value) === 60)
    )
      return null;
    const parsed = xlsx.SSF.parse_date_code(value, { date1904 });
    return parsed ? calendarDay(parsed.y, parsed.m, parsed.d) : null;
  }
  if (typeof value !== "string") return null;
  const input = value.trim();
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(input);
  if (match)
    return calendarDay(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(input);
  if (match) {
    const a = Number(match[1]),
      b = Number(match[2]);
    return calendarDay(Number(match[3]), b > 12 ? a : b, b > 12 ? b : a);
  }
  match = /^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})$/.exec(input);
  if (!match) return null;
  const month =
    [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ].indexOf(match[2].toLowerCase()) + 1;
  return calendarDay(Number(match[3]), month, Number(match[1]));
}
export interface HotelRateRow {
  row: number;
  day: string;
  name: string;
  rate: number;
  availability: number;
  total: number;
}
export function parseHotelRateWorkbook(buffer: Buffer): HotelRateRow[] {
  let workbook: xlsx.WorkBook;
  try {
    workbook = xlsx.read(buffer, { type: "buffer" });
  } catch {
    throw new HotelRateImportError(
      "The rate report could not be read. Upload a valid spreadsheet.",
    );
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet)
    throw new HotelRateImportError("The rate report has no worksheet.");
  const raw = xlsx.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
  });
  const header = raw.findIndex(
    (row) => row.includes("Date") && row.includes("Room Type"),
  );
  if (header < 0)
    throw new HotelRateImportError(
      "A header row containing Date and Room Type is required.",
    );
  const headers = raw[header].map((value) => String(value ?? "").trim());
  const required = [
    "Date",
    "Room Type",
    "Rate (Gross)",
    "Availability",
    "Total Rooms Available",
  ];
  if (
    required.some(
      (name) => headers.filter((value) => value === name).length !== 1,
    )
  )
    throw new HotelRateImportError(
      "Map one column for each required rate-report field.",
    );
  const rows: HotelRateRow[] = [];
  const identities = new Set<string>();
  for (let i = header + 1; i < raw.length; i++) {
    if (raw[i].every((value) => value == null || value === "")) continue;
    const field = (name: string) => raw[i][headers.indexOf(name)];
    const row = i + 1;
    const day = hotelImportDay(
      field("Date"),
      Boolean(workbook.Workbook?.WBProps?.date1904),
    );
    const name =
      typeof field("Room Type") === "string"
        ? String(field("Room Type")).trim()
        : "";
    if (!day || !name || name.length > 255)
      throw new HotelRateImportError(
        "A valid calendar date and room type are required.",
        400,
        row,
      );
    const number = (name: string) =>
      field(name) == null || field(name) === "" ? NaN : Number(field(name));
    const rate = number("Rate (Gross)"),
      availability = number("Availability"),
      total = number("Total Rooms Available");
    if (
      !Number.isFinite(rate) ||
      rate < 0 ||
      rate > 99_999_999.99 ||
      !Number.isSafeInteger(availability) ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      total > 100_000 ||
      availability < 0 ||
      availability > total
    )
      throw new HotelRateImportError(
        "Rate must be non-negative; room counts must be whole numbers with availability no greater than total.",
        400,
        row,
      );
    const identity = JSON.stringify([name, day]);
    if (identities.has(identity))
      throw new HotelRateImportError(
        "The same room and date appears more than once.",
        400,
        row,
      );
    identities.add(identity);
    rows.push({ row, day, name, rate, availability, total });
    if (rows.length > 10_000)
      throw new HotelRateImportError(
        "Rate imports are limited to 10,000 rows.",
      );
  }
  if (!rows.length)
    throw new HotelRateImportError("The rate report contains no data rows.");
  return rows;
}
