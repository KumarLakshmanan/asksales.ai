import { describe, expect, it, jest } from '@jest/globals';

/** Volume tiers and the monthly statement maths (no database). */
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: jest.fn() } }));
const { tieredCost, monthBounds } = await import('../services/whatsapp/WhatsAppBillingStatement.js');
const { parseRateTiersCsv } = await import('../services/whatsapp/WhatsAppRateCardImport.js');

describe('incremental volume-tier cost', () => {
  const tiers = [
    { volumeFrom: 0, volumeTo: 750_000, rate: 0.115 },
    { volumeFrom: 750_000, volumeTo: 2_000_000, rate: 0.1 },
    { volumeFrom: 2_000_000, volumeTo: null, rate: 0.08 },
  ];

  it('charges each message at the rate of the tier it falls in', () => {
    expect(tieredCost(100, tiers)).toBeCloseTo(11.5);
    expect(tieredCost(750_000, tiers)).toBeCloseTo(86_250);
    expect(tieredCost(750_001, tiers)).toBeCloseTo(86_250.1);
    expect(tieredCost(3_000_000, tiers)).toBeCloseTo(750_000 * 0.115 + 1_250_000 * 0.1 + 1_000_000 * 0.08);
  });

  it('is 0 for no messages or no tiers, and ignores tier order', () => {
    expect(tieredCost(0, tiers)).toBe(0);
    expect(tieredCost(10, [])).toBe(0);
    expect(tieredCost(800_000, [...tiers].reverse())).toBeCloseTo(tieredCost(800_000, tiers));
  });
});

describe('volume-tier CSV import', () => {
  it("reads Meta's LOWER:UPPER tiers and turns A+1 starts into the previous end", () => {
    const result = parseRateTiersCsv([
      'Volume tiers for utility and authentication (INR)',
      'Market,Category,Tier,Rate',
      'India,Utility,0:750000,₹0.1150',
      'India,Utility,750001:2000000,₹0.1000',
      'India,Utility,2000001:MAX,₹0.0800',
      'India,Authentication,0:MAX,₹0.1150',
      'India,Marketing,0:MAX,₹0.8631',
    ].join('\n'));
    expect(result.rows).toEqual([
      { market: 'India', category: 'utility', volumeFrom: 0, volumeTo: 750000, rate: 0.115 },
      { market: 'India', category: 'utility', volumeFrom: 750000, volumeTo: 2000000, rate: 0.1 },
      { market: 'India', category: 'utility', volumeFrom: 2000000, volumeTo: null, rate: 0.08 },
      { market: 'India', category: 'authentication', volumeFrom: 0, volumeTo: null, rate: 0.115 },
    ]);
    expect(result.warnings).toEqual([expect.stringContaining('only utility and authentication have volume tiers')]);
  });

  it('accepts From/To columns and ranges like "1,000 - 5,000" and "5,000+"', () => {
    const fromTo = parseRateTiersCsv('Country,Category,From,To,Price\nBrazil,utility,0,1000,0.05\nBrazil,utility,1000,,0.04');
    expect(fromTo.rows.map(row => [row.volumeFrom, row.volumeTo])).toEqual([[0, 1000], [1000, null]]);
    const ranges = parseRateTiersCsv('Market,Category,Volume range,Rate\nUAE,utility,"0 - 5,000",0.2\nUAE,utility,"5,000+",0.15');
    expect(ranges.rows.map(row => [row.volumeFrom, row.volumeTo, row.rate])).toEqual([[0, 5000, 0.2], [5000, null, 0.15]]);
    const openEnded = parseRateTiersCsv('Market,Category,Tier,Rate\nIndia,Utility,0:750000,0.115\nIndia,Utility,750001:,0.1');
    expect(openEnded.rows.map(row => [row.volumeFrom, row.volumeTo])).toEqual([[0, 750000], [750000, null]]);
    expect(openEnded.warnings).toEqual([]);
    expect(parseRateTiersCsv('Market,Category,Tier,Rate\nIndia,Utility,750000,0.1').rows).toEqual([]);
  });

  it('warns about gaps, duplicates, a missing header and unusable lines', () => {
    const gaps = parseRateTiersCsv('Market,Category,Tier,Rate\nIndia,Utility,10:100,0.1\nIndia,Utility,500:MAX,0.09\nIndia,Utility,oops,0.1');
    expect(gaps.warnings.join(' ')).toMatch(/doesn't follow on/);
    expect(gaps.warnings.join(' ')).toMatch(/should start at 0/);
    expect(gaps.warnings.join(' ')).toMatch(/Line 4: India utility needs a volume range and a rate/);
    expect(parseRateTiersCsv('a,b\n1,2').warnings).toEqual(['No header row with a "Market" column was found.']);
    expect(parseRateTiersCsv('Market,Rate\nIndia,1').warnings[0]).toMatch(/needs Market, Category, Rate and a Tier/);
  });
});

describe('statement months', () => {
  it('turns YYYY-MM into the month and the next one, and rejects anything else', () => {
    expect(monthBounds('2026-11')).toEqual({ start: '2026-11-01', end: '2026-12-01' });
    expect(monthBounds('2026-12')).toEqual({ start: '2026-12-01', end: '2027-01-01' });
    expect(() => monthBounds('2026-13')).toThrow('Choose a month');
    expect(() => monthBounds('Nov 2026')).toThrow('Choose a month');
  });
});
