import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';

/**
 * Extracted brand style data from HTML/CSS — deterministic, no LLM needed.
 */
export interface BrandStyleData {
  /** Ordered color palette by frequency (most used first) */
  colorPalette: string[];
  /** Best guess primary brand color */
  primaryColor: string | null;
  /** Best guess secondary brand color */
  secondaryColor: string | null;
  /** Accent color (third most used) */
  accentColor: string | null;
  /** Meta theme-color from HTML head */
  themeColor: string | null;
  /** Font families detected: heading, body, accent */
  fonts: {
    heading: string | null;
    body: string | null;
    accent: string | null;
  };
  /** All unique font families discovered, ordered by frequency */
  fontFamilies: string[];
  /** Font sizes found (px values only, sorted ascending) */
  fontSizes: string[];
  /** Font weights found (numeric or keyword, sorted ascending) */
  fontWeights: string[];
  /** CSS gradients found on the site */
  gradients: string[];
  /** Background colors detected */
  backgroundColors: string[];
  /** Logo URL extracted from meta/img tags */
  logoUrl: string | null;
}

// Colors to ignore (too generic, near-black/white/gray)
const IGNORED_COLORS = new Set([
  '#000000', '#ffffff', '#333333', '#222222', '#111111',
  '#666666', '#777777', '#888888', '#999999', '#aaaaaa',
  '#bbbbbb', '#cccccc', '#dddddd', '#eeeeee', '#f5f5f5',
  '#fafafa', '#f0f0f0', '#e5e5e5', '#d4d4d4', '#a3a3a3',
  '#737373', '#525252', '#404040', '#262626', '#171717',
  '#f9fafb', '#f3f4f6', '#e5e7eb', '#d1d5db', '#9ca3af',
  '#6b7280', '#4b5563', '#374151', '#1f2937', '#111827',
]);

// Generic/system fonts to skip
const SYSTEM_FONTS = new Set([
  'inherit', 'initial', 'unset', 'revert', 'serif', 'sans-serif',
  'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif',
  'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-apple-system',
  'blinkmacsystemfont', 'segoe ui', 'arial', 'helvetica',
  'times new roman', 'times', 'courier new', 'courier',
  'verdana', 'georgia', 'tahoma', 'trebuchet ms', 'impact',
]);

const FONT_WEIGHT_MAP: Record<string, string> = {
  'thin': '100', 'hairline': '100',
  'extralight': '200', 'ultralight': '200',
  'light': '300',
  'normal': '400', 'regular': '400',
  'medium': '500',
  'semibold': '600', 'demibold': '600',
  'bold': '700',
  'extrabold': '800', 'ultrabold': '800',
  'black': '900', 'heavy': '900',
};

/**
 * Extracts brand visual style data directly from HTML/CSS without LLM calls.
 * Accepts multiple HTML pages to build a comprehensive style profile.
 */
