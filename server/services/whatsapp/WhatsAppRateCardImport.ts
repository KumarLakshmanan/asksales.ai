/**
 * Parse the CSVs an administrator uploads for WhatsApp platform billing.
 *
 * Rate cards accept either layout:
 *   - wide, like Meta's list-rate CSV: a header row with a market column and one
 *     column per category ("Marketing", "Utility", "Authentication", "Service"),
 *     possibly after a few title lines. Other columns (for example
 *     "Authentication-International" or "Currency") are ignored.
 *   - long: market, category, rate.
 * Markets accept: calling code, market (for example "91,India" or "+1-242,Rest of Latin America").
 *
 * Parsing never writes anything: the admin page shows the preview and warnings
 * and the administrator confirms before rates are saved.
 */
import { WHATSAPP_CATEGORIES, type WhatsAppCategory } from './WhatsAppBillingService.js';

export interface ParsedRate { market: string; category: WhatsAppCategory; rate: number }
/** volumeFrom: messages already counted this month before this tier starts (0 for the first tier). */
export interface ParsedTier { market: string; category: 'utility' | 'authentication'; volumeFrom: number; volumeTo: number | null; rate: number }
export interface ParsedMarket { callingCode: string; market: string }
export interface ParseResult<T> { rows: T[]; warnings: string[] }

