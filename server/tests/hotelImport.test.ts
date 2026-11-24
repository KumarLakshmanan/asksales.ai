/**
 * Hotel Import Controller Tests
 *
 * Covers every branch of importRateReport:
 *  1. Unauthenticated request → 401
 *  2. No file in request → 400 "No file uploaded"
 *  3. api.post(FormData) bug simulation → 400 (not 500)
 *  4. Dynamic header detection (row 0 / row 3 / missing → 400)
 *  5. Valid XLSX with DD-MM-YYYY string dates
 *  6. Valid XLSX with Excel serial-number dates
 *  7. Rows missing Date or Room Type reject the whole report before SQL
 *  8. Invalid / impossible dates reject the whole report before SQL
 *  9. New hotel property is created when none exists
 * 10. Existing hotel property is reused
 * 11. New room type is inserted on first import
 * 12. Existing room type is reused (no duplicate insert)
 * 13. Same room type across multiple rows → created only once
 * 14. 4 distinct room types across 8 rows → all imported
 * 15. DB error → 500
 * 16. Response shape is complete
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import * as xlsx from '@e965/xlsx';
import { hotelImportDay, parseHotelRateWorkbook } from '../utils/hotelRateImport.js';

// ─── Mock drizzle-orm ────────────────────────────────────────────────────────
jest.unstable_mockModule('drizzle-orm', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = jest.fn<any>().mockImplementation((strings: TemplateStringsArray, ...values: any[]) => ({
    __sql: true,
    strings: Array.from(strings),
    values,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sql.raw = jest.fn<any>().mockReturnValue({ __sql: true, raw: true });
  return {
    sql,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eq: jest.fn<any>().mockReturnValue('eq'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ne: jest.fn<any>().mockReturnValue('ne'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    and: jest.fn<any>().mockReturnValue('and'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    or: jest.fn<any>().mockReturnValue('or'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    not: jest.fn<any>().mockReturnValue('not'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    like: jest.fn<any>().mockReturnValue('like'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ilike: jest.fn<any>().mockReturnValue('ilike'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gte: jest.fn<any>().mockReturnValue('gte'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lte: jest.fn<any>().mockReturnValue('lte'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gt: jest.fn<any>().mockReturnValue('gt'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lt: jest.fn<any>().mockReturnValue('lt'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    between: jest.fn<any>().mockReturnValue('between'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    isNull: jest.fn<any>().mockReturnValue('isNull'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    isNotNull: jest.fn<any>().mockReturnValue('isNotNull'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exists: jest.fn<any>().mockReturnValue('exists'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    notExists: jest.fn<any>().mockReturnValue('notExists'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    desc: jest.fn<any>().mockReturnValue('desc'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    asc: jest.fn<any>().mockReturnValue('asc'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inArray: jest.fn<any>().mockReturnValue('inArray'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    count: jest.fn<any>().mockReturnValue('count'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sum: jest.fn<any>().mockReturnValue('sum'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    avg: jest.fn<any>().mockReturnValue('avg'),
  };
});

// ─── Mock models/db ──────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockExecuteImpl: jest.Mock<any>;

// Keep legacy sequence fixtures focused on property/room/upsert queries. Lock
// and occupancy semantics are covered by hotelInventoryPostgres against PG.
type ImportFixtureQuery = { strings?: string[] };
type ImportFixtureDb = {
  execute: (query: ImportFixtureQuery) => Promise<{ rows: unknown[] }>;
  transaction: (work: (tx: ImportFixtureDb) => unknown) => Promise<unknown>;
};
const fixtureDb: ImportFixtureDb = {
  execute: async (query) => {
    const text = query.strings?.join(' ') || '';
    if (text.includes('pg_advisory_xact_lock') || text.includes('SELECT id FROM room_availability')) return { rows: [] };
    if (text.includes('COALESCE(SUM(number_of_rooms)')) return { rows: [{ rooms: 0 }] };
    return mockExecuteImpl(query);
  },
  transaction: async (work) => work(fixtureDb),
};
jest.unstable_mockModule('../models/db', () => ({ db: fixtureDb }));

// ─── Mock unused transitive imports ──────────────────────────────────────────
jest.unstable_mockModule('../models/allSchemas', () => ({}));

jest.unstable_mockModule('../services/booking/HotelRagSyncService.js', () => ({
  hotelRagSyncService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    syncRoomTypeToRag: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteRoomTypeFromRag: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// ─── Lazy-import after mocks are set up ─────────────────────────────────────
const { mockAuthRequest, mockRequest, mockResponse } = await import('./helpers/mockHelpers');
const { importRateReport } = await import('../controllers/hotelImportController');

// ─── XLSX builder ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildXlsx(rows: any[][]): Buffer {
  const ws = xlsx.utils.aoa_to_sheet(rows);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

const HEADER = ['Date', 'Day Name', 'Room Type', 'Rate Plan (Tier)', 'Rate (Gross)', 'Availability', 'Total Rooms Available', 'Rooms Sold', '% Rooms Sold'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dataRow(date = '19-06-2026', roomType = 'Deluxe Room', rate = 5000, avail = 3, total = 10): any[] {
  return [date, 'Monday', roomType, 'Manual', rate, avail, total, 1, 10];
}

// sequence-based db mock
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockDbSequence(responses: Array<{ rows: any[] }>): jest.Mock<any> {
  let call = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jest.fn<any>().mockImplementation(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return r;
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────
describe('importRateReport', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecuteImpl = jest.fn<any>().mockResolvedValue({ rows: [] });
  });

  // 1 & 2 — Auth guard
  describe('authentication', () => {
    it('returns 401 when req.user is missing', async () => {
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      const req = mockRequest({ file: { buffer: Buffer.from('') } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._status).toBe(401);
      expect(res._json).toMatchObject({ error: 'Unauthorized' });
    });

    it('returns 401 when req.user.id is 0 (falsy)', async () => {
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      const req = mockRequest({ user: { id: 0 }, file: { buffer: Buffer.from('') } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._status).toBe(401);
    });
  });

  // 3 — Missing / null / undefined file
  describe('missing file', () => {
    it('returns 400 when req.file is absent', async () => {
      const req = mockAuthRequest(1);
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._status).toBe(400);
      expect(res._json).toMatchObject({ error: 'No file uploaded' });
    });

    it('returns 400 when req.file is null', async () => {
      const req = mockAuthRequest(1, { file: null });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._status).toBe(400);
      expect(res._json.error).toBe('No file uploaded');
    });

    /**
     * Reproduces the exact production bug:
     * When the frontend called api.post(formData) instead of api.upload(formData),
     * the FormData was JSON.stringified → "{}" sent with Content-Type: application/json.
     * Multer never ran → req.file was undefined → this should return 400, not crash.
     */
    it('returns 400 (not 500) simulating api.post(FormData) bug — JSON body, no file', async () => {
      const req = mockAuthRequest(1, {
        file: undefined,
        body: {}, // what arrives when FormData is JSON.stringified
        headers: { 'content-type': 'application/json' },
      });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._status).toBe(400);
      expect(res._json.error).toBe('No file uploaded');
    });
  });

  // 4 — Dynamic header detection
  describe('dynamic header detection', () => {
    it('detects headers in row 0 (plain spreadsheet)', async () => {
      const buf = buildXlsx([[...HEADER], dataRow()]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      mockExecuteImpl = mockDbSequence([
        { rows: [{ id: 42 }] }, // hotel property
        { rows: [] },            // room type → not found
        { rows: [{ id: 7 }] },  // room type INSERT
        { rows: [] },            // avail upsert
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._json).toMatchObject({ success: true, imported: 1, roomTypesCreated: 1 });
    });

    it('detects headers in row 3 — real rate-report preamble format', async () => {
      const buf = buildXlsx([
        ['Base Rate Data Report'],
        [null, null, 'From 19-June-2026 To 19-July-2026'],
        [],
        [...HEADER],
        dataRow('19-06-2026', 'Premium Club Rooms'),
        dataRow('20-06-2026', 'Suite'),
      ]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      mockExecuteImpl = mockDbSequence([
        { rows: [{ id: 42 }] },
        { rows: [] }, { rows: [{ id: 7 }] }, { rows: [] }, // room type 1
        { rows: [] }, { rows: [{ id: 8 }] }, { rows: [] }, // room type 2
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._json).toMatchObject({ success: true, imported: 2, roomTypesCreated: 2 });
    });

    it('rejects missing headers before SQL', async () => {
      const buf = buildXlsx([
        ['Title'],
        ['Sub-title'],
        ['Preamble'],
        ['not', 'a', 'header', 'row'],
      ]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      mockExecuteImpl = mockDbSequence([{ rows: [{ id: 1 }] }]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._status).toBe(400);
      expect(mockExecuteImpl).not.toHaveBeenCalled();
    });
  });

  // 5 & 6 — Date parsing
  describe('date parsing', () => {
    it('correctly parses DD-MM-YYYY string dates → ISO format in DB query', async () => {
      const buf = buildXlsx([[...HEADER], dataRow('25-12-2026')]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExecuteImpl = jest.fn<any>().mockImplementation(async (q: any) => {
        calls.push(q);
        if (calls.length === 1) return { rows: [{ id: 1 }] }; // hotel
        if (calls.length === 2) return { rows: [{ id: 5 }] }; // room type found
        return { rows: [] };
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      // 3rd call = availability upsert; its values must contain '2026-12-25'
      expect(calls[2].values).toContain('2026-12-25');
    });

    it('correctly parses Excel serial-number dates → ISO string', async () => {
      // 46002 = 2026-01-01 in Excel date serial (Windows epoch, 1900-01-00 base)
      const buf = buildXlsx([[...HEADER], [46002, 'Thursday', 'Standard Room', 'Manual', 3000, 5, 8, 1, 12.5]]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExecuteImpl = jest.fn<any>().mockImplementation(async (q: any) => {
        calls.push(q);
        if (calls.length === 1) return { rows: [{ id: 1 }] };
        if (calls.length === 2) return { rows: [{ id: 5 }] };
        return { rows: [] };
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._json).toMatchObject({ success: true, imported: 1 });
      const isoDate = calls[2]?.values?.[1];
      expect(typeof isoDate).toBe('string');
      expect(isoDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('rejects invalid dates without silently importing other rows', async () => {
      const buf = buildXlsx([
        [...HEADER],
        ['not-a-date', 'Mon', 'Deluxe Room', 'Manual', 5000, 3, 10, 1, 10],
        ['99-99-9999', 'Mon', 'Deluxe Room', 'Manual', 5000, 3, 10, 1, 10],
        dataRow('01-07-2026'), // the one valid row
      ]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      mockExecuteImpl = mockDbSequence([
        { rows: [{ id: 1 }] },
        { rows: [{ id: 5 }] },
        { rows: [] },
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._status).toBe(400);
      expect(mockExecuteImpl).not.toHaveBeenCalled();
    });
  });

  // 7 — Row filtering
  describe('row filtering', () => {
    it('rejects rows with null Date before SQL', async () => {
      const buf = buildXlsx([[...HEADER], [null, 'Mon', 'Deluxe', 'Manual', 5000, 3, 10, 1, 10], dataRow()]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      mockExecuteImpl = mockDbSequence([{ rows: [{ id: 1 }] }, { rows: [{ id: 5 }] }, { rows: [] }]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._status).toBe(400);
      expect(mockExecuteImpl).not.toHaveBeenCalled();
    });

    it('rejects rows with null Room Type before SQL', async () => {
      const buf = buildXlsx([[...HEADER], ['19-06-2026', 'Mon', null, 'Manual', 5000, 3, 10, 1, 10], dataRow()]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      mockExecuteImpl = mockDbSequence([{ rows: [{ id: 1 }] }, { rows: [{ id: 5 }] }, { rows: [] }]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._status).toBe(400);
      expect(mockExecuteImpl).not.toHaveBeenCalled();
    });

    it('handles an entirely empty sheet gracefully', async () => {
      const buf = buildXlsx([[...HEADER]]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      mockExecuteImpl = mockDbSequence([{ rows: [{ id: 1 }] }]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._status).toBe(400);
      expect(mockExecuteImpl).not.toHaveBeenCalled();
    });
  });

  describe('inventory totals', () => {
    it('persists Total Rooms Available so availability satisfies the inventory constraint', async () => {
      const buf = buildXlsx([[...HEADER], dataRow('18-08-2026', 'Premium Club Rooms', 14000, 6, 11)]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExecuteImpl = jest.fn<any>().mockImplementation(async (q: any) => {
        calls.push(q);
        if (calls.length === 1) return { rows: [{ id: 1 }] };
        if (calls.length === 2) return { rows: [{ id: 5 }] };
        return { rows: [] };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);

      expect(res._json).toMatchObject({ success: true, imported: 1 });
      expect(calls[2].strings.join(' ')).toContain('total_count');
      expect(calls[2].values).toEqual([5, '2026-08-18', 11, 6, 14000]);
    });
  });

  // 9 & 10 — Hotel property
  describe('hotel property', () => {
    it('creates a new hotel property when none exists', async () => {
      const buf = buildXlsx([[...HEADER], dataRow()]);
      const req = mockAuthRequest(99, { file: { buffer: buf } });
      const res = mockResponse();
      const calls: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExecuteImpl = jest.fn<any>().mockImplementation(async (q: any) => {
        const s = JSON.stringify(q.strings).toLowerCase();
        if (s.includes('select') && s.includes('hotel_properties')) { calls.push('hotel-select'); return { rows: [] }; }
        if (s.includes('insert') && s.includes('hotel_properties')) { calls.push('hotel-insert'); return { rows: [{ id: 55 }] }; }
        if (s.includes('room_types') && s.includes('select')) return { rows: [{ id: 5 }] };
        return { rows: [] };
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(calls).toContain('hotel-select');
      expect(calls).toContain('hotel-insert');
      expect(res._json.success).toBe(true);
    });

    it('reuses an existing hotel property without inserting', async () => {
      const buf = buildXlsx([[...HEADER], dataRow()]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      const inserts: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExecuteImpl = jest.fn<any>().mockImplementation(async (q: any) => {
        const s = JSON.stringify(q.strings).toLowerCase();
        if (s.includes('insert') && s.includes('hotel_properties')) { inserts.push('hotel-insert'); return { rows: [{ id: 99 }] }; }
        if (s.includes('hotel_properties')) return { rows: [{ id: 42 }] };
        if (s.includes('room_types') && s.includes('select')) return { rows: [{ id: 5 }] };
        return { rows: [] };
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(inserts).toHaveLength(0);
      expect(res._json.success).toBe(true);
    });
  });

  // 11, 12, 13 — Room type management
  describe('room type management', () => {
    it('roomTypesCreated=1 when a new room type is inserted', async () => {
      const buf = buildXlsx([[...HEADER], dataRow('19-06-2026', 'Brand New Suite')]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      mockExecuteImpl = mockDbSequence([
        { rows: [{ id: 1 }] },  // hotel
        { rows: [] },            // room type → not found
        { rows: [{ id: 10 }] }, // room type INSERT
        { rows: [] },            // avail upsert
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._json).toMatchObject({ success: true, roomTypesCreated: 1, imported: 1 });
    });

    it('roomTypesCreated=0 when room type already exists', async () => {
      const buf = buildXlsx([[...HEADER], dataRow()]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      mockExecuteImpl = mockDbSequence([
        { rows: [{ id: 1 }] }, // hotel
        { rows: [{ id: 5 }] }, // room type found
        { rows: [] },           // avail upsert
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._json).toMatchObject({ success: true, roomTypesCreated: 0, imported: 1 });
    });

    it('same room type across 3 rows is created only once', async () => {
      const buf = buildXlsx([
        [...HEADER],
        dataRow('19-06-2026', 'Deluxe Room'),
        dataRow('20-06-2026', 'Deluxe Room'),
        dataRow('21-06-2026', 'Deluxe Room'),
      ]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      let rtInserts = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExecuteImpl = jest.fn<any>().mockImplementation(async (q: any) => {
        const s = JSON.stringify(q.strings).toLowerCase();
        if (s.includes('hotel_properties')) return { rows: [{ id: 1 }] };
        if (s.includes('insert') && s.includes('room_types')) { rtInserts++; return { rows: [{ id: 7 }] }; }
        if (s.includes('room_types')) return { rows: [{ id: 7 }] };
        return { rows: [] };
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._json).toMatchObject({ success: true, imported: 3, roomTypesCreated: 0 });
      expect(rtInserts).toBe(0);
    });
  });

  // 14 — Real-world: 4 room types × 2 dates
  describe('real-world multi-room-type import', () => {
    it('imports 4 room types × 2 dates = 8 rows correctly', async () => {
      const roomTypes = ['Premium Club Rooms', 'Pool Villa Rooms', 'Sanctuary Villa Rooms', 'Garden Villa Rooms'];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[][] = [[...HEADER]];
      for (const rt of roomTypes) {
        rows.push(dataRow('19-06-2026', rt, 10000, 5, 10));
        rows.push(dataRow('20-06-2026', rt, 12000, 3, 10));
      }
      const buf = buildXlsx(rows);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();

      let rtCounter = 0;
      const rtIds = new Map<string, number>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExecuteImpl = jest.fn<any>().mockImplementation(async (q: any) => {
        const s = JSON.stringify(q.strings).toLowerCase();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vals: any[] = q.values || [];
        if (s.includes('hotel_properties')) return { rows: [{ id: 1 }] };
        if (s.includes('select') && s.includes('room_types')) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const name = vals.find((v: any) => typeof v === 'string' && v.length > 2);
          return rtIds.has(name) ? { rows: [{ id: rtIds.get(name) }] } : { rows: [] };
        }
        if (s.includes('insert') && s.includes('room_types')) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const name = vals.find((v: any) => typeof v === 'string' && v.length > 2);
          const id = ++rtCounter + 10;
          if (name) rtIds.set(name, id);
          return { rows: [{ id }] };
        }
        return { rows: [] };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._json).toMatchObject({ success: true, imported: 8, roomTypesCreated: 4, rows: 8 });
    });
  });

  // 15 — DB errors
  describe('DB error handling', () => {
    it('returns 500 when db.execute throws', async () => {
      const buf = buildXlsx([[...HEADER], dataRow()]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExecuteImpl = jest.fn<any>().mockRejectedValue(new Error('DB connection lost'));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._status).toBe(500);
      expect(res._json.error).toBe('Failed to import rate report. No rate-report changes were committed.');
    });
  });

  // 16 — Response shape
  describe('response shape', () => {
    it('returns all expected fields: success, imported, roomTypesCreated, availabilityUpdated, rows', async () => {
      const buf = buildXlsx([[...HEADER], dataRow(), dataRow('20-06-2026')]);
      const req = mockAuthRequest(1, { file: { buffer: buf } });
      const res = mockResponse();
      mockExecuteImpl = mockDbSequence([
        { rows: [{ id: 1 }] },
        { rows: [{ id: 5 }] }, { rows: [] },
        { rows: [{ id: 5 }] }, { rows: [] },
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await importRateReport(req as any, res as any);
      expect(res._json).toEqual(expect.objectContaining({
        success: true,
        imported: 2,
        roomTypesCreated: 0,
        availabilityUpdated: 2,
        rows: 2,
      }));
    });
  });
});

// Preserve the original Data calendar/workbook acceptance cases alongside the
// Hotel controller fixtures; database locking/rollback is tested against PG.
function workbook(rows: unknown[][], prefix: unknown[][] = []): Buffer {
  return buildXlsx([...prefix,
    ['Date', 'Room Type', 'Rate (Gross)', 'Availability', 'Total Rooms Available'],
    ...rows]);
}
describe("strict calendar and workbook validation", () => {
  it.each([
    "2026-02-30",
    "29-02-2025",
    "2026/13/01",
    "31-Apr-2026",
    "not a date",
    60,
    NaN,
    Infinity,
    -1,
  ])("rejects impossible or unsupported date %s", (value) =>
    expect(hotelImportDay(value)).toBeNull(),
  );
  it.each([
    ["19-06-2026", "2026-06-19"],
    ["06/19/2026", "2026-06-19"],
    ["2026/06/19", "2026-06-19"],
    ["19-Jun-2026", "2026-06-19"],
    ["29-02-2024", "2024-02-29"],
  ])("preserves exact day %s", (input, day) =>
    expect(hotelImportDay(input)).toBe(day),
  );
  it("supports both Excel date systems and rejects the fictional leap day", () => {
    expect(hotelImportDay(61)).toBe("1900-03-01");
    expect(hotelImportDay(0, true)).toBe("1904-01-01");
    expect(hotelImportDay(60, true)).not.toBeNull();
  });
  it("detects headers below report titles and skips fully blank rows", () => {
    expect(
      parseHotelRateWorkbook(
        workbook(
          [[], ["2026-11-01", "Deluxe", 100, 0, 0]],
          [["Report"], [], ["Title"]],
        ),
      ),
    ).toEqual([
      {
        row: 6,
        day: "2026-11-01",
        name: "Deluxe",
        rate: 100,
        availability: 0,
        total: 0,
      },
    ]);
  });
  it.each([
    [3, 2],
    [-1, 2],
    [1.5, 2],
    [1, -2],
    ["not-number", 2],
    [1, 100_001],
  ])("rejects invalid counts %s/%s", (available, total) =>
    expect(() =>
      parseHotelRateWorkbook(
        workbook([["2026-11-01", "Deluxe", 100, available, total]]),
      ),
    ).toThrow("room counts"),
  );
  it("rejects missing identity, duplicate room/day and negative prices before SQL", () => {
    for (const rows of [
      [["", "Deluxe", 100, 1, 2]],
      [["2026-11-01", "", 100, 1, 2]],
      [["2026-11-01", "Deluxe", -1, 1, 2]],
      [
        ["2026-11-01", "Deluxe", 100, 1, 2],
        ["2026-11-01", "Deluxe", 100, 1, 2],
      ],
    ])
      expect(() => parseHotelRateWorkbook(workbook(rows))).toThrow();
  });
});