export function extractBrandStyles(
  htmlPages: Array<{ html: string; url: string; isHomepage?: boolean }>,
): BrandStyleData {
  const colorFreq = new Map<string, number>();
  const bgColorFreq = new Map<string, number>();
  const fontFreq = new Map<string, number>();
  const headingFonts = new Map<string, number>();
  const bodyFonts = new Map<string, number>();
  const fontSizeSet = new Set<string>();
  const fontWeightSet = new Set<string>();
  const gradientSet = new Set<string>();
  let themeColor: string | null = null;
  let logoUrl: string | null = null;

  for (const page of htmlPages) {
    try {
      const $ = cheerio.load(page.html);

      // ── Theme color (from homepage only, or first found) ──
      if (!themeColor) {
        themeColor = $('meta[name="theme-color"]').attr('content') || null;
        if (themeColor && !/^#[0-9a-fA-F]{6}$/i.test(themeColor)) {
          themeColor = normalizeColor(themeColor);
        }
      }

      // ── Logo extraction (from homepage preferably) ──
      if (!logoUrl || page.isHomepage) {
        const found =
          $('meta[property="og:logo"]').attr('content') ||
          $('img[src*="logo"]').first().attr('src') ||
          $('img[alt*="logo" i]').first().attr('src') ||
          $('link[rel="apple-touch-icon"]').attr('href') ||
          null;
        if (found) {
          try {
            logoUrl = found.startsWith('http') ? found : new URL(found, page.url).toString();
          } catch { /* skip invalid URL */ }
        }
      }

      // ── Collect all CSS text (inline styles + <style> blocks) ──
      const allCss: string[] = [];

      // <style> blocks
      $('style').each((_, el) => { allCss.push($(el).text()); });

      // Inline style attributes
      $('[style]').each((_, el) => { allCss.push($(el).attr('style') || ''); });

      // Also try to capture <link rel="stylesheet"> content if inline
      // (We can't fetch external stylesheets, but we can parse what's in the HTML)

      const cssText = allCss.join('\n');

      // ── Extract colors ──
      extractColors(cssText, colorFreq, bgColorFreq);

      // ── Extract colors from CSS custom properties / :root ──
      extractCssVariableColors($, cssText, colorFreq);

      // ── Extract fonts ──
      extractFonts(cssText, fontFreq, headingFonts, bodyFonts);

      // ── Extract font sizes ──
      extractFontSizes(cssText, fontSizeSet);

      // ── Extract font weights ──
      extractFontWeights(cssText, fontWeightSet);

      // ── Extract gradients ──
      extractGradients(cssText, gradientSet);

      // ── Extract fonts from computed heading/body elements ──
      extractElementFonts($, headingFonts, bodyFonts);

    } catch (err) {
      logger.warn({ err, url: page.url }, '[BrandStyleExtractor] Error processing page');
    }
  }

  // ── Build results ──
  const sortedColors = [...colorFreq.entries()]
    .filter(([c]) => !IGNORED_COLORS.has(c))
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c);

  const sortedBgColors = [...bgColorFreq.entries()]
    .filter(([c]) => !IGNORED_COLORS.has(c))
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c);

  const sortedFontFamilies = [...fontFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);

  const topHeadingFont = [...headingFonts.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const topBodyFont = [...bodyFonts.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Accent font = third most common font that isn't heading or body
  const accentFont = sortedFontFamilies
    .find(f => f !== topHeadingFont && f !== topBodyFont) || null;

  // Use theme-color as primary if available, else most frequent brand color
  const primary = (themeColor && isValidHex(themeColor))
    ? themeColor
    : sortedColors[0] || null;

  // Secondary = next color that has enough contrast from primary
  const secondary = sortedColors.find(c => c !== primary && hasMinContrast(primary, c, 30)) || sortedColors[1] || null;
  const accent = sortedColors.find(c => c !== primary && c !== secondary) || null;

  // Sort font sizes numerically
  const fontSizes = [...fontSizeSet]
    .sort((a, b) => parseFloat(a) - parseFloat(b));

  // Sort font weights numerically
  const fontWeights = [...fontWeightSet]
    .sort((a, b) => parseInt(a) - parseInt(b));

  return {
    colorPalette: sortedColors.slice(0, 12),
    primaryColor: primary,
    secondaryColor: secondary,
    accentColor: accent,
    themeColor,
    fonts: {
      heading: topHeadingFont,
      body: topBodyFont,
      accent: accentFont,
    },
    fontFamilies: sortedFontFamilies.slice(0, 8),
    fontSizes,
    fontWeights,
    gradients: [...gradientSet].slice(0, 6),
    backgroundColors: sortedBgColors.slice(0, 6),
    logoUrl,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function extractColors(css: string, colorFreq: Map<string, number>, bgColorFreq: Map<string, number>): void {
  // Hex colors (6-digit)
  const hexMatches = css.match(/#[0-9a-fA-F]{6}\b/g) || [];
  for (const raw of hexMatches) {
    const c = raw.toLowerCase();
    colorFreq.set(c, (colorFreq.get(c) || 0) + 1);
  }

  // Hex colors (3-digit, expand to 6)
  const hex3Matches = css.match(/#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/g) || [];
  for (const raw of hex3Matches) {
    const expanded = `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
    colorFreq.set(expanded, (colorFreq.get(expanded) || 0) + 1);
  }

  // rgb/rgba colors
  const rgbMatches = css.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)/g) || [];
  for (const raw of rgbMatches) {
    const hex = rgbToHex(raw);
    if (hex) {
      colorFreq.set(hex, (colorFreq.get(hex) || 0) + 1);
    }
  }

  // Background colors specifically
  const bgMatches = css.match(/background(?:-color)?:\s*([^;{}\n]+)/gi) || [];
  for (const match of bgMatches) {
    const value = match.replace(/background(?:-color)?:\s*/i, '').trim();
    // Skip gradients (handled separately)
    if (value.includes('gradient')) continue;
    const hex = value.startsWith('#') ? normalizeColor(value) : rgbToHex(value);
    if (hex && !IGNORED_COLORS.has(hex)) {
      bgColorFreq.set(hex, (bgColorFreq.get(hex) || 0) + 1);
    }
  }
}

function extractCssVariableColors(
  $: cheerio.CheerioAPI,
  css: string,
  colorFreq: Map<string, number>,
): void {
  // Match CSS custom properties that look like colors in :root or * selectors
  const varColorMatches = css.match(/--[\w-]+:\s*#[0-9a-fA-F]{3,6}\b/g) || [];
  for (const match of varColorMatches) {
    const hexMatch = match.match(/#[0-9a-fA-F]{6}\b/) || match.match(/#[0-9a-fA-F]{3}\b/);
    if (hexMatch) {
      const c = normalizeColor(hexMatch[0]);
      if (c) colorFreq.set(c, (colorFreq.get(c) || 0) + 2); // Boost CSS variable colors
    }
  }
}

function extractFonts(
  css: string,
  fontFreq: Map<string, number>,
  headingFonts: Map<string, number>,
  bodyFonts: Map<string, number>,
): void {
  // ── Build a CSS variable → value map for resolving var() references ──
  const cssVarMap = new Map<string, string>();
  const varDeclRegex = /(--[\w-]+)\s*:\s*([^;}\n]+)/g;
  let varMatch;
  while ((varMatch = varDeclRegex.exec(css)) !== null) {
    const varName = varMatch[1].trim();
    const varValue = varMatch[2].trim();
    // Only store non-variable values (avoid circular refs)
    if (!varValue.startsWith('var(')) {
      cssVarMap.set(varName, varValue);
    }
  }

  // font-family declarations
  const ffMatches = css.match(/font-family:\s*([^;{}\n]+)/gi) || [];
  for (const match of ffMatches) {
    const value = match.replace(/font-family:\s*/i, '').trim();
    const resolved = resolveCssVars(value, cssVarMap);
    const families = parseFontFamilyList(resolved);
    for (const f of families) {
      fontFreq.set(f, (fontFreq.get(f) || 0) + 1);
    }
  }

  // Detect heading vs body context
  // Heading context: selectors containing h1-h6, .heading, .title, .hero
  const headingContextRegex = /(?:h[1-6]|\.heading|\.title|\.hero)[^{]*\{[^}]*font-family:\s*([^;}\n]+)/gi;
  let hm;
  while ((hm = headingContextRegex.exec(css)) !== null) {
    for (const f of parseFontFamilyList(resolveCssVars(hm[1], cssVarMap))) {
      headingFonts.set(f, (headingFonts.get(f) || 0) + 1);
    }
  }

  // Body context: selectors containing body, p, .text, .body, .content, html
  const bodyContextRegex = /(?:body|html|\bp\b|\.text|\.body|\.content)[^{]*\{[^}]*font-family:\s*([^;}\n]+)/gi;
  let bm;
  while ((bm = bodyContextRegex.exec(css)) !== null) {
    for (const f of parseFontFamilyList(resolveCssVars(bm[1], cssVarMap))) {
      bodyFonts.set(f, (bodyFonts.get(f) || 0) + 1);
    }
  }
}

function extractElementFonts(
  $: cheerio.CheerioAPI,
  headingFonts: Map<string, number>,
  bodyFonts: Map<string, number>,
): void {
  // Build CSS variable map from :root/<style> blocks for inline var() resolution
  const cssVarMap = new Map<string, string>();
  $('style').each((_, el) => {
    const text = $(el).text();
    const varDeclRegex = /(--[\w-]+)\s*:\s*([^;}\n]+)/g;
    let m;
    while ((m = varDeclRegex.exec(text)) !== null) {
      const varName = m[1].trim();
      const varValue = m[2].trim();
      if (!varValue.startsWith('var(')) {
        cssVarMap.set(varName, varValue);
      }
    }
  });

  // Check inline font-family on heading elements
  $('h1, h2, h3').each((_, el) => {
    const style = $(el).attr('style') || '';
    const ffMatch = style.match(/font-family:\s*([^;]+)/i);
    if (ffMatch) {
      for (const f of parseFontFamilyList(resolveCssVars(ffMatch[1], cssVarMap))) {
        headingFonts.set(f, (headingFonts.get(f) || 0) + 1);
      }
    }
  });

  // Check inline font-family on body/paragraph elements
  $('body, p').each((_, el) => {
    const style = $(el).attr('style') || '';
    const ffMatch = style.match(/font-family:\s*([^;]+)/i);
    if (ffMatch) {
      for (const f of parseFontFamilyList(resolveCssVars(ffMatch[1], cssVarMap))) {
        bodyFonts.set(f, (bodyFonts.get(f) || 0) + 1);
      }
    }
  });

  // Check Google Fonts <link> tags
  $('link[href*="fonts.googleapis.com"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    // Extract family names from Google Fonts URLs
    const familyMatch = href.match(/family=([^&]+)/);
    if (familyMatch) {
      const families = decodeURIComponent(familyMatch[1]).split('|');
      for (const raw of families) {
        const name = raw.split(':')[0].replace(/\+/g, ' ').trim();
        if (name && !SYSTEM_FONTS.has(name.toLowerCase())) {
          // Google Fonts get a frequency boost
          const freq = headingFonts.get(name) || bodyFonts.get(name) || 0;
          if (freq === 0) {
            // If not already categorized, add to general fonts
            bodyFonts.set(name, 1);
          }
        }
      }
    }
  });
}

function extractFontSizes(css: string, fontSizeSet: Set<string>): void {
  const matches = css.match(/font-size:\s*([^;{}\n]+)/gi) || [];
  for (const match of matches) {
    const value = match.replace(/font-size:\s*/i, '').trim();
    // Only capture px and rem values
    const numMatch = value.match(/^([\d.]+)(px|rem)$/);
    if (numMatch) {
      fontSizeSet.add(`${numMatch[1]}${numMatch[2]}`);
    }
  }
}

function extractFontWeights(css: string, fontWeightSet: Set<string>): void {
  const matches = css.match(/font-weight:\s*([^;{}\n]+)/gi) || [];
  for (const match of matches) {
    const value = match.replace(/font-weight:\s*/i, '').trim().toLowerCase();
    const numeric = FONT_WEIGHT_MAP[value] || value;
    if (/^\d{3}$/.test(numeric)) {
      fontWeightSet.add(numeric);
    }
  }
}

function extractGradients(css: string, gradientSet: Set<string>): void {
  // Match linear-gradient(...) and radial-gradient(...)
  const gradientRegex = /(?:linear|radial|conic)-gradient\([^)]+\)/gi;
  const matches = css.match(gradientRegex) || [];
  for (const g of matches) {
    // Normalize whitespace
    const normalized = g.replace(/\s+/g, ' ').trim();
    if (normalized.length < 200) { // Skip ridiculously long ones
      gradientSet.add(normalized);
    }
  }
}

function parseFontFamilyList(raw: string): string[] {
  return raw
    .split(',')
    .map(f => f.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(f =>
      f.length > 0 &&
      !SYSTEM_FONTS.has(f.toLowerCase()) &&
      !f.startsWith('var(') // Filter out unresolved CSS variable references
    );
}

/** Resolve var(--name) references in a CSS value using the collected variable map */
function resolveCssVars(value: string, varMap: Map<string, string>): string {
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_match, varName, fallback) => {
    const resolved = varMap.get(varName);
    if (resolved) return resolved;
    if (fallback) return fallback.trim();
    return _match; // Return original if can't resolve
  });
}

function normalizeColor(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  return rgbToHex(trimmed);
}

function rgbToHex(rgb: string): string | null {
  const m = rgb.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return null;
  const [, r, g, b] = m.map(Number);
  const hex = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  return hex.toLowerCase();
}

function isValidHex(c: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(c);
}

/** Simple hue-based contrast check to avoid picking two very similar colors */
function hasMinContrast(hex1: string | null, hex2: string, minDelta: number): boolean {
  if (!hex1) return true;
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  const diff = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
  return diff >= minDelta;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