/** RFC 4180-style line splitting: quoted fields may contain commas, quotes and newlines. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === '\t' || ch === ';') { row.push(field.trim()); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some(cell => cell !== '')) out.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field.trim());
  if (row.some(cell => cell !== '')) out.push(row);
  return out;
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z]/g, '');

/** "₹0.8631", "$0.0107", "0,86" (decimal comma), "1,234.5" -> number; blank / "n/a" -> null. */
export function parseRate(raw: string): number | null {
  let value = String(raw ?? '').trim();
  if (!value || /^(n\/?a|-|—|none|null)$/i.test(value)) return null;
  value = value.replace(/[^0-9.,-]/g, '');
  if (/^\d+,\d+$/.test(value)) value = value.replace(',', '.');
  else value = value.replace(/,/g, '');
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function categoryOf(header: string): WhatsAppCategory | null {
  const key = normalize(header);
  if (key.startsWith('authenticationinternational') || key.startsWith('authint') || key.includes('marketinglite')) return null;
  for (const category of WHATSAPP_CATEGORIES) if (key === category || key.startsWith(category)) return category;
  return null;
}

const isMarketHeader = (cell: string) => ['market', 'country', 'region', 'marketname', 'countryregion'].includes(normalize(cell));

export function parseRateCardCsv(text: string): ParseResult<ParsedRate> {
  const table = parseCsv(text);
  const warnings: string[] = [];
  const rows: ParsedRate[] = [];
  const headerIndex = table.findIndex(cells => cells.some(isMarketHeader));
  if (headerIndex < 0) return { rows, warnings: ['No header row with a "Market" column was found.'] };
  const header = table[headerIndex];
  const marketCol = header.findIndex(isMarketHeader);
  const categoryCol = header.findIndex(cell => normalize(cell) === 'category');
  const rateCol = header.findIndex(cell => ['rate', 'price', 'listrate'].includes(normalize(cell)));
  const seen = new Set<string>();
  const add = (market: string, category: WhatsAppCategory, rate: number | null, line: number) => {
    if (!market) return;
    if (rate === null) { warnings.push(`Line ${line}: no ${category} rate for ${market}; skipped.`); return; }
    const key = `${market.toLowerCase()}|${category}`;
    if (seen.has(key)) { warnings.push(`Line ${line}: ${market} ${category} appears twice; the first value was kept.`); return; }
    seen.add(key);
    rows.push({ market, category, rate });
  };

  if (categoryCol >= 0 && rateCol >= 0) {
    table.slice(headerIndex + 1).forEach((cells, offset) => {
      const line = headerIndex + offset + 2;
      const category = categoryOf(cells[categoryCol] || '');
      if (!category) { if (cells[categoryCol]) warnings.push(`Line ${line}: category "${cells[categoryCol]}" is not billed by this app; skipped.`); return; }
      add(cells[marketCol] || '', category, parseRate(cells[rateCol] || ''), line);
    });
  } else {
    const columns = header.map((cell, index) => ({ index, category: categoryOf(cell) })).filter(col => col.category) as Array<{ index: number; category: WhatsAppCategory }>;
    if (!columns.length) return { rows, warnings: ['The header has no Marketing, Utility, Authentication or Service column.'] };
    for (const missing of WHATSAPP_CATEGORIES.filter(category => !columns.some(col => col.category === category))) {
      warnings.push(`No ${missing} column; ${missing} rates were not imported.`);
    }
    table.slice(headerIndex + 1).forEach((cells, offset) => {
      const market = cells[marketCol] || '';
      if (!market || /^(market|country)$/i.test(market)) return;
      for (const col of columns) add(market, col.category, parseRate(cells[col.index] || ''), headerIndex + offset + 2);
    });
  }
  if (!rows.length) warnings.push('No rates were found below the header row.');
  return { rows, warnings };
}

const volume = (raw: string): number | null => {
  const value = String(raw ?? '').trim();
  if (/^(max|∞|infinity|and above|\+|)$/i.test(value)) return null;
  const digits = value.replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
};

/** "0:750000", "750,001 - 2,000,000", "25,000,001+", "0:MAX", "2000001:" -> [from, to|null]. */
function tierRange(raw: string): [number, number | null] | null {
  const value = String(raw ?? '').trim();
  const plus = value.match(/^([\d,.\s]+)\s*(?:\+|and above|or more)$/i);
  if (plus) return [volume(plus[1]) ?? 0, null];
  // Keep an empty upper bound: "2000001:" is an open-ended last tier.
  const parts = value.split(/\s*(?::|–|—|-|to)\s*/i);
  if (parts.length !== 2 || !parts[0]) return null;
  const from = volume(parts[0]);
  if (from === null) return null;
  return [from, volume(parts[1])];
}

const tieredCategory = (raw: string): ParsedTier['category'] | null => {
  const key = normalize(raw);
  if (key.startsWith('authenticationinternational') || key.startsWith('authint')) return null;
  if (key.startsWith('utility')) return 'utility';
  if (key.startsWith('authentication')) return 'authentication';
  return null;
};

/**
 * Meta's "Volume tiers for utility and authentication" CSV, or a simple file
 * with: market, category, a tier range ("0:750000", "750001-2000000") or
 * separate from/to columns, and the rate. Meta numbers a tier's first message
 * (A+1), so a tier that starts one after the previous tier's end is stored as
 * starting after it.
 */
export function parseRateTiersCsv(text: string): ParseResult<ParsedTier> {
  const table = parseCsv(text);
  const warnings: string[] = [];
  const rows: ParsedTier[] = [];
  const headerIndex = table.findIndex(cells => cells.some(isMarketHeader));
  if (headerIndex < 0) return { rows, warnings: ['No header row with a "Market" column was found.'] };
  const header = table[headerIndex].map(normalize);
  const marketCol = table[headerIndex].findIndex(isMarketHeader);
  const categoryCol = header.findIndex(cell => cell === 'category' || cell === 'pricingcategory');
  const tierCol = header.findIndex(cell => ['tier', 'tiers', 'volumetier', 'range', 'volume', 'volumerange', 'monthlyvolume'].includes(cell));
  const fromCol = header.findIndex(cell => ['from', 'start', 'lower', 'min', 'volumefrom', 'tierstart', 'lowerbound'].includes(cell));
  const toCol = header.findIndex(cell => ['to', 'end', 'upper', 'max', 'volumeto', 'tierend', 'upperbound'].includes(cell));
  const rateCol = header.findIndex(cell => ['rate', 'price', 'tierrate', 'listrate'].includes(cell));
  if (categoryCol < 0 || rateCol < 0 || (tierCol < 0 && fromCol < 0)) {
    return { rows, warnings: ['The header needs Market, Category, Rate and a Tier (or From and To) column.'] };
  }
  table.slice(headerIndex + 1).forEach((cells, offset) => {
    const line = headerIndex + offset + 2;
    const market = cells[marketCol] || '';
    if (!market) return;
    const category = tieredCategory(cells[categoryCol] || '');
    if (!category) {
      if (cells[categoryCol]) warnings.push(`Line ${line}: only utility and authentication have volume tiers; "${cells[categoryCol]}" skipped.`);
      return;
    }
    const range = tierCol >= 0 ? tierRange(cells[tierCol] || '') : (() => {
      const from = volume(cells[fromCol] || '');
      return from === null ? null : [from, toCol >= 0 ? volume(cells[toCol] || '') : null] as [number, number | null];
    })();
    const rate = parseRate(cells[rateCol] || '');
    if (!range || rate === null) { warnings.push(`Line ${line}: ${market} ${category} needs a volume range and a rate; skipped.`); return; }
    if (range[1] !== null && range[1] < range[0]) { warnings.push(`Line ${line}: ${market} ${category} tier ends before it starts; skipped.`); return; }
    rows.push({ market, category, volumeFrom: range[0], volumeTo: range[1], rate });
  });

  // Per market and category: order, convert A+1 starts, and check the tiers join up.
  const groups = new Map<string, ParsedTier[]>();
  for (const row of rows) {
    const key = `${row.market.toLowerCase()}|${row.category}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const clean: ParsedTier[] = [];
  for (const tiers of groups.values()) {
    tiers.sort((a, b) => a.volumeFrom - b.volumeFrom);
    let previous: ParsedTier | null = null;
    for (const tier of tiers) {
      if (previous && previous.volumeTo !== null && tier.volumeFrom === previous.volumeTo + 1) tier.volumeFrom = previous.volumeTo;
      if (previous && tier.volumeFrom === previous.volumeFrom) {
        warnings.push(`${tier.market} ${tier.category}: two tiers start at ${tier.volumeFrom.toLocaleString('en-US')}; the first was kept.`);
        continue;
      }
      if (previous && (previous.volumeTo === null || previous.volumeTo !== tier.volumeFrom)) {
        warnings.push(`${tier.market} ${tier.category}: the tier from ${tier.volumeFrom.toLocaleString('en-US')} doesn't follow on from the previous one. Check the file.`);
      }
      clean.push(tier);
      previous = tier;
    }
    if (tiers[0] && tiers[0].volumeFrom !== 0) warnings.push(`${tiers[0].market} ${tiers[0].category}: the first tier should start at 0.`);
  }
  if (!clean.length) warnings.push('No tiers were found below the header row.');
  return { rows: clean, warnings };
}

export function parseMarketsCsv(text: string): ParseResult<ParsedMarket> {
  const table = parseCsv(text);
  const warnings: string[] = [];
  const rows: ParsedMarket[] = [];
  const seen = new Map<string, string>();
  table.forEach((cells, index) => {
    const line = index + 1;
    const codeCell = cells.find(cell => /^\+?\d[\d\s-]{0,10}$/.test(cell));
    const marketCell = cells.find(cell => cell !== codeCell && /[a-z]/i.test(cell));
    if (!codeCell || !marketCell) {
      if (index > 0 || !cells.some(cell => /code|market|country/i.test(cell))) warnings.push(`Line ${line}: needs a calling code and a market name; skipped.`);
      return;
    }
    const callingCode = codeCell.replace(/\D/g, '');
    if (callingCode.length < 1 || callingCode.length > 8) { warnings.push(`Line ${line}: calling code "${codeCell}" is not valid; skipped.`); return; }
    if (seen.has(callingCode) && seen.get(callingCode) !== marketCell) {
      warnings.push(`Line ${line}: +${callingCode} is listed for both ${seen.get(callingCode)} and ${marketCell}; the first was kept.`);
      return;
    }
    if (seen.has(callingCode)) return;
    seen.set(callingCode, marketCell);
    rows.push({ callingCode, market: marketCell });
  });
  if (!rows.length) warnings.push('No calling codes were found.');
  return { rows, warnings };
}
